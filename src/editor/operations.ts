import { clipEnd, layerCount, newId, type Clip, type ClipboardClip, type MediaItem, type Project } from "./model";
import { mediaLength } from "./time";

/**
 * The timeline edits. Each one takes a project and gives a new project; it
 * never changes its input. When an edit changes nothing, it gives back the
 * same project object, so the caller can skip the undo step. Clips on the
 * same layer do not overlap; clips on different layers can.
 */

const byStart = (a: Clip, b: Clip) => a.start - b.start || a.layer - b.layer;

const withClips = (project: Project, clips: Clip[]): Project => ({ ...project, clips: [...clips].sort(byStart) });

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;

const onLayer = (project: Project, layer: number) => project.clips.filter((clip) => clip.layer === layer);

/** The clip on a layer that shows at a frame, if there is one. */
export const clipAt = (project: Project, frame: number, layer = 0) =>
  project.clips.find((clip) => clip.layer === layer && clip.start <= frame && frame < clipEnd(clip));

/** The clip that shows at a frame: the one on the highest layer. */
export const topClipAt = (project: Project, frame: number) =>
  project.clips.reduce<Clip | undefined>((top, clip) => clip.start <= frame && frame < clipEnd(clip) && (!top || clip.layer > top.layer) ? clip : top, undefined);

/** True when the moving clips, moved by delta, stay at or after frame 0 and touch no fixed clip on their layer. */
function fits(fixed: Clip[], moving: Clip[], delta: number): boolean {
  return moving.every((clip) => clip.start + delta >= 0
    && !fixed.some((other) => other.layer === clip.layer && overlaps(clip.start + delta, clipEnd(clip) + delta, other.start, clipEnd(other))));
}

/**
 * The move nearest to the wanted one that puts the moving clips in free
 * space. The free moves make ranges whose limits are always one of these:
 * the group at frame 0, a moving clip's start at a fixed clip's end, or a
 * moving clip's end at a fixed clip's start (on the same layer). So only
 * those need a check.
 */
