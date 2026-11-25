import { describe, expect, it } from "vitest";
import { exportLayers, exportSegments, sizeForHeight } from "./export";
import type { Clip, MediaItem, Project } from "./model";

const media = (id: string, hasSound = true): MediaItem => ({ id, path: `C:\\Videos\\${id}.mp4`, name: `${id}.mp4`, durationSec: 10, fps: 30, width: 1920, height: 1080, hasSound, playable: true });

const clip = (id: string, start: number, length: number, sourceIn = 0, mediaId = "a", layer = 0): Clip => ({ id, mediaId, layer, start, sourceIn, length });

const project = (...clips: Clip[]): Project => ({ version: 2, fps: 30, width: 1920, height: 1080, media: [media("a"), media("b", false)], clips });

describe("exportSegments", () => {
  it("gives the clips and the gaps in the sequence of the timeline", () => {
    const segments = exportSegments(project(clip("y", 100, 60, 0, "b"), clip("x", 30, 45, 15)), 30);
    expect(segments).toEqual([
      { path: null, startSec: 0, frames: 30, hasSound: false, fadeIn: 0 },
      { path: "C:\\Videos\\a.mp4", startSec: 0.5, frames: 45, hasSound: true, fadeIn: 0 },
      { path: null, startSec: 0, frames: 25, hasSound: false, fadeIn: 0 },
      { path: "C:\\Videos\\b.mp4", startSec: 0, frames: 60, hasSound: false, fadeIn: 0 }
    ]);
  });

  it("joins a clip that continues the clip before it", () => {
    const segments = exportSegments(project(clip("x", 0, 40), clip("y", 40, 20, 40), clip("z", 60, 10, 90)), 30);
    expect(segments.map((segment) => [segment.startSec, segment.frames])).toEqual([[0, 60], [3, 10]]);
  });

  it("keeps the total length at a different frame rate", () => {
    const p = project(clip("x", 0, 7), clip("y", 7, 7, 50), clip("z", 20, 7, 100));
    const total = (fps: number) => exportSegments(p, fps).reduce((sum, segment) => sum + segment.frames, 0);
    expect(total(60)).toBe(54);
    expect(total(24)).toBe(Math.round((27 * 24) / 30));
    expect(total(25)).toBe(Math.round((27 * 25) / 30));
  });

  it("gives no segments for an empty timeline", () => {
    expect(exportSegments(project(), 30)).toEqual([]);
  });

  it("gives a crossfade as the overlap of a clip with the clip before it", () => {
    /* x (0 to 100) fades into y (80 to 180), and the timeline ends at 200. */
    const segments = exportSegments(project(clip("x", 0, 100), clip("y", 80, 100, 0, "b")), 30, 0, 200);
    expect(segments.map((segment) => [segment.path !== null, segment.frames, segment.fadeIn])).toEqual([[true, 100, 0], [true, 100, 20], [false, 20, 0]]);
    const total = segments.reduce((sum, segment) => sum + segment.frames - segment.fadeIn, 0);
    expect(total).toBe(200);
    /* At 60 fps, the crossfade is 40 export frames. */
    expect(exportSegments(project(clip("x", 0, 100), clip("y", 80, 100, 0, "b")), 60)[1].fadeIn).toBe(40);
  });
});

describe("exportLayers", () => {
  it("gives each layer as long as the timeline, from the bottom up", () => {
    const layers = exportLayers(project(clip("x", 0, 60), clip("y", 20, 10, 0, "b", 1)), 30);
    expect(layers.map((layer) => layer.map((segment) => [segment.path !== null, segment.frames]))).toEqual([
      [[true, 60]],
      [[false, 20], [true, 10], [false, 30]]
    ]);
  });

  it("leaves out an empty layer", () => {
    expect(exportLayers(project(clip("x", 0, 60, 0, "a", 2)), 30)).toHaveLength(1);
    expect(exportLayers(project(), 30)).toEqual([]);
  });
});

describe("sizeForHeight", () => {
  it("keeps the shape of the project and gives even numbers", () => {
    expect(sizeForHeight(project(), 720)).toEqual({ width: 1280, height: 720 });
    expect(sizeForHeight({ ...project(), width: 1080, height: 1920 }, 480)).toEqual({ width: 270, height: 480 });
    expect(sizeForHeight({ ...project(), width: 1000, height: 333 }, 333).height % 2).toBe(0);
  });
});
