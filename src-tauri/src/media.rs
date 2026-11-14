//! Reads the facts of a media file with ffprobe, and makes small pictures of it with FFmpeg.
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tauri::{path::BaseDirectory, AppHandle, Manager};

/// The width of a media list picture, in pixels.
const THUMBNAIL_WIDTH: u32 = 320;
/// The largest width that a caller can ask for a picture, in pixels.
const THUMBNAIL_WIDTH_LIMIT: u32 = 1920;

/** The path of a bundled FFmpeg program ("ffmpeg.exe" or "ffprobe.exe"). */
pub fn tool(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let path = app
        .path()
        .resolve(format!("ffmpeg/{name}"), BaseDirectory::Resource)
        .map_err(|error| format!("Could not find {name}: {error}"))?;
    if !path.is_file() {
        return Err(format!("{name} is missing. Install Video Sage again."));
    }
    Ok(path)
}

/** A command that reads no input and opens no console window. */
pub fn quiet_command(program: &Path) -> Command {
    let mut command = Command::new(program);
    command.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: String,
    pub name: String,
    pub duration_sec: f64,
    pub fps: f64,
    pub width: u32,
    pub height: u32,
    pub has_sound: bool,
    pub video_codec: String,
    /// True when the app's video player can play the file as it is.
    pub playable: bool,
}

/** Reads a frame rate such as "30000/1001" or "25". */
fn parse_rate(text: &str) -> Option<f64> {
    let rate = match text.split_once('/') {
        Some((top, bottom)) => top.parse::<f64>().ok()? / bottom.parse::<f64>().ok()?,
        None => text.parse::<f64>().ok()?,
    };
    (rate.is_finite() && rate > 0.0).then_some(rate)
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn number(value: &Value, key: &str) -> Option<f64> {
    let field = value.get(key)?;
    field.as_f64().or_else(|| field.as_str()?.parse().ok())
}

/** The turn of the picture in degrees (phone videos), from the stream's display matrix or its "rotate" tag. */
fn rotation(stream: &Value) -> i64 {
    let from_side_data = stream
        .get("side_data_list")
        .and_then(Value::as_array)
        .and_then(|list| list.iter().find_map(|entry| number(entry, "rotation")));
    let from_tag = stream.get("tags").and_then(|tags| number(tags, "rotate"));
    from_side_data.or(from_tag).unwrap_or(0.0).round() as i64
}

/**
 * True when the webview's video player can play the file directly: a
 * container and a codec that it knows, with a pixel format that it decodes.
 * Other files need a preview copy.
 */
fn is_playable(path: &Path, codec: &str, pixel_format: &str) -> bool {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let container = matches!(extension.as_str(), "mp4" | "m4v" | "mov" | "webm");
    let pixels = match codec {
        "h264" => matches!(pixel_format, "yuv420p" | "yuvj420p"),
        "vp8" | "vp9" | "av1" => pixel_format.starts_with("yuv420p"),
        _ => false,
    };
    container && pixels
}

/** Makes the media facts from ffprobe's JSON output (-show_format -show_streams). */
pub fn parse_probe(json: &Value, path: &Path) -> Result<MediaInfo, String> {
    let no_streams = Vec::new();
    let streams = json.get("streams").and_then(Value::as_array).unwrap_or(&no_streams);
    /* Cover art in a music file is a video stream too; it is not a video. */
    let video = streams
        .iter()
        .find(|stream| {
            text(stream, "codec_type") == "video"
                && stream.get("disposition").and_then(|disposition| number(disposition, "attached_pic")) != Some(1.0)
        })
        .ok_or("This file has no video.")?;
    let duration_sec = json
        .get("format")
        .and_then(|format| number(format, "duration"))
        .or_else(|| number(video, "duration"))
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .ok_or("This file has no video with a length.")?;
    let fps = parse_rate(text(video, "avg_frame_rate"))
        .or_else(|| parse_rate(text(video, "r_frame_rate")))
        .unwrap_or(30.0);
    let (mut width, mut height) = (
        number(video, "width").unwrap_or(0.0) as u32,
        number(video, "height").unwrap_or(0.0) as u32,
    );
    if width == 0 || height == 0 {
        return Err("This file has no video with a size.".into());
    }
    if rotation(video).rem_euclid(180) == 90 {
        std::mem::swap(&mut width, &mut height);
    }
    let video_codec = text(video, "codec_name").to_string();
    Ok(MediaInfo {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        duration_sec,
        fps,
        width,
        height,
        has_sound: streams.iter().any(|stream| text(stream, "codec_type") == "audio"),
        playable: is_playable(path, &video_codec, text(video, "pix_fmt")),
        video_codec,
    })
}

/** The last lines of a program's error output, as a short message. */
fn error_text(output: &[u8]) -> String {
    let text = String::from_utf8_lossy(output);
    let lines: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(2)..].join(" ")
}

