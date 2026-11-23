//! Exports the timeline to one MP4 file with FFmpeg.
use crate::media::{quiet_command, tool};
use serde::Deserialize;
use std::{
    ffi::OsString,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};

/// The FFmpeg run of the export that is in progress. One export runs at a time.
static RUNNING: Mutex<Option<Child>> = Mutex::new(None);
/// True while an export is in progress, from its start to its end.
static BUSY: AtomicBool = AtomicBool::new(false);
/// True after the user stopped the export.
static CANCELLED: AtomicBool = AtomicBool::new(false);

/// The error text of an export that the user stopped. The page knows this text.
const CANCELLED_TEXT: &str = "cancelled";

/// Windows permits about 32,000 characters in one command.
const COMMAND_LIMIT: usize = 30_000;

/** One part of a layer, in the sequence of the timeline: a part of a video file, or a gap. */
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    /// The video file; none for a gap, which has no sound and shows the layers under it (black on layer 0).
    pub path: Option<String>,
    /// Where the part starts in the video file, in seconds.
    pub start_sec: f64,
    /// The length of the part, in frames of the exported video.
    pub frames: u64,
    pub has_sound: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub output: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// "standard" or "high".
    pub quality: String,
    /// The layers from the bottom up. Each layer is as long as the timeline.
    pub layers: Vec<Vec<Segment>>,
}

impl ExportRequest {
    /** All segments of all layers, from the bottom layer up. The inputs of FFmpeg are in this sequence. */
    fn segments(&self) -> impl Iterator<Item = &Segment> {
        self.layers.iter().flatten()
    }

    /** The length of the export, in frames: the longest layer. */
    fn frames(&self) -> u64 {
        self.layers.iter().map(|layer| layer.iter().map(|segment| segment.frames).sum::<u64>()).max().unwrap_or(0)
    }
}

/** A frame rate as FFmpeg text. The TV rates (29.97 and so on) are written as exact fractions. */
fn rate_text(fps: f64) -> String {
    for base in [24.0, 30.0, 48.0, 60.0, 120.0] {
        if (fps - base * 1000.0 / 1001.0).abs() < 0.01 {
            return format!("{}/1001", base as u32 * 1000);
        }
    }
    if (fps - fps.round()).abs() < 0.0005 {
        format!("{}", fps.round() as u32)
    } else {
        format!("{fps:.3}")
    }
}

/**
 * The FFmpeg filter graph of the export. Each segment becomes one video
 * stream and one sound stream with the same exact length, and "concat" puts
 * the segments of a layer one after the other. A clip is scaled into the
 * frame and gets the frame rate of the export. If a file ends too early, its
 * last frame holds and its sound is silent, so later clips stay in their
 * places. On layer 0 the bars around a clip and the gaps are black. On a
 * higher layer they are transparent, and the layer goes over the layers
 * under it; the sound of all layers is mixed.
 */
