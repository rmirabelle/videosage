import { clipEnd, clipSpeed, layerCount, projectEnd, type Clip, type Project } from "./model";
import { continues as continuesClip } from "./operations";

/** One part of a layer for the export, in the sequence of the timeline: a part of a video file, or a gap. */
export interface ExportSegment {
  /** The video file; null for a gap, which has no sound and shows the layers under it (black on layer 0). */
  path: string | null;
  /** Where the part starts in the video file, in seconds. */
  startSec: number;
  /** The length of the part, in frames of the exported video. */
  frames: number;
  hasSound: boolean;
  /**
   * The frames that this part overlaps the end of the part before it: a
   * crossfade, in which this part's picture and sound go up and the other
   * part's go down. 0 for no crossfade.
   */
  fadeIn: number;
  /**
   * The seconds of the file for each second of the part: 0.5 plays at half
   * speed. The part uses frames / fps * speed seconds of the file from startSec.
   */
  speed: number;
  /** True when the part plays its part of the file from the end to the start. */
  reversed: boolean;
}

/** A gap of a layer: no file, no sound. */
const gapSegment = (frames: number): ExportSegment => ({ path: null, startSec: 0, frames, hasSound: false, fadeIn: 0, speed: 1, reversed: false });

/**
 * The clips of one layer as segments for the export, at the frame rate of
 * the export. Each cut goes to the nearest frame of the export, so the
 * lengths add up with no drift when the export has a different frame rate
 * from the project. A clip that continues the clip before it (a split with no
 * other change) joins that segment. A part too short for one export frame is
 * left out. A clip that overlaps the clip before it gets the overlap as its
 * "fadeIn" (a crossfade); the layer's length is the sum of the frames less
 * the crossfades. With "until" (a project frame), a gap at the end makes the
 * layer that long.
 */
export function exportSegments(project: Project, fps: number, layer = 0, until = 0): ExportSegment[] {
  const cut = (frame: number) => Math.round((frame * fps) / project.fps);
  const media = new Map(project.media.map((item) => [item.id, item]));
  const segments: ExportSegment[] = [];
  let position = 0;
  let before: Clip | null = null;
  for (const clip of project.clips.filter((other) => other.layer === layer).sort((a, b) => a.start - b.start)) {
    const item = media.get(clip.mediaId);
    if (!item) continue;
    const gap = cut(clip.start) - cut(position);
    if (gap > 0) segments.push(gapSegment(gap));
    const frames = cut(clipEnd(clip)) - cut(clip.start);
    const continues: boolean = before !== null && gap === 0 && continuesClip(before, clip);
    const last = segments[segments.length - 1];
    /* A crossfade is shorter than both of its parts. */
    const fadeIn = gap < 0 && before && last?.path ? Math.min(-gap, last.frames - 1, frames - 1) : 0;
    if (continues && last) {
      last.frames += frames;
      /* A reversed clip that continues the one before it uses the file before that one's part. */
      if (clip.reversed) last.startSec = clip.sourceIn / project.fps;
    } else if (frames > 0) {
      segments.push({ path: item.path, startSec: clip.sourceIn / project.fps, frames, hasSound: item.hasSound, fadeIn: Math.max(0, fadeIn), speed: clipSpeed(clip), reversed: Boolean(clip.reversed) });
    }
    position = Math.max(position, clipEnd(clip));
    before = frames > 0 || continues ? clip : null;
  }
  const tail = cut(until) - cut(position);
  if (tail > 0) segments.push(gapSegment(tail));
  return segments;
}

/**
 * All layers as segments for the export, from layer 0 (the bottom) up. Each
 * layer is as long as the timeline, so the layers stay together. An empty
 * layer is left out.
 */
export function exportLayers(project: Project, fps: number): ExportSegment[][] {
  const end = projectEnd(project);
  const layers: ExportSegment[][] = [];
  for (let layer = 0; layer < layerCount(project); layer++) {
    const segments = exportSegments(project, fps, layer, end);
    if (segments.some((segment) => segment.path !== null)) layers.push(segments);
  }
  return layers;
}

/** A frame size with the project's shape and this height. FFmpeg needs even numbers. */
export function sizeForHeight(project: Project, height: number): { width: number; height: number } {
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return { width: even((height * project.width) / project.height), height: even(height) };
}