/** Reads the facts of one media file. The error is a message for the user. */
#[tauri::command]
pub async fn probe_media(app: AppHandle, path: String) -> Result<MediaInfo, String> {
    let ffprobe = tool(&app, "ffprobe.exe")?;
    tauri::async_runtime::spawn_blocking(move || {
        let file = PathBuf::from(&path);
        if !file.is_file() {
            return Err("The file was not found.".to_string());
        }
        let output = quiet_command(&ffprobe)
            .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
            .arg(&file)
            .output()
            .map_err(|error| format!("Could not start ffprobe: {error}"))?;
        if !output.status.success() {
            return Err(format!("This file is not a video that Video Sage can read. {}", error_text(&output.stderr)));
        }
        let json: Value = serde_json::from_slice(&output.stdout).map_err(|error| format!("ffprobe gave a result that is not correct: {error}"))?;
        parse_probe(&json, &file)
    })
    .await
    .map_err(|error| error.to_string())?
}

/** The cache file name for a picture of a media file: it changes when the file or the time changes. */
fn thumbnail_key(file: &Path, at_sec: f64, width: u32) -> Result<String, String> {
    let metadata = file.metadata().map_err(|error| format!("Could not read the file: {error}"))?;
    let mut key = DefaultHasher::new();
    "thumbnail-v1".hash(&mut key);
    file.hash(&mut key);
    metadata.len().hash(&mut key);
    metadata.modified().ok().hash(&mut key);
    at_sec.to_bits().hash(&mut key);
    /* Pictures of the usual width keep the keys that they had before a width could be given. */
    if width != THUMBNAIL_WIDTH {
        width.hash(&mut key);
    }
    Ok(format!("{:016x}.jpg", key.finish()))
}

/**
 * Gives a small JPEG picture of a media file at a time, as raw bytes. The
 * picture is kept in the app's cache folder, so FFmpeg makes it only once.
 * The width is that of the media list pictures when none is given.
 */
