import { clipEnd, type Project } from "./model";

/**
 * The frames that a dragged clip or a trimmed end can snap to: frame 0, the
 * playhead, and the two ends of each clip that is not in the drag.
 */
export function snapTargets(project: Project, draggedIds: ReadonlySet<string>, playhead: number | null): number[] {
  const targets = new Set<number>([0]);
  if (playhead !== null) targets.add(playhead);
  for (const clip of project.clips) {
    if (draggedIds.has(clip.id)) continue;
    targets.add(clip.start);
    targets.add(clipEnd(clip));
  }
  return [...targets].sort((a, b) => a - b);
}

export interface Snap {
  /** The frames to add to the drag so that an edge is exactly on the target. */
  adjust: number;
  /** The frame that the edge snaps to, for the snap line. */
  target: number;
}

/**
 * The nearest snap for moving edges (the starts and ends of dragged clips,
 * or one trimmed end), if a target is in range. "range" is in frames; the
 * caller makes it from a distance in pixels at the current zoom.
 */
export function findSnap(edges: readonly number[], targets: readonly number[], range: number): Snap | null {
  let best: Snap | null = null;
  for (const edge of edges) {
    for (const target of targets) {
      const adjust = target - edge;
      if (Math.abs(adjust) > range) continue;
      if (best === null || Math.abs(adjust) < Math.abs(best.adjust)) best = { adjust, target };
    }
  }
  return best;
}
