import { describe, expect, it } from "vitest";
import { clipEnd, type Clip, type MediaItem, type Project } from "./model";
import { addMedia, canJoin, clipAt, closeGaps, copyClips, deleteClips, insertMedia, joinClips, moveClips, pasteClips, relinkMedia, removeMedia, splitAt, trimEnd, trimStart } from "./operations";

/** A 10 s media file: 300 frames at the project's 30 fps. */
const media = (id: string): MediaItem => ({ id, path: `C:\\Videos\\${id}.mp4`, name: `${id}.mp4`, durationSec: 10, fps: 30, width: 1920, height: 1080, hasSound: true, playable: true });

const clip = (id: string, start: number, length: number, sourceIn = 0, mediaId = "a"): Clip => ({ id, mediaId, start, sourceIn, length });

const project = (...clips: Clip[]): Project => ({ version: 1, fps: 30, width: 1920, height: 1080, media: [media("a"), media("b")], clips });

const ids = (...list: string[]) => new Set(list);

/** The rules that every project must keep after every edit. */
function expectValid(result: Project) {
  result.clips.forEach((item, index) => {
    expect(Number.isInteger(item.start) && item.start >= 0).toBe(true);
    expect(Number.isInteger(item.length) && item.length >= 1).toBe(true);
    expect(Number.isInteger(item.sourceIn) && item.sourceIn >= 0).toBe(true);
    if (index > 0) expect(item.start).toBeGreaterThanOrEqual(clipEnd(result.clips[index - 1]));
  });
  expect(new Set(result.clips.map((item) => item.id)).size).toBe(result.clips.length);
}

const layout = (result: Project) => result.clips.map((item) => [item.id, item.start, item.length]);

describe("clipAt", () => {
  it("finds the clip under a frame; the end frame is not in the clip", () => {
    const p = project(clip("x", 10, 20));
    expect(clipAt(p, 10)?.id).toBe("x");
    expect(clipAt(p, 29)?.id).toBe("x");
    expect(clipAt(p, 30)).toBeUndefined();
    expect(clipAt(p, 9)).toBeUndefined();
  });
});

describe("splitAt", () => {
  it("makes two clips that continue in the source", () => {
    const result = splitAt(project(clip("x", 100, 60, 30)), 120);
    expectValid(result);
    expect(result.clips).toHaveLength(2);
    expect(result.clips[0]).toEqual(clip("x", 100, 20, 30));
    expect(result.clips[1]).toMatchObject({ start: 120, length: 40, sourceIn: 50, mediaId: "a" });
  });

  it("does nothing at a clip's start, at its end, or in a gap", () => {
    const p = project(clip("x", 100, 60));
    expect(splitAt(p, 100)).toBe(p);
    expect(splitAt(p, 160)).toBe(p);
    expect(splitAt(p, 50)).toBe(p);
  });
});

describe("joinClips", () => {
  it("is the reverse of a split", () => {
    const start = project(clip("x", 100, 60, 30));
    const split = splitAt(start, 120);
    const all = ids(...split.clips.map((item) => item.id));
    expect(canJoin(split, all)).toBe(true);
    expect(joinClips(split, all)).toEqual(start);
  });

  it("joins three parts", () => {
    const p = project(clip("x", 0, 10, 0), clip("y", 10, 10, 10), clip("z", 20, 10, 20));
    expect(layout(joinClips(p, ids("x", "y", "z")))).toEqual([["x", 0, 30]]);
  });

  it("refuses clips that do not touch, do not continue, or come from different media", () => {
    const gap = project(clip("x", 0, 10, 0), clip("y", 11, 10, 10));
    const jump = project(clip("x", 0, 10, 0), clip("y", 10, 10, 15));
    const other = project(clip("x", 0, 10, 0), clip("y", 10, 10, 10, "b"));
    for (const p of [gap, jump, other]) {
      expect(canJoin(p, ids("x", "y"))).toBe(false);
      expect(joinClips(p, ids("x", "y"))).toBe(p);
    }
    expect(canJoin(gap, ids("x"))).toBe(false);
  });
});

