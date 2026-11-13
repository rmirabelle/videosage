import { describe, expect, it } from "vitest";
import { MIN_LABEL_SPACING, rulerLabel, rulerSteps } from "./ruler";

describe("ruler", () => {
  it("keeps labels apart at each zoom level", () => {
    for (const zoom of [0.002, 0.01, 0.05, 0.3, 2, 8, 30]) {
      const steps = rulerSteps(zoom, 30);
      /* At the smallest zoom the longest step (4 hours) is the limit. */
      if (zoom > 0.002) expect(steps.major * zoom).toBeGreaterThanOrEqual(MIN_LABEL_SPACING);
      if (steps.minor) expect(steps.major % steps.minor).toBe(0);
    }
  });

  it("uses frames when zoomed in and seconds when zoomed out", () => {
    expect(rulerSteps(30, 30)).toEqual({ major: 5, minor: 1, showFrames: true });
    expect(rulerSteps(2, 30)).toEqual({ major: 60, minor: 12, showFrames: false });
    expect(rulerSteps(0.05, 30)).toEqual({ major: 1800, minor: 360, showFrames: false });
  });

  it("writes labels", () => {
    expect(rulerLabel(0, 30, false)).toBe("0:00");
    expect(rulerLabel(30 * 75, 30, false)).toBe("1:15");
    expect(rulerLabel(30 * 3725, 30, false)).toBe("1:02:05");
    expect(rulerLabel(45, 30, true)).toBe("0:01:15");
    expect(rulerLabel(24 * 10, 23.976, false)).toBe("0:10");
  });
});
