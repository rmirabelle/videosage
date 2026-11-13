//! Preview copies, for video files that the webview's player cannot play.
use crate::media::{quiet_command, tool};
use serde::Serialize;
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager};

/// One copy is made at a time: each FFmpeg run already uses all processor cores.
static MAKING: Mutex<()> = Mutex::new(());

/// How far a preview copy is, for the media list.
#[derive(Clone, Serialize)]
struct ProxyProgress {
    path: String,
    /// From 0 to 1.
    fraction: f64,
}

/** The cache file name for the preview copy of a file: it changes when the file changes. */
fn proxy_key(file: &Path) -> Result<String, String> {
    let metadata = file.metadata().map_err(|error| format!("Could not read the file: {error}"))?;
    let mut key = DefaultHasher::new();
    "proxy-h264-720-v1".hash(&mut key);
    file.hash(&mut key);
    metadata.len().hash(&mut key);
    metadata.modified().ok().hash(&mut key);
    Ok(format!("{:016x}.mp4", key.finish()))
}

/** Reads the time that FFmpeg has done, in seconds, from a line of its "-progress" output. */
fn progress_seconds(line: &str) -> Option<f64> {
    let microseconds = line.trim().strip_prefix("out_time_us=")?.parse::<f64>().ok()?;
    (microseconds >= 0.0).then_some(microseconds / 1_000_000.0)
}

/**
 * Makes the preview copy with FFmpeg: H.264 at 720 lines or less with AAC
 * sound, and a key frame each half second so the preview can seek fast.
 * The export never reads this copy; it reads the original file.
 */
fn transcode(app: &AppHandle, ffmpeg: &Path, source: &Path, output: &Path, duration_sec: f64) -> Result<(), String> {
    let mut child = quiet_command(ffmpeg)
        .args(["-v", "error", "-nostats", "-y", "-i"])
        .arg(source)
        .args(["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"])
        .args(["-vf", "scale=-2:'min(720,ih)'", "-pix_fmt", "yuv420p"])
        .args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-g", "15"])
        .args(["-c:a", "aac", "-b:a", "160k", "-ac", "2"])
        .args(["-movflags", "+faststart", "-progress", "pipe:1", "-f", "mp4"])
        .arg(output)
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
    let path = source.to_string_lossy().into_owned();
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(seconds) = progress_seconds(&line) {
            let fraction = if duration_sec > 0.0 { (seconds / duration_sec).clamp(0.0, 1.0) } else { 0.0 };
            let _ = app.emit("proxy-progress", ProxyProgress { path: path.clone(), fraction });
        }
    }
    let status = child.wait().map_err(|error| format!("FFmpeg stopped: {error}"))?;
    let errors = errors.join().unwrap_or_default();
    if !status.success() {
        let lines: Vec<&str> = errors.lines().filter(|line| !line.trim().is_empty()).collect();
        return Err(lines[lines.len().saturating_sub(2)..].join(" "));
    }
    Ok(())
}

/**
 * Gives the path of the preview copy of a video file, and makes the copy
 * first if the cache does not have it. While FFmpeg works, the
 * "proxy-progress" event tells how far it is.
 */
#[tauri::command]
pub async fn make_proxy(app: AppHandle, path: String, duration_sec: f64) -> Result<String, String> {
    let ffmpeg = tool(&app, "ffmpeg.exe")?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("proxies");
    tauri::async_runtime::spawn_blocking(move || {
        let source = PathBuf::from(&path);
        if !source.is_file() {
            return Err("The file was not found.".to_string());
        }
        std::fs::create_dir_all(&cache).map_err(|error| format!("Could not make the cache folder: {error}"))?;
        let output = cache.join(proxy_key(&source)?);
        let _guard = MAKING.lock().map_err(|_| "The preview copy maker is not available.")?;
        if !output.is_file() {
            /* FFmpeg writes a part file first, so a stopped run leaves no broken copy. */
            let partial = output.with_extension("part");
            if let Err(error) = transcode(&app, &ffmpeg, &source, &partial, duration_sec) {
                let _ = std::fs::remove_file(&partial);
                return Err(format!("Could not make a preview copy. {error}"));
            }
            std::fs::rename(&partial, &output).map_err(|error| format!("Could not save the preview copy: {error}"))?;
        }
        Ok(output.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_time_from_progress_lines() {
        assert_eq!(progress_seconds("out_time_us=2500000"), Some(2.5));
        assert_eq!(progress_seconds("out_time_us=N/A"), None);
        assert_eq!(progress_seconds("out_time_us=-9223372036854775808"), None);
        assert_eq!(progress_seconds("frame=12"), None);
    }
}
