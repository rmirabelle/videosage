import { clipEnd, newId, type Clip, type ClipboardClip, type Project } from "./model";
import { mediaLength } from "./time";

/**
 * The timeline edits. Each one takes a project and gives a new project; it
 * never changes its input. When an edit changes nothing, it gives back the
 * same project object, so the caller can skip the undo step.
 */

const byStart = (a: Clip, b: Clip) => a.start - b.start;

const withClips = (project: Project, clips: Clip[]): Project => ({ ...project, clips: [...clips].sort(byStart) });

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;

/** The clip that shows at a frame, if there is one. */
export const clipAt = (project: Project, frame: number) => project.clips.find((clip) => clip.start <= frame && frame < clipEnd(clip));

/** True when the moving clips, moved by delta, stay at or after frame 0 and touch no fixed clip. */
function fits(fixed: Clip[], moving: Clip[], delta: number): boolean {
  return moving.every((clip) => clip.start + delta >= 0
    && !fixed.some((other) => overlaps(clip.start + delta, clipEnd(clip) + delta, other.start, clipEnd(other))));
}

/**
 * The move nearest to the wanted one that puts the moving clips in free
 * space. The free moves make ranges whose limits are always one of these:
 * the group at frame 0, a moving clip's start at a fixed clip's end, or a
 * moving clip's end at a fixed clip's start. So only those need a check.
 */
function nearestFreeDelta(fixed: Clip[], moving: Clip[], wanted: number): number {
  if (fits(fixed, moving, wanted)) return wanted;
  const candidates = [-Math.min(...moving.map((clip) => clip.start))];
  for (const other of fixed) {
    for (const clip of moving) {
      candidates.push(clipEnd(other) - clip.start, other.start - clipEnd(clip));
    }
  }
  let best: number | null = null;
  for (const candidate of candidates) {
    if (!fits(fixed, moving, candidate)) continue;
    if (best === null || Math.abs(candidate - wanted) < Math.abs(best - wanted)) best = candidate;
  }
  /* The position after the last fixed clip is always free, so a best move always exists. */
  return best ?? 0;
}

/** Moves the clips with the given ids together by delta frames, to the nearest free position. */
export function moveClips(project: Project, ids: ReadonlySet<string>, delta: number): Project {
  const moving = project.clips.filter((clip) => ids.has(clip.id));
  if (moving.length === 0) return project;
  const fixed = project.clips.filter((clip) => !ids.has(clip.id));
  const best = nearestFreeDelta(fixed, moving, Math.round(delta));
  if (best === 0) return project;
  return withClips(project, [...fixed, ...moving.map((clip) => ({ ...clip, start: clip.start + best }))]);
}

/** Adds a full-length clip of a media file at the free position nearest to a frame. Gives the new clip's id too. */
export function insertMedia(project: Project, mediaId: string, at: number): { project: Project; clipId: string | null } {
  const media = project.media.find((item) => item.id === mediaId);
  if (!media) return { project, clipId: null };
  const clip: Clip = { id: newId(), mediaId, start: Math.max(0, Math.round(at)), sourceIn: 0, length: mediaLength(media, project.fps) };
  const delta = nearestFreeDelta(project.clips, [clip], 0);
  return { project: withClips(project, [...project.clips, { ...clip, start: clip.start + delta }]), clipId: clip.id };
}

/** Splits the clip under a frame into two clips. The frame must be inside the clip, not at its start. */
export function splitAt(project: Project, frame: number): Project {
  const clip = clipAt(project, frame);
  if (!clip || frame === clip.start) return project;
  const firstLength = frame - clip.start;
  const first: Clip = { ...clip, length: firstLength };
  const second: Clip = { ...clip, id: newId(), start: frame, sourceIn: clip.sourceIn + firstLength, length: clip.length - firstLength };
  return withClips(project, project.clips.flatMap((other) => other.id === clip.id ? [first, second] : [other]));
}

/** True when two clips touch on the track and the second continues the first in the same media file. */
const continues = (a: Clip, b: Clip) => a.mediaId === b.mediaId && clipEnd(a) === b.start && a.sourceIn + a.length === b.sourceIn;

/** True when the selected clips (two or more) can become one clip. */
export function canJoin(project: Project, ids: ReadonlySet<string>): boolean {
  const selected = project.clips.filter((clip) => ids.has(clip.id));
  return selected.length >= 2 && selected.every((clip, index) => index === 0 || continues(selected[index - 1], clip));
}

/** Makes one clip from selected clips that touch and continue in the same media file. The first clip keeps its id. */
export function joinClips(project: Project, ids: ReadonlySet<string>): Project {
  if (!canJoin(project, ids)) return project;
  const selected = project.clips.filter((clip) => ids.has(clip.id));
  const joined: Clip = { ...selected[0], length: selected.reduce((sum, clip) => sum + clip.length, 0) };
  return withClips(project, project.clips.flatMap((clip) => clip.id === joined.id ? [joined] : ids.has(clip.id) ? [] : [clip]));
}

