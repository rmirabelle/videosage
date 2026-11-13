import { describe, expect, it } from "vitest";
import { canRedo, canUndo, HISTORY_LIMIT, record, redo, startHistory, undo } from "./history";
import { emptyProject, type Project } from "./model";
import { parseProject, serializeProject } from "./projectFile";
import { findSnap, snapTargets } from "./snap";
import { formatTimecode, mediaLength, secondsToFrames } from "./time";

const sample: Project = {
  version: 1,
  fps: 30,
  width: 1920,
  height: 1080,
  media: [{ id: "a", path: "C:\\Videos\\a.mp4", name: "a.mp4", durationSec: 10, fps: 30, width: 1920, height: 1080, hasSound: true, playable: true }],
  clips: [
    { id: "x", mediaId: "a", start: 10, sourceIn: 0, length: 20 },
    { id: "y", mediaId: "a", start: 50, sourceIn: 20, length: 30 }
  ]
};

describe("time", () => {
  it("writes timecode", () => {
    expect(formatTimecode(0, 30)).toBe("00:00:00:00");
    expect(formatTimecode(29, 30)).toBe("00:00:00:29");
    expect(formatTimecode(30, 30)).toBe("00:00:01:00");
    expect(formatTimecode(30 * 3725 + 7, 30)).toBe("01:02:05:07");
    expect(formatTimecode(24, 23.976)).toBe("00:00:01:00");
  });

  it("converts seconds to whole frames", () => {
    expect(secondsToFrames(1.5, 30)).toBe(45);
    expect(mediaLength({ ...sample.media[0], durationSec: 9.9999999 }, 30)).toBe(300);
    expect(mediaLength({ ...sample.media[0], durationSec: 9.99 }, 30)).toBe(299);
    expect(mediaLength({ ...sample.media[0], durationSec: 0.001 }, 30)).toBe(1);
  });
});

describe("snap", () => {
  it("lists frame 0, the playhead and the ends of clips that are not dragged", () => {
    expect(snapTargets(sample, new Set(["x"]), 42)).toEqual([0, 42, 50, 80]);
    expect(snapTargets(sample, new Set(), null)).toEqual([0, 10, 30, 50, 80]);
  });

  it("takes the nearest target in range", () => {
    /* A dragged clip from 44 to 64: its start is 6 from 50, its end is 16 from 80 and 14 from 50. */
    expect(findSnap([44, 64], [0, 50, 80], 8)).toEqual({ adjust: 6, target: 50 });
    expect(findSnap([44, 64], [0, 50, 80], 5)).toBeNull();
    /* The end is nearer to its target than the start is. */
    expect(findSnap([44, 78], [0, 50, 80], 8)).toEqual({ adjust: 2, target: 80 });
  });
});

describe("history", () => {
  it("undoes and redoes edits", () => {
    let history = startHistory(1);
    history = record(history, 2);
    history = record(history, 3);
    expect(history.present).toBe(3);
    history = undo(history);
    expect(history.present).toBe(2);
    expect(canRedo(history)).toBe(true);
    history = redo(history);
    expect(history.present).toBe(3);
    expect(canRedo(history)).toBe(false);
    expect(redo(history)).toBe(history);
  });

  it("clears the redo steps on a new edit and skips an edit that changes nothing", () => {
    let history = record(record(startHistory("a"), "b"), "c");
    history = record(undo(history), "d");
    expect(history.future).toEqual([]);
    expect(history.past).toEqual(["a", "b"]);
    expect(record(history, "d")).toBe(history);
    expect(canUndo(startHistory("a"))).toBe(false);
  });

  it("keeps a limited number of steps", () => {
    let history = startHistory(0);
    for (let value = 1; value <= HISTORY_LIMIT + 50; value++) history = record(history, value);
    expect(history.past).toHaveLength(HISTORY_LIMIT);
    expect(history.past[0]).toBe(50);
  });
});

describe("project file", () => {
  it("reads back what it wrote", () => {
    expect(parseProject(serializeProject(sample))).toEqual(sample);
    expect(parseProject(serializeProject(emptyProject()))).toEqual(emptyProject());
  });

  it("refuses text that is not a correct project", () => {
    const change = (edit: (data: Record<string, any>) => void) => {
      const data = JSON.parse(serializeProject(sample));
      edit(data);
      return JSON.stringify(data);
    };
    expect(() => parseProject("not json")).toThrow("not a Video Sage project");
    expect(() => parseProject("[]")).toThrow("not a Video Sage project");
    expect(() => parseProject(change((data) => { data.version = 2; }))).toThrow("newer version");
    expect(() => parseProject(change((data) => { data.fps = 0; }))).toThrow("settings");
    expect(() => parseProject(change((data) => { data.clips[0].length = 0; }))).toThrow("clip");
    expect(() => parseProject(change((data) => { data.clips[0].start = 1.5; }))).toThrow("clip");
    expect(() => parseProject(change((data) => { data.clips[0].mediaId = "none"; }))).toThrow("no media file");
    expect(() => parseProject(change((data) => { data.clips[1].start = 20; }))).toThrow("overlap");
    expect(() => parseProject(change((data) => { delete data.media[0].path; }))).toThrow("media entry");
  });

  it("sorts the clips by start", () => {
    const data = JSON.parse(serializeProject(sample));
    data.clips.reverse();
    expect(parseProject(JSON.stringify(data)).clips.map((clip) => clip.id)).toEqual(["x", "y"]);
  });
});
