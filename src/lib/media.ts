import { invoke } from "@tauri-apps/api/core";
import { newId, type MediaItem } from "../editor/model";

/** The file types that the import dialog shows. ffprobe decides if a file is really a video. */
export const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "webm", "mkv", "avi", "wmv", "mpg", "mpeg", "ts", "mts", "m2ts", "flv", "3gp"];

type MediaInfo = Omit<MediaItem, "id" | "proxyPath"> & { videoCodec: string };

/** Reads the facts of a video file and makes a media item for the project. Rejects with a message for the user. */
export async function probeMedia(path: string): Promise<MediaItem> {
  const { videoCodec: _videoCodec, ...info } = await invoke<MediaInfo>("probe_media", { path });
  return { id: newId(), ...info };
}

const thumbnails = new Map<string, Promise<string>>();

/** The URL of a small picture of a media file, taken a short time after its start. Each file's picture is made once. */
export function thumbnailUrl(media: MediaItem): Promise<string> {
  let url = thumbnails.get(media.path);
  if (!url) {
    /* The first frame is often black, so the picture comes from a tenth of the way in, at most 5 s. */
    const atSec = Math.min(5, media.durationSec * 0.1);
    url = invoke<ArrayBuffer>("media_thumbnail", { path: media.path, atSec })
      .then((bytes) => URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" })));
    /* A failed picture is tried again the next time it is asked for. */
    url.catch(() => thumbnails.delete(media.path));
    thumbnails.set(media.path, url);
  }
  return url;
}

/** A length in seconds as "m:ss" or "h:mm:ss". */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(whole % 60)}` : `${minutes}:${pad(whole % 60)}`;
}

/** A frame rate as short text: "30", "29.97", "23.976". */
export const formatFps = (fps: number) => String(Math.round(fps * 1000) / 1000);