export function deleteClips(project: Project, ids: ReadonlySet<string>): Project {
  const clips = project.clips.filter((clip) => !ids.has(clip.id));
  return clips.length === project.clips.length ? project : { ...project, clips };
}

/**
 * Moves the start of a clip to a new frame; the end stays. The start stops
 * at the end of the clip before it, at the first frame of the media file,
 * and one frame before the clip's end.
 */
export function trimStart(project: Project, id: string, newStart: number): Project {
  const index = project.clips.findIndex((clip) => clip.id === id);
  if (index < 0) return project;
  const clip = project.clips[index];
  const previousEnd = index > 0 ? clipEnd(project.clips[index - 1]) : 0;
  const lowest = Math.max(previousEnd, clip.start - clip.sourceIn);
  const start = Math.min(Math.max(Math.round(newStart), lowest), clipEnd(clip) - 1);
  if (start === clip.start) return project;
  const change = start - clip.start;
  const trimmed: Clip = { ...clip, start, sourceIn: clip.sourceIn + change, length: clip.length - change };
  return withClips(project, project.clips.map((other) => other.id === id ? trimmed : other));
}

/**
 * Moves the end of a clip to a new frame; the start stays. The end stops
 * at the start of the clip after it, at the last frame of the media file,
 * and one frame after the clip's start.
 */
export function trimEnd(project: Project, id: string, newEnd: number): Project {
  const index = project.clips.findIndex((clip) => clip.id === id);
  if (index < 0) return project;
  const clip = project.clips[index];
  const media = project.media.find((item) => item.id === clip.mediaId);
  const nextStart = index + 1 < project.clips.length ? project.clips[index + 1].start : Infinity;
  const mediaEnd = media ? clip.start + mediaLength(media, project.fps) - clip.sourceIn : Infinity;
  const end = Math.max(Math.min(Math.round(newEnd), nextStart, mediaEnd), clip.start + 1);
  if (end === clipEnd(clip)) return project;
  return withClips(project, project.clips.map((other) => other.id === id ? { ...clip, length: end - clip.start } : other));
}

/** Moves all clips together from frame 0, in their order, with no gaps. */
export function closeGaps(project: Project): Project {
  let next = 0;
  let changed = false;
  const clips = project.clips.map((clip) => {
    const moved = clip.start === next ? clip : { ...clip, start: next };
    if (moved !== clip) changed = true;
    next += clip.length;
    return moved;
  });
  return changed ? { ...project, clips } : project;
}

/** The selected clips for the clipboard, with positions relative to the first one. */
export function copyClips(project: Project, ids: ReadonlySet<string>): ClipboardClip[] {
  const selected = project.clips.filter((clip) => ids.has(clip.id));
  if (selected.length === 0) return [];
  const origin = selected[0].start;
  return selected.map((clip) => ({ mediaId: clip.mediaId, offset: clip.start - origin, sourceIn: clip.sourceIn, length: clip.length }));
}

/**
 * Puts the clipboard clips on the track at a frame. A clip under that frame
 * is split there, and the clips after the frame move right by the room that
 * the pasted clips need. Clipboard clips of media that the project no longer
 * has are left out. Gives the ids of the new clips too.
 */
export function pasteClips(project: Project, clipboard: readonly ClipboardClip[], at: number): { project: Project; pastedIds: string[] } {
  const usable = clipboard.filter((item) => project.media.some((media) => media.id === item.mediaId));
  if (usable.length === 0) return { project, pastedIds: [] };
  const frame = Math.max(0, Math.round(at));
  const base = splitAt(project, frame);
  const origin = Math.min(...usable.map((item) => item.offset));
  const span = Math.max(...usable.map((item) => item.offset - origin + item.length));
  const later = base.clips.filter((clip) => clip.start >= frame);
  const shift = later.length > 0 ? Math.max(0, frame + span - later[0].start) : 0;
  const pasted: Clip[] = usable.map((item) => ({ id: newId(), mediaId: item.mediaId, start: frame + item.offset - origin, sourceIn: item.sourceIn, length: item.length }));
  const kept = base.clips.map((clip) => clip.start >= frame && shift > 0 ? { ...clip, start: clip.start + shift } : clip);
  return { project: withClips(base, [...kept, ...pasted]), pastedIds: pasted.map((clip) => clip.id) };
}

/**
 * Removes a media file from the project, with the clips that use it.
 */
export function removeMedia(project: Project, mediaId: string): Project {
  if (!project.media.some((item) => item.id === mediaId)) return project;
  return { ...project, media: project.media.filter((item) => item.id !== mediaId), clips: project.clips.filter((clip) => clip.mediaId !== mediaId) };
}