describe("moveClips", () => {
  it("moves a clip into free space", () => {
    const result = moveClips(project(clip("x", 0, 10), clip("y", 50, 10)), ids("x"), 20);
    expect(layout(result)).toEqual([["x", 20, 10], ["y", 50, 10]]);
  });

  it("stops at frame 0", () => {
    expect(layout(moveClips(project(clip("x", 5, 10)), ids("x"), -50))).toEqual([["x", 0, 10]]);
  });

  it("takes the nearest free position when dropped on a clip", () => {
    const p = project(clip("x", 0, 10), clip("y", 50, 20));
    /* Wanted start 45: before y (start 40) is nearer than after y (start 70). */
    expect(layout(moveClips(p, ids("x"), 45))).toEqual([["x", 40, 10], ["y", 50, 20]]);
    /* Wanted start 62: after y is nearer. */
    expect(layout(moveClips(p, ids("x"), 62))).toEqual([["y", 50, 20], ["x", 70, 10]]);
  });

  it("goes past a gap that is too small", () => {
    const p = project(clip("x", 0, 30), clip("y", 100, 20), clip("z", 130, 20));
    /* The 10-frame gap between y and z cannot hold x. */
    const result = moveClips(p, ids("x"), 125);
    expectValid(result);
    expect(layout(result)).toEqual([["y", 100, 20], ["z", 130, 20], ["x", 150, 30]]);
  });

  it("moves a group together and keeps the distance between its clips", () => {
    const p = project(clip("x", 0, 10), clip("y", 20, 10), clip("z", 100, 10));
    const result = moveClips(p, ids("x", "y"), 75);
    expectValid(result);
    /* The group's end (y) stops at z's start. */
    expect(layout(result)).toEqual([["x", 70, 10], ["y", 90, 10], ["z", 100, 10]]);
  });

  it("gives back the same project when nothing moves", () => {
    const p = project(clip("x", 0, 10));
    expect(moveClips(p, ids("x"), 0)).toBe(p);
    expect(moveClips(p, ids("none"), 10)).toBe(p);
  });
});

describe("trim", () => {
  it("moves the start and keeps the end and the picture in place", () => {
    const result = trimStart(project(clip("x", 100, 60, 30)), "x", 110);
    expect(result.clips[0]).toEqual(clip("x", 110, 50, 40));
  });

  it("stops the start at the source start, at the clip before, and before the end", () => {
    expect(trimStart(project(clip("x", 100, 60, 30)), "x", 0).clips[0]).toEqual(clip("x", 70, 90, 0));
    expect(trimStart(project(clip("w", 0, 90), clip("x", 100, 60, 30)), "x", 0).clips[1]).toEqual(clip("x", 90, 70, 20));
    expect(trimStart(project(clip("x", 100, 60, 30)), "x", 500).clips[0]).toEqual(clip("x", 159, 1, 89));
  });

  it("moves the end and stops at the source end, at the next clip, and after the start", () => {
    expect(trimEnd(project(clip("x", 100, 60, 30)), "x", 140).clips[0]).toEqual(clip("x", 100, 40, 30));
    /* The media has 300 frames; from sourceIn 30 the clip can be 270 frames long. */
    expect(trimEnd(project(clip("x", 100, 60, 30)), "x", 9999).clips[0]).toEqual(clip("x", 100, 270, 30));
    expect(trimEnd(project(clip("x", 100, 60, 30), clip("y", 200, 10)), "x", 9999).clips[0]).toEqual(clip("x", 100, 100, 30));
    expect(trimEnd(project(clip("x", 100, 60, 30)), "x", 0).clips[0]).toEqual(clip("x", 100, 1, 30));
  });
});

describe("delete and close gaps", () => {
  it("deletes the selected clips and leaves the others in place", () => {
    const p = project(clip("x", 0, 10), clip("y", 20, 10), clip("z", 40, 10));
    expect(layout(deleteClips(p, ids("y")))).toEqual([["x", 0, 10], ["z", 40, 10]]);
    expect(deleteClips(p, ids("none"))).toBe(p);
  });

  it("closes all gaps from frame 0", () => {
    const p = project(clip("x", 5, 10), clip("y", 20, 10), clip("z", 40, 10));
    expect(layout(closeGaps(p))).toEqual([["x", 0, 10], ["y", 10, 10], ["z", 20, 10]]);
    const packed = closeGaps(p);
    expect(closeGaps(packed)).toBe(packed);
  });
});

