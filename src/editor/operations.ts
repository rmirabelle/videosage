import { MAX_SPEED, MIN_SPEED, clipEnd, clipSpeed, layerCount, newId, sourceSpan, type Clip, type ClipboardClip, type MediaItem, type Project } from "./model";
import { mediaLength } from "./time";

/**
 * The timeline edits. Each one takes a project and gives a new project; it
 * never changes its input. When an edit changes nothing, it gives back the
 * same project object, so the caller can skip the undo step. Clips on the
 * same layer overlap only in a crossfade (see Project.clips); clips on
 * different layers can overlap.
 */

const byStart = (a: Clip, b: Clip) => a.start - b.start || a.layer - b.layer;

const withClips = (project: Project, clips: Clip[]): Project => ({ ...project, clips: [...clips].sort(byStart) });

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;

const onLayer = (project: Project, layer: number) => project.clips.filter((clip) => clip.layer === layer);

/** The clips of a layer, in the order of the timeline. */
const layerClips = (project: Project, layer: number) => onLayer(project, layer).sort(byStart);

/** The frames that clip "b" overlaps the end of clip "a" on their layer: the length of their crossfade, or 0. */
const fadeLength = (a: Clip | undefined, b: Clip | undefined) => a && b && a.start < b.start ? Math.max(0, Math.min(clipEnd(a), clipEnd(b)) - b.start) : 0;

/** True when the clips of one layer (in the order of the timeline) keep the crossfade rules of Project.clips. */
function layerFits(clips: readonly Clip[]): boolean {
  return clips.every((clip, index) => {
    if (clip.start < 0) return false;
    const before = clips[index - 1];
    if (before && !(clip.start > before.start && clipEnd(clip) > clipEnd(before))) return false;
    const twoBefore = clips[index - 2];
    return !twoBefore || clip.start >= clipEnd(twoBefore);
  });
}

/** True when the clips of all layers keep the crossfade rules of Project.clips (for a project file that opens). */
export function clipsKeepRules(clips: readonly Clip[]): boolean {
  return [...new Set(clips.map((clip) => clip.layer))].every((layer) => layerFits(clips.filter((clip) => clip.layer === layer).sort(byStart)));
}

/**
 * The crossfade of a layer at a frame, if the frame is in one: "out" is the
 * clip that ends, "in" is the clip that starts, and "mix" goes from 0 to 1
 * across the crossfade (how much of "in" shows and sounds). The frame can
 * have a fraction.
 */
export function fadeAt(project: Project, frame: number, layer: number): { out: Clip; in: Clip; mix: number } | null {
  const under = project.clips.filter((clip) => clip.layer === layer && clip.start <= frame && frame < clipEnd(clip));
  if (under.length < 2) return null;
  const [out, incoming] = under.sort(byStart);
  const length = clipEnd(out) - incoming.start;
  return { out, in: incoming, mix: Math.min(1, Math.max(0, (frame - incoming.start + 0.5) / length)) };
}

/** The length of each crossfade in frames, by the id of the clip that starts in it. */
export function fadeIns(project: Project): Map<string, number> {
  const fades = new Map<string, number>();
  const last = new Map<number, Clip>();
  for (const clip of [...project.clips].sort(byStart)) {
    const length = fadeLength(last.get(clip.layer), clip);
    if (length > 0) fades.set(clip.id, length);
    last.set(clip.layer, clip);
  }
  return fades;
}

/** The clip on a layer that shows at a frame, if there is one. In a crossfade, it is the clip that ends. */
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

/** True when the moving clips, moved by delta, keep the crossfade rules on their layers with the fixed clips. */
function fitsWithFades(fixed: Clip[], moving: Clip[], delta: number): boolean {
  const moved = moving.map((clip) => ({ ...clip, start: clip.start + delta }));
  const all = [...fixed, ...moved];
  return [...new Set(moved.map((clip) => clip.layer))].every((layer) => layerFits(all.filter((clip) => clip.layer === layer).sort(byStart)));
}

/**
 * The move nearest to the wanted one that puts the moving clips in free
 * space. The free moves make ranges whose limits are always one of these:
 * the group at frame 0, a moving clip's start at a fixed clip's end, or a
 * moving clip's end at a fixed clip's start (on the same layer). So only
 * those need a check. With "fades", the wanted move can also overlap a part
 * of a clip, which makes a crossfade.
 */