fn build_graph(request: &ExportRequest) -> String {
    let (width, height) = (request.width, request.height);
    let rate = rate_text(request.fps);
    let mut parts = Vec::new();
    let mut input = 0;
    let mut index = 0;
    let single = request.layers.len() == 1;
    for (layer, segments) in request.layers.iter().enumerate() {
        /* A higher layer keeps an alpha channel, so its gaps and bars show the layers under it. */
        let (format, fill) = if layer == 0 { ("yuv420p", "black") } else { ("yuva420p", "black@0") };
        let mut labels = String::new();
        for segment in segments {
            let frames = segment.frames;
            let seconds = frames as f64 / request.fps;
            let silence = format!("anullsrc=r=48000:cl=stereo,atrim=end={seconds:.6},aformat=sample_fmts=fltp[a{index}]");
            if segment.path.is_some() {
                let pad = if layer == 0 {
                    format!("pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p")
                } else {
                    format!("format=yuva420p,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:{fill},setsar=1")
                };
                parts.push(format!(
                    "[{input}:v:0]fps={rate},scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,\
                     {pad},tpad=stop_mode=clone:stop=-1,trim=end_frame={frames},setpts=PTS-STARTPTS[v{index}]"
                ));
                if segment.has_sound {
                    parts.push(format!(
                        "[{input}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,\
                         apad,atrim=end={seconds:.6},asetpts=PTS-STARTPTS[a{index}]"
                    ));
                } else {
                    parts.push(silence);
                }
                input += 1;
            } else {
                parts.push(format!("color=c={fill}:s={width}x{height}:r={rate},format={format},setsar=1,trim=end_frame={frames}[v{index}]"));
                parts.push(silence);
            }
            labels.push_str(&format!("[v{index}][a{index}]"));
            index += 1;
        }
        let (video, sound) = if single { ("v".to_string(), "a".to_string()) } else { (format!("lv{layer}"), format!("la{layer}")) };
        parts.push(format!("{labels}concat=n={}:v=1:a=1[{video}][{sound}]", segments.len()));
    }
    if !single {
        let mut below = "lv0".to_string();
        for layer in 1..request.layers.len() {
            let out = if layer + 1 == request.layers.len() { "over".to_string() } else { format!("o{layer}") };
            parts.push(format!("[{below}][lv{layer}]overlay=format=auto:eof_action=pass[{out}]"));
            below = out;
        }
        parts.push("[over]format=yuv420p[v]".into());
        let sounds: String = (0..request.layers.len()).map(|layer| format!("[la{layer}]")).collect();
        parts.push(format!("{sounds}amix=inputs={}:normalize=0:duration=longest[a]", request.layers.len()));
    }
    parts.join(";\n")
}

/** The encoder settings for a quality: the graphics card (NVIDIA) or the processor. */
fn encoder_args(quality: &str, fps: f64, gpu: bool) -> Result<Vec<String>, String> {
    let (preset, crf, quantizer) = match quality {
        "standard" => ("medium", "20", "25"),
        "high" => ("slow", "16", "20"),
        _ => return Err(format!("Unknown video quality: {quality}")),
    };
    /* A key frame each 2 seconds. */
    let key_frames = ((fps * 2.0).round() as u32).max(1).to_string();
    let mut args: Vec<String> = ["-c:v", if gpu { "h264_nvenc" } else { "libx264" }, "-g", &key_frames, "-pix_fmt", "yuv420p"].map(String::from).to_vec();
    if gpu {
        args.extend(["-preset", "p5", "-tune", "hq", "-rc", "constqp", "-qp", quantizer].map(String::from));
    } else {
        args.extend(["-preset", preset, "-crf", crf].map(String::from));
    }
    Ok(args)
}