function nearestFreeDelta(fixed: Clip[], moving: Clip[], wanted: number): number {
  if (fits(fixed, moving, wanted)) return wanted;
  const candidates = [-Math.min(...moving.map((clip) => clip.start))];
  for (const other of fixed) {
    for (const clip of moving) {
      if (clip.layer === other.layer) candidates.push(clipEnd(other) - clip.start, other.start - clipEnd(clip));
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

/**
 * Moves the clips with the given ids together by delta frames and by a
 * number of layers, to the nearest free position. The clips stop at layer
 * 0, and they can go one layer above the top layer (a new layer).
 */
export function moveClips(project: Project, ids: ReadonlySet<string>, delta: number, layerDelta = 0): Project {
  const moving = project.clips.filter((clip) => ids.has(clip.id));
  if (moving.length === 0) return project;
  const lowest = Math.min(...moving.map((clip) => clip.layer));
  const highest = Math.max(...moving.map((clip) => clip.layer));
  const layers = Math.max(-lowest, Math.min(Math.round(layerDelta), layerCount(project) - highest));
  const fixed = project.clips.filter((clip) => !ids.has(clip.id));
  const lifted = moving.map((clip) => layers === 0 ? clip : { ...clip, layer: clip.layer + layers });
  const best = nearestFreeDelta(fixed, lifted, Math.round(delta));
  if (best === 0 && layers === 0) return project;
  return withClips(project, [...fixed, ...lifted.map((clip) => best === 0 ? clip : { ...clip, start: clip.start + best })]);
}

/** Adds a full-length clip of a media file on a layer, at the free position nearest to a frame. Gives the new clip's id too. */
export function insertMedia(project: Project, mediaId: string, at: number, layer = 0): { project: Project; clipId: string | null } {
  const media = project.media.find((item) => item.id === mediaId);
  if (!media) return { project, clipId: null };
  const clip: Clip = { id: newId(), mediaId, layer: Math.max(0, layer), start: Math.max(0, Math.round(at)), sourceIn: 0, length: mediaLength(media, project.fps) };
  const delta = nearestFreeDelta(project.clips, [clip], 0);
  return { project: withClips(project, [...project.clips, { ...clip, start: clip.start + delta }]), clipId: clip.id };
}

/** The frame after the last clip of a layer, or 0 for an empty layer. */
export const layerEnd = (project: Project, layer: number) => onLayer(project, layer).reduce((end, clip) => Math.max(end, clipEnd(clip)), 0);

/** Splits each clip that "chosen" picks and that has the frame inside it (not at its start) into two clips. */
function splitWhere(project: Project, frame: number, chosen: (clip: Clip) => boolean): Project {
  const cut = project.clips.filter((clip) => chosen(clip) && clip.start < frame && frame < clipEnd(clip));
  if (cut.length === 0) return project;
  const cutIds = new Set(cut.map((clip) => clip.id));
  return withClips(project, project.clips.flatMap((clip) => {
    if (!cutIds.has(clip.id)) return [clip];
    const firstLength = frame - clip.start;
    return [{ ...clip, length: firstLength }, { ...clip, id: newId(), start: frame, sourceIn: clip.sourceIn + firstLength, length: clip.length - firstLength }];
  }));
}

/**
 * Splits clips at a frame into two clips each. When selected clips are
 * under the frame, only they are split; else every clip under the frame is
 * split, on all layers. The frame must be inside a clip, not at its start.
 */
export function splitAt(project: Project, frame: number, selected: ReadonlySet<string> = new Set()): Project {
  const under = project.clips.filter((clip) => clip.start < frame && frame < clipEnd(clip));
  const onlySelected = under.some((clip) => selected.has(clip.id));
  return splitWhere(project, frame, (clip) => !onlySelected || selected.has(clip.id));
}

/** True when two clips touch on the same layer and the second continues the first in the same media file. */
const continues = (a: Clip, b: Clip) => a.layer === b.layer && a.mediaId === b.mediaId && clipEnd(a) === b.start && a.sourceIn + a.length === b.sourceIn;

const selectedInOrder = (project: Project, ids: ReadonlySet<string>) => project.clips.filter((clip) => ids.has(clip.id)).sort(byStart);

/** True when the selected clips (two or more) can become one clip. */
export function canJoin(project: Project, ids: ReadonlySet<string>): boolean {
  const selected = selectedInOrder(project, ids);
  return selected.length >= 2 && selected.every((clip, index) => index === 0 || continues(selected[index - 1], clip));
}

/** Makes one clip from selected clips that touch and continue in the same media file. The first clip keeps its id. */
export function joinClips(project: Project, ids: ReadonlySet<string>): Project {
  if (!canJoin(project, ids)) return project;
  const selected = selectedInOrder(project, ids);
  const joined: Clip = { ...selected[0], length: selected.reduce((sum, clip) => sum + clip.length, 0) };
  return withClips(project, project.clips.flatMap((clip) => clip.id === joined.id ? [joined] : ids.has(clip.id) ? [] : [clip]));
}

/**
 * Deletes the clips. On the layer of a deleted clip, each later clip moves
 * back by the length of that clip, so the delete leaves no hole. Gaps that
 * were there before the delete stay. Other layers do not move.
 */
export function deleteClips(project: Project, ids: ReadonlySet<string>): Project {
  if (!project.clips.some((clip) => ids.has(clip.id))) return project;
  const removed = new Map<number, number>();
  const clips: Clip[] = [];
  for (const clip of [...project.clips].sort(byStart)) {
    const back = removed.get(clip.layer) ?? 0;
    if (ids.has(clip.id)) removed.set(clip.layer, back + clip.length);
    else clips.push(back > 0 ? { ...clip, start: clip.start - back } : clip);
  }
  return { ...project, clips };
}

/**
 * Moves the start of a clip to a new frame; the end stays. The start stops
 * at the end of the clip before it on its layer, at the first frame of the
 * media file, and one frame before the clip's end.
 */
export function trimStart(project: Project, id: string, newStart: number): Project {
  const clip = project.clips.find((other) => other.id === id);
  if (!clip) return project;
  const previousEnd = onLayer(project, clip.layer).reduce((end, other) => other.id !== id && clipEnd(other) <= clip.start ? Math.max(end, clipEnd(other)) : end, 0);
  const lowest = Math.max(previousEnd, clip.start - clip.sourceIn);
  const start = Math.min(Math.max(Math.round(newStart), lowest), clipEnd(clip) - 1);
  if (start === clip.start) return project;
  const change = start - clip.start;
  const trimmed: Clip = { ...clip, start, sourceIn: clip.sourceIn + change, length: clip.length - change };
  return withClips(project, project.clips.map((other) => other.id === id ? trimmed : other));
}

/**
 * Moves the end of a clip to a new frame; the start stays. The end stops
 * at the start of the clip after it on its layer, at the last frame of the
 * media file, and one frame after the clip's start.
 */
export function trimEnd(project: Project, id: string, newEnd: number): Project {
  const clip = project.clips.find((other) => other.id === id);
  if (!clip) return project;
  const media = project.media.find((item) => item.id === clip.mediaId);
  const nextStart = onLayer(project, clip.layer).reduce((next, other) => other.id !== id && other.start >= clipEnd(clip) ? Math.min(next, other.start) : next, Infinity);
  const mediaEnd = media ? clip.start + mediaLength(media, project.fps) - clip.sourceIn : Infinity;
  const end = Math.max(Math.min(Math.round(newEnd), nextStart, mediaEnd), clip.start + 1);
  if (end === clipEnd(clip)) return project;
  return withClips(project, project.clips.map((other) => other.id === id ? { ...clip, length: end - clip.start } : other));
}

/**
 * Moves the clips of each layer together from frame 0, in their order, with
 * no gaps. With "layers", only those layers change.
 */
export function closeGaps(project: Project, layers?: ReadonlySet<number>): Project {
  const next = new Map<number, number>();
  let changed = false;
  const clips = [...project.clips].sort(byStart).map((clip) => {
    if (layers && !layers.has(clip.layer)) return clip;
    const at = next.get(clip.layer) ?? 0;
    next.set(clip.layer, at + clip.length);
    if (clip.start === at) return clip;
    changed = true;
    return { ...clip, start: at };
  });
  return changed ? withClips(project, clips) : project;
}

/** The selected clips for the clipboard, with positions relative to the first one. */
export function copyClips(project: Project, ids: ReadonlySet<string>): ClipboardClip[] {
  const selected = selectedInOrder(project, ids);
  if (selected.length === 0) return [];
  const origin = selected[0].start;
  return selected.map((clip) => ({ mediaId: clip.mediaId, layer: clip.layer, offset: clip.start - origin, sourceIn: clip.sourceIn, length: clip.length }));
}

/**
 * Puts the clipboard clips at a frame, each on the layer it was copied
 * from. On each of those layers, a clip under that frame is split there, and
 * the clips after the frame move right by the room that the pasted clips
 * need. Clipboard clips of media that the project no longer has are left
 * out. Gives the ids of the new clips too.
 */
export function pasteClips(project: Project, clipboard: readonly ClipboardClip[], at: number): { project: Project; pastedIds: string[] } {
  const usable = clipboard.filter((item) => project.media.some((media) => media.id === item.mediaId));
  if (usable.length === 0) return { project, pastedIds: [] };
  const frame = Math.max(0, Math.round(at));
  const layers = new Set(usable.map((item) => item.layer));
  const base = splitWhere(project, frame, (clip) => layers.has(clip.layer));
  const origin = Math.min(...usable.map((item) => item.offset));
  const shifts = new Map<number, number>();
  for (const layer of layers) {
    const span = Math.max(...usable.filter((item) => item.layer === layer).map((item) => item.offset - origin + item.length));
    const firstLater = Math.min(...base.clips.filter((clip) => clip.layer === layer && clip.start >= frame).map((clip) => clip.start));
    shifts.set(layer, Number.isFinite(firstLater) ? Math.max(0, frame + span - firstLater) : 0);
  }
  const pasted: Clip[] = usable.map((item) => ({ id: newId(), mediaId: item.mediaId, layer: item.layer, start: frame + item.offset - origin, sourceIn: item.sourceIn, length: item.length }));
  const kept = base.clips.map((clip) => {
    const shift = clip.start >= frame ? shifts.get(clip.layer) ?? 0 : 0;
    return shift > 0 ? { ...clip, start: clip.start + shift } : clip;
  });
  return { project: withClips(base, [...kept, ...pasted]), pastedIds: pasted.map((clip) => clip.id) };
}

/**
 * Removes the empty layers between and under the used layers, so the layers
 * are 0, 1, 2 ... with no empty layer. The clips keep their order of layers.
 */
export function compactLayers(project: Project): Project {
  const used = [...new Set(project.clips.map((clip) => clip.layer))].sort((a, b) => a - b);
  if (used.every((layer, index) => layer === index)) return project;
  const place = new Map(used.map((layer, index) => [layer, index]));
  return { ...project, clips: project.clips.map((clip) => ({ ...clip, layer: place.get(clip.layer)! })) };
}

/**
 * A project with only the selected clips, for the export of a selection.
 * The clips keep their layers and their places relative to each other; the
 * first one starts at frame 0.
 */
export function selectionProject(project: Project, ids: ReadonlySet<string>): Project {
  const selected = project.clips.filter((clip) => ids.has(clip.id));
  if (selected.length === 0) return { ...project, clips: [] };
  const origin = Math.min(...selected.map((clip) => clip.start));
  return compactLayers({ ...project, clips: selected.map((clip) => ({ ...clip, start: clip.start - origin })) });
}

/** The first and the end frame of the selected clips (the end is the frame after the last), or null with no selection. */
export function selectionRange(project: Project, ids: ReadonlySet<string>): { start: number; end: number } | null {
  const selected = project.clips.filter((clip) => ids.has(clip.id));
  if (selected.length === 0) return null;
  return { start: Math.min(...selected.map((clip) => clip.start)), end: Math.max(...selected.map(clipEnd)) };
}

/**
 * Removes a media file from the project, with the clips that use it.
 */
export function removeMedia(project: Project, mediaId: string): Project {
  if (!project.media.some((item) => item.id === mediaId)) return project;
  return { ...project, media: project.media.filter((item) => item.id !== mediaId), clips: project.clips.filter((clip) => clip.mediaId !== mediaId) };
}

/**
 * Points a media item at a different file (the user found a file that was
 * missing). The item keeps its id, so its clips stay. Gives null when the new
 * file is too short for a clip that uses the item, or when the project
 * already has the new file as a different item.
 */
export function relinkMedia(project: Project, mediaId: string, found: MediaItem): Project | null {
  if (!project.media.some((item) => item.id === mediaId)) return project;
  if (project.media.some((item) => item.id !== mediaId && item.path === found.path)) return null;
  const next = { ...found, id: mediaId };
  const length = mediaLength(next, project.fps);
  if (project.clips.some((clip) => clip.mediaId === mediaId && clip.sourceIn + clip.length > length)) return null;
  return { ...project, media: project.media.map((item) => item.id === mediaId ? next : item) };
}

/**
 * Adds an imported media file to the project. A file that the project
 * already has is not added again. The first file of an empty project sets
 * the project frame rate and frame size.
 */
export function addMedia(project: Project, item: MediaItem): Project {
  if (project.media.some((other) => other.path === item.path)) return project;
  const first = project.media.length === 0 && project.clips.length === 0;
  const settings = first ? { fps: Math.min(120, Math.max(1, Math.round(item.fps * 1000) / 1000)), width: item.width, height: item.height } : {};
  return { ...project, ...settings, media: [...project.media, item] };
}
