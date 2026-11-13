import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

const urls = new Map<string, Promise<string>>();

/**
 * The URL that a <video> element uses to play a file. Rust opens the file
 * once and serves its bytes in parts through the video:// protocol.
 */
export function videoUrl(path: string): Promise<string> {
  let url = urls.get(path);
  if (!url) {
    url = invoke<{ id: string }>("open_video_file", { path }).then((file) => convertFileSrc(file.id, "video"));
    url.catch(() => urls.delete(path));
    urls.set(path, url);
  }
  return url;
}

/**
 * Gives the path of a preview copy of a video that the player cannot play
 * directly. FFmpeg makes the copy the first time, which can take some time.
 */
export function makeProxy(path: string, durationSec: number): Promise<string> {
  return invoke<string>("make_proxy", { path, durationSec });
}

/** Calls the handler with how far each preview copy is (0 to 1). */
export function onProxyProgress(handler: (path: string, fraction: number) => void): Promise<UnlistenFn> {
  return listen<{ path: string; fraction: number }>("proxy-progress", (event) => handler(event.payload.path, event.payload.fraction));
}

/** The state of the preview copy of one media file. */
export type ProxyState =
  | { status: "making"; fraction: number }
  | { status: "ready"; path: string }
  | { status: "failed" };