/** Whether this PC's graphics card can encode with "args" at this size: FFmpeg encodes two black frames, and the result is thrown away. */
fn gpu_can_encode(ffmpeg: &Path, request: &ExportRequest, args: &[String]) -> bool {
    let source = format!("color=black:size={}x{}:rate={}", request.width, request.height, rate_text(request.fps));
    quiet_command(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", &source, "-frames:v", "2"])
        .args(args)
        .args(["-f", "null", "-"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/** The full FFmpeg command: one input for each clip segment, the filter graph from a file, and the encoders. */
fn build_args(request: &ExportRequest, graph_file: &Path, encoder: &[String], output: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-v", "error", "-nostats", "-y"].map(OsString::from).to_vec();
    for segment in request.segments() {
        let Some(path) = &segment.path else { continue };
        /* FFmpeg reads one second more than the segment, and the graph cuts the exact length. */
        let seconds = segment.frames as f64 / request.fps + 1.0;
        args.extend(["-ss".into(), format!("{:.6}", segment.start_sec.max(0.0)).into(), "-t".into(), format!("{seconds:.6}").into(), "-i".into(), path.into()]);
    }
    args.extend(["-/filter_complex".into(), graph_file.into(), "-map".into(), "[v]".into(), "-map".into(), "[a]".into()]);
    args.extend(encoder.iter().map(OsString::from));
    args.extend(["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-progress", "pipe:1", "-f", "mp4"].map(OsString::from));
    args.push(output.into());
    args
}

/** Reads the time that FFmpeg has done, in seconds, from a line of its "-progress" output. */
fn progress_seconds(line: &str) -> Option<f64> {
    let microseconds = line.trim().strip_prefix("out_time_us=")?.parse::<f64>().ok()?;
    (microseconds >= 0.0).then_some(microseconds / 1_000_000.0)
}

fn check(request: &ExportRequest) -> Result<(), String> {
    if request.layers.is_empty() || request.segments().all(|segment| segment.frames == 0) {
        return Err("The timeline is empty.".into());
    }
    if request.width < 2 || request.height < 2 || request.width % 2 != 0 || request.height % 2 != 0 {
        return Err("The video size must be even numbers.".into());
    }
    if !(request.fps.is_finite() && (1.0..=240.0).contains(&request.fps)) {
        return Err("The frame rate is not correct.".into());
    }
    for path in request.segments().filter_map(|segment| segment.path.as_deref()) {
        if !Path::new(path).is_file() {
            return Err(format!("The video file was not found: {path}"));
        }
        if path.eq_ignore_ascii_case(&request.output) {
            return Err("The export cannot write over a video file that the timeline uses. Give the export a different name.".into());
        }
    }
    Ok(())
}

/** Runs FFmpeg one time. Gives the error text of FFmpeg when it fails. */
fn run_ffmpeg(ffmpeg: &Path, args: &[OsString], total_sec: f64, progress: &dyn Fn(f64)) -> Result<(), String> {
    if args.iter().map(|arg| arg.len() + 3).sum::<usize>() > COMMAND_LIMIT {
        return Err("The timeline has too many clips for one export. Join clips, or export the timeline in parts.".into());
    }
    let mut child = quiet_command(ffmpeg)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start FFmpeg: {error}"))?;
    /* The error output is read on its own thread, so a long error text cannot block FFmpeg. */
    let mut stderr = child.stderr.take().ok_or("FFmpeg gave no error output")?;
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    let stdout = child.stdout.take().ok_or("FFmpeg gave no progress output")?;
    *RUNNING.lock().map_err(|_| "The export is not available.")? = Some(child);
    /* The user can stop the export before FFmpeg starts; then FFmpeg stops here. */
    if CANCELLED.load(Ordering::SeqCst) {
        stop_running();
    }
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(seconds) = progress_seconds(&line) {
            progress((seconds / total_sec).clamp(0.0, 1.0));
        }
    }
    let child = RUNNING.lock().map_err(|_| "The export is not available.")?.take();
    let status = child.ok_or("FFmpeg is gone")?.wait().map_err(|error| format!("FFmpeg stopped: {error}"))?;
    let errors = errors.join().unwrap_or_default();
    if status.success() {
        return Ok(());
    }
    let lines: Vec<&str> = errors.lines().filter(|line| !line.trim().is_empty()).collect();
    Err(lines[lines.len().saturating_sub(3)..].join(" "))
}

fn stop_running() {
    if let Ok(mut running) = RUNNING.lock() {
        if let Some(child) = running.as_mut() {
            let _ = child.kill();
        }
    }
}

/**
 * Exports the timeline. FFmpeg writes a part file, which gets the name of
 * the output when the export is complete, so a stopped export leaves no
 * broken video. The graphics card encodes if it can; if it cannot, or if it
 * fails, the processor encodes.
 */
pub fn run_export(ffmpeg: &Path, request: &ExportRequest, work_folder: &Path, progress: &dyn Fn(f64)) -> Result<(), String> {
    check(request)?;
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("An export is in progress.".into());
    }
    CANCELLED.store(false, Ordering::SeqCst);
    let result = export_parts(ffmpeg, request, work_folder, progress);
    BUSY.store(false, Ordering::SeqCst);
    result
}

fn export_parts(ffmpeg: &Path, request: &ExportRequest, work_folder: &Path, progress: &dyn Fn(f64)) -> Result<(), String> {
    let graph_file = work_folder.join("export-graph.txt");
    std::fs::write(&graph_file, build_graph(request)).map_err(|error| format!("Could not write the export settings: {error}"))?;
    let output = PathBuf::from(&request.output);
    let mut part = output.as_os_str().to_owned();
    part.push(".part");
    let part = PathBuf::from(part);
    let total_sec = request.frames() as f64 / request.fps;

    let gpu_args = encoder_args(&request.quality, request.fps, true)?;
    let mut encoders = vec![encoder_args(&request.quality, request.fps, false)?];
    if gpu_can_encode(ffmpeg, request, &gpu_args) {
        encoders.insert(0, gpu_args);
    }
    let mut result = Err(String::new());
    for encoder in &encoders {
        if CANCELLED.load(Ordering::SeqCst) {
            break;
        }
        progress(0.0);
        result = run_ffmpeg(ffmpeg, &build_args(request, &graph_file, encoder, &part), total_sec, progress);
        if result.is_ok() {
            break;
        }
    }
    let _ = std::fs::remove_file(&graph_file);
    if CANCELLED.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&part);
        return Err(CANCELLED_TEXT.into());
    }
    if let Err(error) = result {
        let _ = std::fs::remove_file(&part);
        return Err(error);
    }
    std::fs::rename(&part, &output).map_err(|error| {
        let _ = std::fs::remove_file(&part);
        format!("Could not save the video: {error}")
    })
}