describe("copy and paste", () => {
  it("pastes at the playhead and moves later clips right", () => {
    const p = project(clip("x", 0, 10), clip("y", 20, 10), clip("z", 40, 10));
    const clipboard = copyClips(p, ids("x", "y"));
    expect(clipboard.map((item) => [item.offset, item.length])).toEqual([[0, 10], [20, 10]]);
    const { project: result, pastedIds } = pasteClips(p, clipboard, 35);
    expectValid(result);
    expect(pastedIds).toHaveLength(2);
    /* The pasted clips need frames 35 to 65, so z moves from 40 to 65. */
    expect(result.clips.map((item) => [item.start, item.length])).toEqual([[0, 10], [20, 10], [35, 10], [55, 10], [65, 10]]);
  });

  it("splits the clip under the playhead and puts the pasted clip between the parts", () => {
    const p = project(clip("x", 0, 100), clip("y", 200, 10, 0, "b"));
    const { project: result } = pasteClips(p, copyClips(p, ids("y")), 40);
    expectValid(result);
    expect(result.clips.map((item) => [item.mediaId, item.start, item.length, item.sourceIn])).toEqual([
      ["a", 0, 40, 0], ["b", 40, 10, 0], ["a", 50, 60, 40], ["b", 210, 10, 0]
    ]);
  });

  it("does not move later clips when the gap is large enough", () => {
    const p = project(clip("x", 0, 10), clip("y", 100, 10));
    const { project: result } = pasteClips(p, copyClips(p, ids("x")), 20);
    expect(result.clips.map((item) => [item.start, item.length])).toEqual([[0, 10], [20, 10], [100, 10]]);
  });

  it("leaves out clips of media that the project no longer has", () => {
    const p = project(clip("x", 0, 10));
    const clipboard = copyClips(p, ids("x"));
    const without = removeMedia(p, "a");
    expect(without.clips).toHaveLength(0);
    const { project: result, pastedIds } = pasteClips(without, clipboard, 0);
    expect(result).toBe(without);
    expect(pastedIds).toEqual([]);
  });
});

describe("insertMedia", () => {
  it("adds a full-length clip at the nearest free position", () => {
    const first = insertMedia(project(), "a", 0);
    expect(first.project.clips.map((item) => [item.start, item.length, item.sourceIn])).toEqual([[0, 300, 0]]);
    const second = insertMedia(first.project, "b", 200);
    expectValid(second.project);
    expect(second.project.clips.map((item) => [item.mediaId, item.start])).toEqual([["a", 0], ["b", 300]]);
    expect(insertMedia(project(), "none", 0).clipId).toBeNull();
  });
});

describe("addMedia", () => {
  it("sets the project frame rate and size from the first file only", () => {
    const empty: Project = { version: 1, fps: 30, width: 1920, height: 1080, media: [], clips: [] };
    const first = addMedia(empty, { ...media("a"), fps: 24000 / 1001, width: 1280, height: 720 });
    expect([first.fps, first.width, first.height]).toEqual([23.976, 1280, 720]);
    const second = addMedia(first, { ...media("b"), fps: 60, width: 3840, height: 2160 });
    expect([second.fps, second.width, second.height]).toEqual([23.976, 1280, 720]);
    expect(second.media).toHaveLength(2);
  });

  it("does not add the same file two times", () => {
    const p = project();
    expect(addMedia(p, { ...media("a"), id: "other" })).toBe(p);
  });
});

describe("relinkMedia", () => {
  const found = (seconds: number, path = "D:\\Moved\\a2.mp4"): MediaItem => ({ ...media("new"), path, name: "a2.mp4", durationSec: seconds });

  it("points the item at the new file and keeps its id and clips", () => {
    const p = project(clip("x", 0, 100));
    const result = relinkMedia(p, "a", found(10))!;
    expect(result.media[0]).toMatchObject({ id: "a", path: "D:\\Moved\\a2.mp4", name: "a2.mp4" });
    expect(result.clips).toBe(p.clips);
  });

  it("gives null when the new file is too short for a clip", () => {
    expect(relinkMedia(project(clip("x", 0, 100, 150)), "a", found(5))).toBeNull();
  });

  it("gives null when the project already has the new file", () => {
    expect(relinkMedia(project(), "a", found(10, media("b").path))).toBeNull();
  });
});