function nearestFreeDelta(fixed: Clip[], moving: Clip[], wanted: number, fades = false): number {
  if (fades ? fitsWithFades(fixed, moving, wanted) : fits(fixed, moving, wanted)) return wanted;
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
 * number of layers. A clip that overlaps a part of a clip next to it on its
 * layer makes a crossfade, in the rules of Project.clips; else the clips go
 * to the nearest free position. The clips stop at layer 0, and they can go
 * one layer above the top layer (a new layer).
 */
export function moveClips(project: Project, ids: ReadonlySet<string>, delta: number, layerDelta = 0): Project {
  const moving = project.clips.filter((clip) => ids.has(clip.id));
  if (moving.length === 0) return project;
  const lowest = Math.min(...moving.map((clip) => clip.layer));
  const highest = Math.max(...moving.map((clip) => clip.layer));
  const layers = Math.max(-lowest, Math.min(Math.round(layerDelta), layerCount(project) - highest));
  const fixed = project.clips.filter((clip) => !ids.has(clip.id));
  const lifted = moving.map((clip) => layers === 0 ? clip : { ...clip, layer: clip.layer + layers });
  const best = nearestFreeDelta(fixed, lifted, Math.round(delta), true);
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

/**
 * How an import puts its videos on the timeline. "layers": each video goes
 * on a new layer on top, at "start" (on an empty timeline, the first video
 * goes on layer 1). "track": the videos go one after the other on "layer",
 * from "start".
 */
export type ImportPlacement = { mode: "layers"; start: number } | { mode: "track"; layer: number; start: number };

/** The placement of a new import: at frame 0 on an empty timeline, else at the playhead (on a new layer on top). */
export function importPlacement(project: Project, mode: ImportPlacement["mode"], playhead: number): ImportPlacement {
  const empty = project.clips.length === 0;
  const start = empty ? 0 : playhead;
  return mode === "layers" ? { mode, start } : { mode, layer: empty ? 0 : layerCount(project), start };
}

/** Puts a full-length clip of a media file on the timeline, as the placement tells. */
export function placeImport(project: Project, mediaId: string, placement: ImportPlacement): Project {
  if (placement.mode === "track") return insertMedia(project, mediaId, Math.max(placement.start, layerEnd(project, placement.layer)), placement.layer).project;
  const layer = project.clips.length === 0 ? 0 : layerCount(project);
  return insertMedia(project, mediaId, placement.start, layer).project;
}

/**
 * Splits each clip that "chosen" picks and that has the frame inside it
 * (not at its start) into two clips. A layer is not split in a crossfade.
 */
function splitWhere(project: Project, frame: number, chosen: (clip: Clip) => boolean): Project {
  const cut = project.clips.filter((clip) => chosen(clip) && clip.start < frame && frame < clipEnd(clip) && !fadeAt(project, frame, clip.layer));
  if (cut.length === 0) return project;
  const cutIds = new Set(cut.map((clip) => clip.id));
  return withClips(project, project.clips.flatMap((clip) => {
    if (!cutIds.has(clip.id)) return [clip];
    const firstLength = frame - clip.start;
    const secondLength = clip.length - firstLength;
    const speed = clipSpeed(clip);
    /* A reversed clip shows the end of its part of the file first. */
    if (clip.reversed) return [{ ...clip, length: firstLength, sourceIn: clip.sourceIn + secondLength * speed }, { ...clip, id: newId(), start: frame, length: secondLength }];
    return [{ ...clip, length: firstLength }, { ...clip, id: newId(), start: frame, sourceIn: clip.sourceIn + firstLength * speed, length: secondLength }];
  }));
}

/**
 * Splits clips at a frame into two clips each. When selected clips are
 * under the frame, only they are split; else every clip under the frame is
 * split, on all layers. The frame must be inside a clip, not at its start.
 * A layer is not split in a crossfade.
 */
export function splitAt(project: Project, frame: number, selected: ReadonlySet<string> = new Set()): Project {
  const under = project.clips.filter((clip) => clip.start < frame && frame < clipEnd(clip));
  const onlySelected = under.some((clip) => selected.has(clip.id));
  return splitWhere(project, frame, (clip) => !onlySelected || selected.has(clip.id));
}

/** True when two clips touch on the same layer and the second continues the first in the same media file. */
export const continues = (a: Clip, b: Clip) => a.layer === b.layer && a.mediaId === b.mediaId && clipEnd(a) === b.start
  && clipSpeed(a) === clipSpeed(b) && Boolean(a.reversed) === Boolean(b.reversed)
  && (a.reversed ? b.sourceIn + sourceSpan(b) === a.sourceIn : a.sourceIn + sourceSpan(a) === b.sourceIn);

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
  /* A reversed clip starts in the file where its last part starts. */
  const sourceIn = selected[0].reversed ? selected[selected.length - 1].sourceIn : selected[0].sourceIn;
  const joined: Clip = { ...selected[0], sourceIn, length: selected.reduce((sum, clip) => sum + clip.length, 0) };
  return withClips(project, project.clips.flatMap((clip) => clip.id === joined.id ? [joined] : ids.has(clip.id) ? [] : [clip]));
}

/**
 * Deletes the clips. On the layer of a deleted clip, each later clip moves
 * back by the length of the hole that the clip leaves, so the delete leaves
 * no hole. The crossfades of a deleted clip go with it: the clips before and
 * after it then touch. Gaps that were there before the delete stay. Other
 * layers do not move.
 */
export function deleteClips(project: Project, ids: ReadonlySet<string>): Project {
  if (!project.clips.some((clip) => ids.has(clip.id))) return project;
  const sorted = [...project.clips].sort(byStart);
  const previous = new Map<string, Clip>();
  const next = new Map<string, Clip>();
  const last = new Map<number, Clip>();
  for (const clip of sorted) {
    const before = last.get(clip.layer);
    if (before) { previous.set(clip.id, before); next.set(before.id, clip); }
    last.set(clip.layer, clip);
  }
  const removed = new Map<number, number>();
  const clips: Clip[] = [];
  for (const clip of sorted) {
    const back = removed.get(clip.layer) ?? 0;
    if (ids.has(clip.id)) {
      /* A crossfade between two deleted clips counts one time. */
      const after = next.get(clip.id);
      const hole = clip.length - fadeLength(previous.get(clip.id), clip) - (after && !ids.has(after.id) ? fadeLength(clip, after) : 0);
      removed.set(clip.layer, back + hole);
    } else clips.push(back > 0 ? { ...clip, start: clip.start - back } : clip);
  }
  return withClips(project, clips);
}

/**
 * Moves the start of a clip to a new frame; the end stays. The start stops
 * at the end of the clip before it on its layer, at the first frame of the
 * media file, and one frame before the clip's end. In a crossfade with the
 * clip before it, the start can make the crossfade longer or shorter, in
 * the rules of Project.clips. The start of a reversed clip shows the end
 * of its part of the file, so there the start stops at the file's end.
 */
export function trimStart(project: Project, id: string, newStart: number): Project {
  const clip = project.clips.find((other) => other.id === id);
  if (!clip) return project;
  const speed = clipSpeed(clip);
  const room = clip.reversed ? mediaFrames(project, clip) - clip.sourceIn - sourceSpan(clip) : clip.sourceIn;
  const { lowest: neighbor, highest } = startLimits(project, clip);
  const lowest = Math.max(neighbor, clip.start - wholeFrames(room / speed));
  const start = Math.min(Math.max(Math.round(newStart), lowest), highest);
  if (start === clip.start) return project;
  const change = start - clip.start;
  const sourceIn = clip.reversed ? clip.sourceIn : Math.max(0, clip.sourceIn + change * speed);
  const trimmed: Clip = { ...clip, start, sourceIn, length: clip.length - change };
  return withClips(project, project.clips.map((other) => other.id === id ? trimmed : other));
}

/** The whole frames in a number of frames; a rounding error just under a whole number counts as that number. */
const wholeFrames = (frames: number) => Math.max(0, Math.floor(frames + 1e-6));

/** The number of frames of a clip's media file, at the project frame rate. */
const mediaFrames = (project: Project, clip: Clip) => {
  const media = project.media.find((item) => item.id === clip.mediaId);
  return media ? mediaLength(media, project.fps) : Infinity;
};

/** Where the start of a clip can go for its neighbors on its layer (see trimStart). */
function startLimits(project: Project, clip: Clip): { lowest: number; highest: number } {
  const clips = layerClips(project, clip.layer);
  const index = clips.indexOf(clip);
  const [twoBefore, before, after] = [clips[index - 2], clips[index - 1], clips[index + 1]];
  const lowest = !before ? 0 : fadeLength(before, clip) > 0 ? Math.max(before.start + 1, twoBefore ? clipEnd(twoBefore) : 0) : clipEnd(before);
  const highest = Math.min(clipEnd(clip) - 1, after && fadeLength(clip, after) > 0 ? after.start - 1 : Infinity);
  return { lowest, highest };
}

/** Where the end of a clip can go for its neighbors on its layer (see trimEnd). */
function endLimits(project: Project, clip: Clip): { lowest: number; highest: number } {
  const clips = layerClips(project, clip.layer);
  const index = clips.indexOf(clip);
  const [before, after, twoAfter] = [clips[index - 1], clips[index + 1], clips[index + 2]];
  const highest = !after ? Infinity : fadeLength(clip, after) > 0 ? Math.min(clipEnd(after) - 1, twoAfter ? twoAfter.start : Infinity) : after.start;
  const lowest = Math.max(clip.start + 1, before && fadeLength(before, clip) > 0 ? clipEnd(before) + 1 : 0);
  return { lowest, highest };
}

/** A clip with a new length for the same part of its media file: its speed changes. */
const stretched = (clip: Clip, start: number, length: number): Clip => {
  const speed = sourceSpan(clip) / length;
  const { speed: _old, ...rest } = clip;
  return Math.abs(speed - 1) < 1e-9 ? { ...rest, start, length } : { ...rest, start, length, speed };
};

/** The lengths that a stretch can give a clip: its speed stays from MIN_SPEED to MAX_SPEED. */
const stretchLengths = (clip: Clip) => ({ shortest: Math.max(1, Math.ceil(sourceSpan(clip) / MAX_SPEED - 1e-6)), longest: wholeFrames(sourceSpan(clip) / MIN_SPEED) });

/**
 * Moves the start of a clip and keeps its end, but the clip keeps all of
 * its part of the media file: a longer clip plays slower, a shorter one
 * faster. The start stops at the clip's neighbors (as in trimStart) and at
 * the slowest and the fastest speed.
 */
export function stretchStart(project: Project, id: string, newStart: number): Project {
  const clip = project.clips.find((other) => other.id === id);
  if (!clip) return project;
  const { lowest, highest } = startLimits(project, clip);
  const { shortest, longest } = stretchLengths(clip);
  const end = clipEnd(clip);
  const start = Math.min(Math.max(Math.round(newStart), lowest, end - longest), highest, end - shortest);
  if (start === clip.start) return project;
  return withClips(project, project.clips.map((other) => other.id === id ? stretched(clip, start, end - start) : other));
}

/** Moves the end of a clip and keeps its start, and changes its speed (see stretchStart). */
export function stretchEnd(project: Project, id: string, newEnd: number): Project {
  const clip = project.clips.find((other) => other.id === id);
  if (!clip) return project;
  const { lowest, highest } = endLimits(project, clip);
  const { shortest, longest } = stretchLengths(clip);
  const end = Math.max(Math.min(Math.round(newEnd), highest, clip.start + longest), lowest, clip.start + shortest);
  if (end === clipEnd(clip)) return project;
  return withClips(project, project.clips.map((other) => other.id === id ? stretched(clip, clip.start, end - clip.start) : other));
}

/** Reverses the clips: each one plays its part of the media file the other way. Doing it again plays them forward. */
export function reverseClips(project: Project, ids: ReadonlySet<string>): Project {
  if (!project.clips.some((clip) => ids.has(clip.id))) return project;
  return { ...project, clips: project.clips.map((clip) => {
    if (!ids.has(clip.id)) return clip;
    const { reversed: _old, ...rest } = clip;
    return clip.reversed ? rest : { ...rest, reversed: true };
  }) };
}

/**
 * Gives the clips their normal speed again. Each clip keeps its start and
 * its part of the media file, so its length changes. If the clip after it
 * leaves too little room, the clip's end stops there (and the clip uses less
 * of its file).
 */
export function normalSpeed(project: Project, ids: ReadonlySet<string>): Project {
  let next = project;
  for (const clip of project.clips.filter((other) => ids.has(other.id) && clipSpeed(other) !== 1)) {
    const current = next.clips.find((other) => other.id === clip.id)!;
    const { highest } = endLimits(next, current);
    const length = Math.max(1, Math.min(Math.round(sourceSpan(current)), highest - current.start));
    const { speed: _old, ...rest } = current;
    /* A reversed clip shows the end of its part first; when the clip gets shorter, that end stays. */
    const sourceIn = current.reversed ? current.sourceIn + sourceSpan(current) - length : current.sourceIn;
    next = withClips(next, next.clips.map((other) => other.id === clip.id ? { ...rest, sourceIn: Math.max(0, sourceIn), length } : other));
  }
  return next;
}

/**
 * Moves the end of a clip to a new frame; the start stays. The end stops
 * at the start of the clip after it on its layer, at the last frame of the
 * media file, and one frame after the clip's start. In a crossfade with the
 * clip after it, the end can make the crossfade longer or shorter, in the
 * rules of Project.clips.
 */
export function trimEnd(project: Project, id: string, newEnd: number): Project {
  const clip = project.clips.find((other) => other.id === id);
  if (!clip) return project;
  const speed = clipSpeed(clip);
  const { lowest, highest } = endLimits(project, clip);
  /* The end of a reversed clip shows the start of its part of the file, so there the end stops at the file's start. */
  const room = clip.reversed ? clip.sourceIn : mediaFrames(project, clip) - clip.sourceIn - sourceSpan(clip);
  const mediaEnd = clipEnd(clip) + wholeFrames(room / speed);
  const end = Math.max(Math.min(Math.round(newEnd), highest, mediaEnd), lowest);
  if (end === clipEnd(clip)) return project;
  const change = end - clipEnd(clip);
  const sourceIn = clip.reversed ? Math.max(0, clip.sourceIn - change * speed) : clip.sourceIn;
  return withClips(project, project.clips.map((other) => other.id === id ? { ...clip, sourceIn, length: end - clip.start } : other));
}

/**
 * Moves the clips of each layer together from frame 0, in their order, with
 * no gaps. The crossfades stay. With "layers", only those layers change.
 */
export function closeGaps(project: Project, layers?: ReadonlySet<number>): Project {
  const next = new Map<number, number>();
  const last = new Map<number, Clip>();
  let changed = false;
  const clips = [...project.clips].sort(byStart).map((clip) => {
    if (layers && !layers.has(clip.layer)) return clip;
    const at = (next.get(clip.layer) ?? 0) - fadeLength(last.get(clip.layer), clip);
    last.set(clip.layer, clip);
    next.set(clip.layer, at + clip.length);
    if (clip.start === at) return clip;
    changed = true;
    return { ...clip, start: at };
  });
  return changed ? withClips(project, clips) : project;
}

/** The speed and the reverse of a clip, only where they are not the normal ones. */
const speedAndReverse = (clip: { speed?: number; reversed?: boolean }) => ({ ...(clip.speed !== undefined && clip.speed !== 1 ? { speed: clip.speed } : {}), ...(clip.reversed ? { reversed: true } : {}) });

/** The selected clips for the clipboard, with positions relative to the first one. */
export function copyClips(project: Project, ids: ReadonlySet<string>): ClipboardClip[] {
  const selected = selectedInOrder(project, ids);
  if (selected.length === 0) return [];
  const origin = selected[0].start;
  return selected.map((clip) => ({ mediaId: clip.mediaId, layer: clip.layer, offset: clip.start - origin, sourceIn: clip.sourceIn, length: clip.length, ...speedAndReverse(clip) }));
}

/**
 * Puts the clipboard clips at a frame, each on the layer it was copied
 * from. On each of those layers, a clip under that frame is split there, and
 * the clips after the frame move right by the room that the pasted clips
 * need. A paste in a crossfade goes before the crossfade's first clip.
 * Clipboard clips of media that the project no longer has are left out.
 * Gives the ids of the new clips too.
 */
export function pasteClips(project: Project, clipboard: readonly ClipboardClip[], at: number): { project: Project; pastedIds: string[] } {
  const usable = clipboard.filter((item) => project.media.some((media) => media.id === item.mediaId));
  if (usable.length === 0) return { project, pastedIds: [] };
  const layers = new Set(usable.map((item) => item.layer));
  /* A paste in a crossfade goes before the crossfade's first clip. */
  let frame = Math.max(0, Math.round(at));
  for (;;) {
    const fade = [...layers].map((layer) => fadeAt(project, frame, layer)).find((found) => found !== null);
    if (!fade) break;
    frame = fade.out.start;
  }
  const base = splitWhere(project, frame, (clip) => layers.has(clip.layer));
  const origin = Math.min(...usable.map((item) => item.offset));
  const shifts = new Map<number, number>();
  for (const layer of layers) {
    const span = Math.max(...usable.filter((item) => item.layer === layer).map((item) => item.offset - origin + item.length));
    const firstLater = Math.min(...base.clips.filter((clip) => clip.layer === layer && clip.start >= frame).map((clip) => clip.start));
    shifts.set(layer, Number.isFinite(firstLater) ? Math.max(0, frame + span - firstLater) : 0);
  }
  const pasted: Clip[] = usable.map((item) => ({ id: newId(), mediaId: item.mediaId, layer: item.layer, start: frame + item.offset - origin, sourceIn: item.sourceIn, length: item.length, ...speedAndReverse(item) }));
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
  if (project.clips.some((clip) => clip.mediaId === mediaId && clip.sourceIn + sourceSpan(clip) > length + 1e-6)) return null;
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