/** Exports the timeline to a video file. While FFmpeg works, the "export-progress" event tells how far it is (0 to 1). */
#[tauri::command]
pub async fn export_video(app: AppHandle, request: ExportRequest) -> Result<(), String> {
    let ffmpeg = tool(&app, "ffmpeg.exe")?;
    let work_folder = app.path().app_cache_dir().map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&work_folder).map_err(|error| format!("Could not make the cache folder: {error}"))?;
        run_export(&ffmpeg, &request, &work_folder, &|fraction| {
            let _ = app.emit("export-progress", fraction);
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/** Stops the export that is in progress. The export command then fails with the text "cancelled". */
#[tauri::command]
pub fn cancel_export() {
    CANCELLED.store(true, Ordering::SeqCst);
    stop_running();
}

/** Opens File Explorer with the file selected. */
#[tauri::command]
pub fn show_in_folder(path: String) -> Result<(), String> {
    if !Path::new(&path).is_file() {
        return Err("The file was not found.".into());
    }
    let mut command = std::process::Command::new("explorer.exe");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /* File Explorer reads its own argument format, so the quotes are written by hand. */
        command.raw_arg(format!("/select,\"{path}\""));
    }
    command.spawn().map(|_| ()).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn clip(path: &str, start_sec: f64, frames: u64, has_sound: bool) -> Segment {
        Segment { path: Some(path.into()), start_sec, frames, has_sound }
    }

    fn gap(frames: u64) -> Segment {
        Segment { path: None, start_sec: 0.0, frames, has_sound: false }
    }

    fn request(segments: Vec<Segment>) -> ExportRequest {
        layered(vec![segments])
    }

    fn layered(layers: Vec<Vec<Segment>>) -> ExportRequest {
        ExportRequest { output: "C:\\out.mp4".into(), width: 1280, height: 720, fps: 30.0, quality: "standard".into(), layers }
    }

    #[test]
    fn frame_rates_are_exact_text() {
        assert_eq!(rate_text(30.0), "30");
        assert_eq!(rate_text(29.97), "30000/1001");
        assert_eq!(rate_text(23.976), "24000/1001");
        assert_eq!(rate_text(59.94), "60000/1001");
        assert_eq!(rate_text(12.5), "12.500");
    }

    #[test]
    fn the_graph_has_one_video_and_one_sound_stream_for_each_segment() {
        let graph = build_graph(&request(vec![clip("a.mp4", 0.0, 60, true), gap(30), clip("b.mp4", 2.0, 45, false)]));
        assert!(graph.contains("[0:v:0]fps=30,"));
        assert!(graph.contains("trim=end_frame=60,setpts=PTS-STARTPTS[v0]"));
        assert!(graph.contains("[0:a:0]aresample=48000"));
        assert!(graph.contains("atrim=end=2.000000,asetpts=PTS-STARTPTS[a0]"));
        /* The gap is black and silent, and uses no input file. */
        assert!(graph.contains("color=c=black:s=1280x720:r=30,format=yuv420p,setsar=1,trim=end_frame=30[v1]"));
        assert!(graph.contains("anullsrc=r=48000:cl=stereo,atrim=end=1.000000,aformat=sample_fmts=fltp[a1]"));
        /* The second file is input 1, and it has no sound, so it gets silence. */
        assert!(graph.contains("[1:v:0]fps=30,"));
        assert!(!graph.contains("[1:a:0]"));
        assert!(graph.contains("atrim=end=1.500000,aformat=sample_fmts=fltp[a2]"));
        assert!(graph.ends_with("[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v][a]"));
    }

    #[test]
    fn a_higher_layer_goes_over_the_layer_under_it() {
        let graph = build_graph(&layered(vec![vec![clip("a.mp4", 0.0, 60, true)], vec![gap(20), clip("b.mp4", 0.0, 40, true)]]));
        /* The gap and the bars of layer 1 are transparent. */
        assert!(graph.contains("color=c=black@0:s=1280x720:r=30,format=yuva420p,setsar=1,trim=end_frame=20[v1]"));
        assert!(graph.contains("[1:v:0]fps=30,"));
        assert!(graph.contains("format=yuva420p,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black@0,setsar=1"));
        assert!(graph.contains("[v0][a0]concat=n=1:v=1:a=1[lv0][la0]"));
        assert!(graph.contains("[v1][a1][v2][a2]concat=n=2:v=1:a=1[lv1][la1]"));
        assert!(graph.contains("[lv0][lv1]overlay=format=auto:eof_action=pass[over]"));
        assert!(graph.contains("[over]format=yuv420p[v]"));
        assert!(graph.ends_with("[la0][la1]amix=inputs=2:normalize=0:duration=longest[a]"));
    }

    #[test]
    fn the_command_has_one_input_for_each_clip_segment() {
        let request = request(vec![clip("a.mp4", 1.5, 60, true), gap(30), clip("b.mp4", 0.0, 45, true)]);
        let encoder = encoder_args("standard", 30.0, false).unwrap();
        let args: Vec<String> = build_args(&request, Path::new("graph.txt"), &encoder, Path::new("out.mp4.part"))
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let text = args.join(" ");
        assert!(text.contains("-ss 1.500000 -t 3.000000 -i a.mp4 -ss 0.000000 -t 2.500000 -i b.mp4 -/filter_complex graph.txt -map [v] -map [a]"));
        assert!(text.contains("-c:v libx264 -g 60 -pix_fmt yuv420p -preset medium -crf 20"));
        assert!(text.ends_with("-f mp4 out.mp4.part"));
    }

    #[test]
    fn the_graphics_card_and_the_processor_have_their_own_settings() {
        assert!(encoder_args("high", 30.0, true).unwrap().join(" ").contains("-c:v h264_nvenc"));
        assert!(encoder_args("high", 30.0, false).unwrap().join(" ").contains("-preset slow -crf 16"));
        assert!(encoder_args("best", 30.0, false).is_err());
    }

    #[test]
    fn an_export_that_cannot_work_gives_a_message() {
        assert_eq!(check(&request(vec![gap(0)])).unwrap_err(), "The timeline is empty.");
        assert!(check(&request(vec![clip("C:\\not here.mp4", 0.0, 10, true)])).unwrap_err().starts_with("The video file was not found"));
        let mut odd = request(vec![gap(10)]);
        odd.width = 1281;
        assert!(check(&odd).is_err());
    }

    fn real(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("ffmpeg").join(name)
    }

    /** Makes a test video with a counter picture and a tone. */
    fn make_video(path: &Path, size: &str, rate: &str, seconds: &str, sound: bool) {
        let mut command = Command::new(real("ffmpeg.exe"));
        command.args(["-v", "error", "-y", "-f", "lavfi", "-i"]).arg(format!("testsrc2=size={size}:rate={rate}:duration={seconds}"));
        if sound {
            command.args(["-f", "lavfi", "-i"]).arg(format!("sine=frequency=440:duration={seconds}"));
        }
        command.args(["-c:v", "libx264", "-pix_fmt", "yuv420p"]).arg(path);
        assert!(command.status().unwrap().success());
    }

    /** Reads one fact of a stream with ffprobe. */
    fn probe(path: &Path, stream: &str, entry: &str, count: bool) -> String {
        let mut command = Command::new(real("ffprobe.exe"));
        command.args(["-v", "error", "-select_streams", stream, "-show_entries", entry, "-of", "csv=p=0"]);
        if count {
            command.arg("-count_frames");
        }
        let output = command.arg(path).output().unwrap();
        String::from_utf8_lossy(&output.stdout).trim().trim_end_matches(',').to_string()
    }

    #[test]
    #[ignore = "needs src-tauri/ffmpeg/ffmpeg.exe and ffprobe.exe"]
    fn a_real_export_has_the_exact_number_of_frames() {
        let folder = tempfile::tempdir().unwrap();
        let wide = folder.path().join("wide.mp4");
        let tall = folder.path().join("tall no sound.mp4");
        make_video(&wide, "640x360", "30", "3", true);
        make_video(&tall, "360x640", "25", "2", false);
        let output = folder.path().join("out.mp4");
        let request = ExportRequest {
            output: output.to_string_lossy().into_owned(),
            width: 640,
            height: 360,
            fps: 30.0,
            quality: "standard".into(),
            layers: vec![vec![
                gap(15),
                clip(&wide.to_string_lossy(), 1.0, 45, true),
                clip(&tall.to_string_lossy(), 0.5, 30, false),
                /* This part goes past the end of its file: the last frame holds. */
                clip(&wide.to_string_lossy(), 2.5, 30, true),
            ]],
        };
        let last = Mutex::new(0.0);
        run_export(&real("ffmpeg.exe"), &request, folder.path(), &|fraction| *last.lock().unwrap() = fraction).unwrap();
        assert!(output.is_file());
        assert!(!folder.path().join("out.mp4.part").exists());
        assert_eq!(probe(&output, "v:0", "stream=nb_read_frames", true), "120");
        assert_eq!(probe(&output, "v:0", "stream=width,height", false), "640,360");
        let sound_seconds: f64 = probe(&output, "a:0", "stream=duration", false).parse().unwrap();
        assert!((sound_seconds - 4.0).abs() < 0.05, "{sound_seconds}");
        assert!(*last.lock().unwrap() > 0.5);
    }

    #[test]
    #[ignore = "needs src-tauri/ffmpeg/ffmpeg.exe and ffprobe.exe"]
    fn a_real_export_with_two_layers_has_the_exact_number_of_frames() {
        let folder = tempfile::tempdir().unwrap();
        let wide = folder.path().join("wide.mp4");
        let tall = folder.path().join("tall.mp4");
        make_video(&wide, "640x360", "30", "3", true);
        make_video(&tall, "360x640", "25", "2", true);
        let output = folder.path().join("layers.mp4");
        let request = ExportRequest {
            output: output.to_string_lossy().into_owned(),
            width: 640,
            height: 360,
            fps: 30.0,
            quality: "standard".into(),
            layers: vec![
                vec![clip(&wide.to_string_lossy(), 0.0, 90, true)],
                vec![gap(15), clip(&tall.to_string_lossy(), 0.0, 45, true), gap(30)],
            ],
        };
        run_export(&real("ffmpeg.exe"), &request, folder.path(), &|_| {}).unwrap();
        assert_eq!(probe(&output, "v:0", "stream=nb_read_frames", true), "90");
        let sound_seconds: f64 = probe(&output, "a:0", "stream=duration", false).parse().unwrap();
        assert!((sound_seconds - 3.0).abs() < 0.05, "{sound_seconds}");
    }
}
