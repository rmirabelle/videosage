/**
 * The project data. All timeline times are whole frames at the project
 * frame rate, so snap, split and join are exact.
 */

/** One imported video file. */
export interface MediaItem {
  id: string;
  /** The full path of the file on disk. */
  path: string;
  /** The file name, for the media list. */
  name: string;
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  hasSound: boolean;
  /** True when the preview player can play the file as it is; false when it needs a preview copy. */
  playable: boolean;
}

/** One piece of a media file on a layer. */
export interface Clip {
  id: string;
  mediaId: string;
  /**
   * The layer of the clip: 0 is the bottom layer. A clip on a higher layer
   * shows on top of the clips under it. The sound of all layers plays.
   */
  layer: number;
  /** The first frame of the clip on the track. */
  start: number;
  /**
   * The first frame that the clip uses from its media file. It can have a
   * fraction when the clip's speed is not 1.
   */
  sourceIn: number;
  /** The number of frames on the timeline; 1 or more. */
  length: number;
  /**
   * The frames of the media file for each frame of the timeline: 0.5 plays
   * at half speed (the clip is two times longer), 2 at double speed. No
   * value means 1. The clip uses the media file from sourceIn for
   * length * speed frames.
   */
  speed?: number;
  /** True when the clip plays its part of the media file from the end to the start. */
  reversed?: boolean;
}

/** The slowest and the fastest speed of a clip. */
export const MIN_SPEED = 0.1;
export const MAX_SPEED = 10;

export const clipSpeed = (clip: { speed?: number }) => clip.speed ?? 1;

/** The number of media file frames that the clip uses. */
export const sourceSpan = (clip: Clip) => clip.length * clipSpeed(clip);

/**
 * The frame of the media file (it can have a fraction) at a place in the
 * clip: "at" goes from 0 (the clip's start) to its length (the clip's end).
 * A reversed clip goes from the end of its part of the file to the start.
 */
export function sourceFrameAt(clip: Clip, at: number): number {
  const speed = clipSpeed(clip);
  return clip.reversed ? clip.sourceIn + (clip.length - at) * speed : clip.sourceIn + at * speed;
}

export interface Project {
  version: number;
  fps: number;
  width: number;
  height: number;
  media: MediaItem[];
  /**
   * Sorted by start. Clips on the same layer overlap only in a crossfade: a
   * clip can overlap a part of the clip before it on its layer, but not all
   * of it, and not the clip before that one. The overlap is the crossfade.
   */
  clips: Clip[];
}

/** A clip on the clipboard: its position is relative to the first copied clip. */
export interface ClipboardClip {
  mediaId: string;
  layer: number;
  offset: number;
  sourceIn: number;
  length: number;
  speed?: number;
  reversed?: boolean;
}

export const DEFAULT_FPS = 30;

export function emptyProject(): Project {
  return { version: 3, fps: DEFAULT_FPS, width: 1920, height: 1080, media: [], clips: [] };
}

/** The frame after the last frame of the clip. */
export const clipEnd = (clip: Clip) => clip.start + clip.length;

/** The number of layers: one more than the highest layer of a clip, and 1 or more. */
export const layerCount = (project: Project) => project.clips.reduce((count, clip) => Math.max(count, clip.layer + 1), 1);

/** The frame after the last clip, or 0 for an empty timeline. */
export const projectEnd = (project: Project) => project.clips.reduce((end, clip) => Math.max(end, clipEnd(clip)), 0);

/** Makes the id of a new clip or media item. */
export const newId = () => crypto.randomUUID();
