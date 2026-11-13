import { clipEnd, type Clip, type Project } from "./model";

/** One part of the timeline for the export, in the sequence of the timeline: a part of a video file, or a gap. */
export interface ExportSegment {
  /** The video file; null for a gap, which is black with no sound. */
  path: string | null;
  /** Where the part starts in the video file, in seconds. */
  startSec: number;
  /** The length of the part, in frames of the exported video. */
  frames: number;
  hasSound: boolean;
}

/**
 * The timeline as segments for the export, at the frame rate of the export.
 * Each cut goes to the nearest frame of the export, so the lengths add up
 * with no drift when the export has a different frame rate from the project.
 * A clip that continues the clip before it (a split with no other change)
 * joins that segment. A part too short for one export frame is left out.
 */
export function exportSegments(project: Project, fps: number): ExportSegment[] {
  const cut = (frame: number) => Math.round((frame * fps) / project.fps);
  const media = new Map(project.media.map((item) => [item.id, item]));
  const segments: ExportSegment[] = [];
  let position = 0;
  let before: Clip | null = null;
  for (const clip of [...project.clips].sort((a, b) => a.start - b.start)) {
    const item = media.get(clip.mediaId);
    if (!item) continue;
    const gap = cut(clip.start) - cut(position);
    if (gap > 0) segments.push({ path: null, startSec: 0, frames: gap, hasSound: false });
    const frames = cut(clipEnd(clip)) - cut(clip.start);
    const continues: boolean = before !== null && gap === 0 && before.mediaId === clip.mediaId
      && clipEnd(before) === clip.start && before.sourceIn + before.length === clip.sourceIn;
    if (continues && segments.length > 0) segments[segments.length - 1].frames += frames;
    else if (frames > 0) segments.push({ path: item.path, startSec: clip.sourceIn / project.fps, frames, hasSound: item.hasSound });
    position = clipEnd(clip);
    before = frames > 0 || continues ? clip : null;
  }
  return segments;
}

/** A frame size with the project's shape and this height. FFmpeg needs even numbers. */
export function sizeForHeight(project: Project, height: number): { width: number; height: number } {
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return { width: even((height * project.width) / project.height), height: even(height) };
}
