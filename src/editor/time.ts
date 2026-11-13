import type { MediaItem } from "./model";

export const framesToSeconds = (frames: number, fps: number) => frames / fps;

/** The nearest whole frame to a time in seconds. */
export const secondsToFrames = (seconds: number, fps: number) => Math.round(seconds * fps);

/**
 * The number of whole project frames that a media file holds. A small
 * tolerance (one hundredth of a frame) keeps a duration such as 9.99999 s
 * at 30 fps as 300 frames.
 */
export const mediaLength = (media: MediaItem, fps: number) => Math.max(1, Math.floor(media.durationSec * fps + 0.01));

const two = (value: number) => String(value).padStart(2, "0");

/** Timecode text "HH:MM:SS:FF" for a frame number. */
export function formatTimecode(frames: number, fps: number): string {
  const rate = Math.max(1, Math.round(fps));
  const whole = Math.max(0, Math.round(frames));
  const totalSeconds = Math.floor(whole / rate);
  return `${two(Math.floor(totalSeconds / 3600))}:${two(Math.floor(totalSeconds / 60) % 60)}:${two(totalSeconds % 60)}:${two(whole % rate)}`;
}
