/** The time marks of the timeline ruler. */

export interface RulerSteps {
  /** Frames between marks with a label. */
  major: number;
  /** Frames between small marks; 0 for none. */
  minor: number;
  /** True when labels need the frame number (the marks are less than 1 s apart). */
  showFrames: boolean;
}

/** The steps in seconds for marks that are 1 s or more apart. */
const SECOND_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];
/** The steps in frames for marks that are less than 1 s apart. */
const FRAME_STEPS = [1, 2, 5, 10];

/** The least distance in pixels between two marks with a label. */
export const MIN_LABEL_SPACING = 90;

/** Chooses the mark steps for a zoom level, so that labels do not touch. */
export function rulerSteps(pixelsPerFrame: number, fps: number): RulerSteps {
  const rate = Math.max(1, Math.round(fps));
  const candidates = [
    ...FRAME_STEPS.filter((step) => step < rate).map((step) => ({ major: step, showFrames: true })),
    ...SECOND_STEPS.map((seconds) => ({ major: seconds * rate, showFrames: false }))
  ];
  const chosen = candidates.find((candidate) => candidate.major * pixelsPerFrame >= MIN_LABEL_SPACING) ?? candidates[candidates.length - 1];
  const minor = [5, 2].map((parts) => chosen.major / parts).find((step) => Number.isInteger(step) && step * pixelsPerFrame >= 6) ?? 0;
  return { ...chosen, minor };
}

const two = (value: number) => String(value).padStart(2, "0");

/** The label of a ruler mark: "m:ss" or "h:mm:ss", with ":ff" when the marks are less than 1 s apart. */
export function rulerLabel(frame: number, fps: number, showFrames: boolean): string {
  const rate = Math.max(1, Math.round(fps));
  const seconds = Math.floor(frame / rate);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const clock = hours > 0 ? `${hours}:${two(minutes)}:${two(seconds % 60)}` : `${minutes}:${two(seconds % 60)}`;
  return showFrames ? `${clock}:${two(frame % rate)}` : clock;
}
