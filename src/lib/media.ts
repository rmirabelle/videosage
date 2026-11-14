import { invoke } from "@tauri-apps/api/core";
import { newId, type MediaItem } from "../editor/model";

/** The file types that the import dialog shows. ffprobe decides if a file is really a video. */
export const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "webm", "mkv", "avi", "wmv", "mpg", "mpeg", "ts", "mts", "m2ts", "flv", "3gp"];

type MediaInfo = Omit<MediaItem, "id"> & { videoCodec: string };

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

/**
 * The URL of a picture of a video file at a time, with the given width in
 * pixels. The caller owns the URL, and releases it with URL.revokeObjectURL.
 */
export async function pictureUrl(path: string, atSec: number, width: number): Promise<string> {
  const bytes = await invoke<ArrayBuffer>("media_thumbnail", { path, atSec, width });
  return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
}

/** The most FFmpeg runs for clip strip pictures at one time. */
const FRAME_WORKERS = 4;
/** The most strip pictures that wait for FFmpeg; older requests are dropped. */
const FRAME_QUEUE_LIMIT = 80;
/** The most strip pictures that stay in memory. */
const FRAME_CACHE_LIMIT = 800;

interface FrameJob {
  key: string;
  path: string;
  atSec: number;
  resolve: (url: string) => void;
  reject: (error: unknown) => void;
}

const frames = new Map<string, Promise<string>>();
const frameQueue: FrameJob[] = [];
let frameWorkers = 0;

function runFrameQueue() {
  while (frameWorkers < FRAME_WORKERS && frameQueue.length > 0) {
    /* The newest request runs first: it is the one on screen now. */
    const job = frameQueue.pop()!;
    frameWorkers++;
    invoke<ArrayBuffer>("media_thumbnail", { path: job.path, atSec: job.atSec })
      .then((bytes) => job.resolve(URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }))), job.reject)
      .finally(() => {
        frameWorkers--;
        runFrameQueue();
      });
  }
}

/**
 * The URL of a small picture of a media file at a time, for the clip strips
 * on the timeline. Rust keeps each picture on disk, so FFmpeg makes it once.
 * A request that waits too long behind newer ones is dropped and rejects.
 */
export function frameUrl(path: string, atSec: number): Promise<string> {
  const key = `${path}|${atSec.toFixed(3)}`;
  const known = frames.get(key);
  if (known) {
    /* Put it at the end again, so the pictures in use are the last to go. */
    frames.delete(key);
    frames.set(key, known);
    return known;
  }
  const url = new Promise<string>((resolve, reject) => {
    frameQueue.push({ key, path, atSec, resolve, reject });
    if (frameQueue.length > FRAME_QUEUE_LIMIT) frameQueue.shift()!.reject(new Error("dropped"));
  });
  url.catch(() => frames.delete(key));
  frames.set(key, url);
  if (frames.size > FRAME_CACHE_LIMIT) {
    const [oldestKey, oldest] = frames.entries().next().value!;
    frames.delete(oldestKey);
    /* A picture that is on screen stays visible after its URL is released. */
    oldest.then((made) => URL.revokeObjectURL(made)).catch(() => {});
  }
  runFrameQueue();
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
