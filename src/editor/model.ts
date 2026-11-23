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
  /** The first frame that the clip uses from its media file. */
  sourceIn: number;
  /** The number of frames; 1 or more. */
  length: number;
}

export interface Project {
  version: number;
  fps: number;
  width: number;
  height: number;
  media: MediaItem[];
  /** Sorted by start. Clips on the same layer do not overlap. */
  clips: Clip[];
}

/** A clip on the clipboard: its position is relative to the first copied clip. */
export interface ClipboardClip {
  mediaId: string;
  layer: number;
  offset: number;
  sourceIn: number;
  length: number;
}

export const DEFAULT_FPS = 30;

export function emptyProject(): Project {
  return { version: 2, fps: DEFAULT_FPS, width: 1920, height: 1080, media: [], clips: [] };
}

/** The frame after the last frame of the clip. */
export const clipEnd = (clip: Clip) => clip.start + clip.length;

/** The number of layers: one more than the highest layer of a clip, and 1 or more. */
export const layerCount = (project: Project) => project.clips.reduce((count, clip) => Math.max(count, clip.layer + 1), 1);

/** The frame after the last clip, or 0 for an empty timeline. */
export const projectEnd = (project: Project) => project.clips.reduce((end, clip) => Math.max(end, clipEnd(clip)), 0);

/** Makes the id of a new clip or media item. */
export const newId = () => crypto.randomUUID();