#[tauri::command]
pub async fn media_thumbnail(app: AppHandle, path: String, at_sec: f64, width: Option<u32>) -> Result<tauri::ipc::Response, String> {
    /* An even width, which the JPEG encoder needs. */
    let width = width.unwrap_or(THUMBNAIL_WIDTH).clamp(64, THUMBNAIL_WIDTH_LIMIT) / 2 * 2;
    let ffmpeg = tool(&app, "ffmpeg.exe")?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("thumbnails");
    tauri::async_runtime::spawn_blocking(move || {
        let file = PathBuf::from(&path);
        let at_sec = if at_sec.is_finite() { at_sec.max(0.0) } else { 0.0 };
        std::fs::create_dir_all(&cache).map_err(|error| format!("Could not make the cache folder: {error}"))?;
        let picture = cache.join(thumbnail_key(&file, at_sec, width)?);
        if !picture.is_file() {
            /* FFmpeg writes a part file first, so a stopped run leaves no broken picture. */
            let partial = picture.with_extension(format!("{}.part", std::process::id()));
            let output = quiet_command(&ffmpeg)
                .args(["-v", "error", "-y", "-ss", &format!("{at_sec:.3}"), "-i"])
                .arg(&file)
                .args(["-frames:v", "1", "-vf", &format!("scale={width}:-2"), "-q:v", "5", "-f", "mjpeg"])
                .arg(&partial)
                .output()
                .map_err(|error| format!("Could not start FFmpeg: {error}"))?;
            let made = output.status.success() && partial.metadata().is_ok_and(|metadata| metadata.len() > 0);
            if !made {
                let _ = std::fs::remove_file(&partial);
                return Err(format!("Could not make a picture of the video. {}", error_text(&output.stderr)));
            }
            std::fs::rename(&partial, &picture).map_err(|error| format!("Could not save the picture: {error}"))?;
        }
        std::fs::read(&picture)
            .map(tauri::ipc::Response::new)
            .map_err(|error| format!("Could not read the picture: {error}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn probe(extension: &str, video: Value, more: Vec<Value>) -> Result<MediaInfo, String> {
        let mut streams = vec![video];
        streams.extend(more);
        let path = format!(r"C:\Videos\Clip.{extension}");
        parse_probe(&json!({ "streams": streams, "format": { "duration": "12.500000" } }), Path::new(&path))
    }

    fn h264() -> Value {
        json!({ "codec_type": "video", "codec_name": "h264", "pix_fmt": "yuv420p", "width": 1920, "height": 1080, "avg_frame_rate": "30000/1001", "r_frame_rate": "30/1" })
    }

    #[test]
    fn reads_the_facts_of_a_video() {
        let info = probe("mp4", h264(), vec![json!({ "codec_type": "audio", "codec_name": "aac" })]).unwrap();
        assert_eq!(info.name, "Clip.mp4");
        assert_eq!(info.duration_sec, 12.5);
        assert!((info.fps - 29.97).abs() < 0.001);
        assert_eq!((info.width, info.height), (1920, 1080));
        assert!(info.has_sound);
        assert!(info.playable);
        assert_eq!(info.video_codec, "h264");
    }

    #[test]
    fn a_video_with_no_sound_stream_has_no_sound() {
        assert!(!probe("mp4", h264(), vec![]).unwrap().has_sound);
    }

    #[test]
    fn a_turned_phone_video_swaps_its_width_and_height() {
        let mut video = h264();
        video["side_data_list"] = json!([{ "side_data_type": "Display Matrix", "rotation": -90 }]);
        let info = probe("mov", video, vec![]).unwrap();
        assert_eq!((info.width, info.height), (1080, 1920));
        let mut tagged = h264();
        tagged["tags"] = json!({ "rotate": "90" });
        assert_eq!(probe("mp4", tagged, vec![]).unwrap().width, 1080);
    }

    #[test]
    fn only_files_that_the_player_knows_are_playable() {
        assert!(!probe("mkv", h264(), vec![]).unwrap().playable);
        let mut ten_bit = h264();
        ten_bit["pix_fmt"] = json!("yuv420p10le");
        assert!(!probe("mp4", ten_bit, vec![]).unwrap().playable);
        let mut hevc = h264();
        hevc["codec_name"] = json!("hevc");
        assert!(!probe("mp4", hevc, vec![]).unwrap().playable);
        let mut vp9 = h264();
        vp9["codec_name"] = json!("vp9");
        assert!(probe("webm", vp9, vec![]).unwrap().playable);
    }

    #[test]
    fn refuses_files_with_no_video() {
        let audio = json!({ "codec_type": "audio", "codec_name": "mp3" });
        assert!(probe("mp3", audio.clone(), vec![]).is_err());
        let mut cover = h264();
        cover["disposition"] = json!({ "attached_pic": 1 });
        assert!(probe("mp3", cover, vec![audio]).is_err());
        let still = parse_probe(&json!({ "streams": [h264()], "format": {} }), Path::new("picture.png"));
        assert!(still.is_err());
    }

    #[test]
    fn reads_frame_rates() {
        assert_eq!(parse_rate("25"), Some(25.0));
        assert_eq!(parse_rate("24000/1001").map(|rate| (rate * 1000.0).round()), Some(23976.0));
        assert_eq!(parse_rate("0/0"), None);
        assert_eq!(parse_rate(""), None);
    }
}
