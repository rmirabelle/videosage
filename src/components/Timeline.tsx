import { ArrowsOutLineHorizontal, MagnifyingGlassMinus, MagnifyingGlassPlus, Magnet, Scissors } from "@phosphor-icons/react";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clipEnd, projectEnd, type Clip, type MediaItem, type Project } from "../editor/model";
import { moveClips, trimEnd, trimStart } from "../editor/operations";
import { rulerLabel, rulerSteps } from "../editor/ruler";
import { findSnap, snapTargets } from "../editor/snap";
import { formatTimecode } from "../editor/time";
import { frameUrl } from "../lib/media";

/** The zoom limits, in pixels for one frame. */
const MIN_ZOOM = 0.002;
const MAX_ZOOM = 30;
const DEFAULT_ZOOM = 2;
/** One zoom step of a button or a key. */
const ZOOM_STEP = 1.5;
/** The height of the picture strip in a clip, in pixels (see .clip-strip in index.css). */
const STRIP_HEIGHT = 46;
/** A pointer must move this many pixels before a press becomes a drag. */
const DRAG_THRESHOLD = 4;
/** A dragged edge snaps to a target that is this many pixels away or less. */
const SNAP_PIXELS = 9;
/** While a drag is this near to a side of the view, the view scrolls. */
const EDGE_SCROLL_ZONE = 36;
const EDGE_SCROLL_STEP = 18;

export interface TimelineHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  zoomToFit: () => void;
}

interface Props {
  project: Project;
  playhead: number;
  onPlayhead: (frame: number) => void;
  selection: ReadonlySet<string>;
  onSelect: (ids: Set<string>) => void;
  /** Records the result of a drag (a move or a trim) as one undo step. */
  onCommit: (project: Project) => void;
  snapping: boolean;
  onToggleSnapping: () => void;
  /** Splits the clip under the playhead; null when no clip can be split there. */
  onSplit: (() => void) | null;
}

/** What a press on the track does until the pointer is released. */
type Press =
  | { kind: "box"; startX: number; startFrame: number; dragging: boolean; before: ReadonlySet<string> }
  | {
    kind: "move" | "trimStart" | "trimEnd";
    clipId: string;
    startX: number;
    startFrame: number;
    dragging: boolean;
    ids: ReadonlySet<string>;
    /** True when a click with no drag must select only the pressed clip. */
    selectOnClick: boolean;
  };

/** A colour for the clips of one media file, made from its id, so each file keeps its colour. */
function mediaHue(mediaId: string): number {
  let hash = 0;
  for (let index = 0; index < mediaId.length; index++) hash = (hash * 31 + mediaId.charCodeAt(index)) >>> 0;
  return hash % 360;
}

/** One picture of the strip. It keeps its last picture until the next one is ready, so a zoom does not flash. */
function StripTile({ path, atSec, left, width }: { path: string; atSec: number; left: number; width: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    frameUrl(path, atSec).then((made) => { if (!cancelled) setUrl(made); }).catch(() => {});
    return () => { cancelled = true; };
  }, [path, atSec]);
  return <div className="clip-tile" style={{ left, width, backgroundImage: url ? `url(${url})` : undefined }} />;
}

interface ClipViewProps {
  clip: Clip;
  media: MediaItem | undefined;
  fps: number;
  zoom: number;
  selected: boolean;
  /** True while a drag moves or trims this clip. */
  dragging: boolean;
  /** The part of the timeline that is on screen, in pixels from frame 0. */
  viewLeft: number;
  viewRight: number;
}

/** One clip on the track: a name and a strip of pictures from its part of the media file. */
const ClipView = memo(function ClipView({ clip, media, fps, zoom, selected, dragging, viewLeft, viewRight }: ClipViewProps) {
  const left = clip.start * zoom;
  const width = clip.length * zoom;
  const tiles: { index: number; atSec: number }[] = [];
  let tileWidth = 80;
  if (media && media.height > 0) {
    tileWidth = Math.min(160, Math.max(30, Math.round(STRIP_HEIGHT * media.width / media.height)));
    /**
     * Tile times go to a grid of 1, 2, 4, 8 ... seconds (or parts of a
     * second), so a small zoom change or a trim uses the same pictures again.
     */
    const tileSeconds = tileWidth / zoom / fps;
    const grid = 2 ** Math.ceil(Math.log2(tileSeconds));
    const first = Math.max(0, Math.floor((viewLeft - left) / tileWidth) - 1);
    const last = Math.min(Math.ceil(width / tileWidth) - 1, Math.floor((viewRight - left) / tileWidth) + 1, first + 120);
    for (let index = first; index <= last; index++) {
      const seconds = (clip.sourceIn + (index * tileWidth) / zoom) / fps;
      const atSec = Math.max(0, Math.min(Math.floor(seconds / grid) * grid, media.durationSec - 0.1));
      tiles.push({ index, atSec });
    }
  }
  return (
    <div
      className={`clip ${selected ? "selected" : ""} ${dragging ? "dragging" : ""}`}
      data-clip-id={clip.id}
      style={{ left, width, "--clip-hue": mediaHue(clip.mediaId) } as React.CSSProperties}
    >
      <div className="clip-name">{media?.name ?? "Missing media"}</div>
      <div className="clip-strip">
        {media && tiles.map((tile) => <StripTile key={tile.index} path={media.path} atSec={tile.atSec} left={tile.index * tileWidth} width={tileWidth} />)}
      </div>
      {/* The two ends: a drag on one trims the clip. */}
      <div className="clip-handle start" data-handle="start" />
      <div className="clip-handle end" data-handle="end" />
    </div>
  );
});

/**
 * The timeline: a time ruler, one video track with the clips, and the
 * playhead. The wheel scrolls; Ctrl + wheel zooms at the pointer. A press on
 * the ruler moves the playhead. A click on a clip selects it (Ctrl + click
 * adds or removes it); a drag on the empty track selects the clips in a box.
 * A drag on a clip moves the selected clips; a drag on a clip's end trims it.
 * With snapping on, a dragged edge snaps to clip ends, the playhead and 0.
 */
export const Timeline = forwardRef<TimelineHandle, Props>(function Timeline({ project: savedProject, playhead, onPlayhead, selection, onSelect, onCommit, snapping, onToggleSnapping, onSplit }, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [viewWidth, setViewWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [box, setBox] = useState<{ from: number; to: number } | null>(null);
  /** The project as a drag in progress makes it; it shows in place of the saved project until release. */
  const [draft, setDraft] = useState<Project | null>(null);
  const draftRef = useRef<Project | null>(null);
  draftRef.current = draft;
  const [draggingIds, setDraggingIds] = useState<ReadonlySet<string> | null>(null);
  /** The frame of the snap line, while a dragged edge is snapped. */
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const project = draft ?? savedProject;
  /** After a zoom, the frame that must stay under a point of the view (pixels from the view's left edge). */
  const anchor = useRef<{ frame: number; viewX: number } | null>(null);

  const end = projectEnd(project);
  const mediaById = useMemo(() => new Map(project.media.map((item) => [item.id, item])), [project.media]);
  /* Room after the last clip, so a clip can be put after the end. */
  const contentWidth = Math.max(viewWidth, end * zoom + viewWidth * 0.5);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewWidth(element.clientWidth));
    observer.observe(element);
    setViewWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  /** Changes the zoom and keeps one frame at the same place in the view. Without a place, the playhead stays if it is in view, else the view's center. */
  const zoomTo = useCallback((next: number, viewX?: number) => {
    const element = scrollRef.current;
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    if (element) {
      let x = viewX;
      if (x === undefined) {
        const playheadX = playhead * zoom - element.scrollLeft;
        x = playheadX >= 0 && playheadX <= element.clientWidth ? playheadX : element.clientWidth / 2;
      }
      anchor.current = { frame: (element.scrollLeft + x) / zoom, viewX: x };
    }
    setZoom(clamped);
  }, [playhead, zoom]);

  const zoomToFit = useCallback(() => {
    const element = scrollRef.current;
    if (!element || end <= 0) return;
    anchor.current = { frame: 0, viewX: 0 };
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (element.clientWidth - 48) / end)));
  }, [end]);

  useImperativeHandle(ref, () => ({
    zoomIn: () => zoomTo(zoom * ZOOM_STEP),
    zoomOut: () => zoomTo(zoom / ZOOM_STEP),
    zoomToFit
  }), [zoom, zoomTo, zoomToFit]);

  /* After the zoom shows, scroll so that the anchor frame is at its place again. */
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !anchor.current) return;
    element.scrollLeft = anchor.current.frame * zoom - anchor.current.viewX;
    anchor.current = null;
    setScrollLeft(element.scrollLeft);
  }, [zoom]);

  /* The first clips on an empty track show whole. */
  const hadClips = useRef(false);
  useEffect(() => {
    const hasClips = project.clips.length > 0;
    if (hasClips && !hadClips.current) zoomToFit();
    hadClips.current = hasClips;
  }, [project.clips.length, zoomToFit]);

  /* The wheel listener is not passive, so Ctrl + wheel can stop the page zoom. */
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey) {
        zoomTo(zoom * Math.exp(-event.deltaY * 0.0022), event.clientX - element.getBoundingClientRect().left);
      } else {
        element.scrollLeft += event.deltaX !== 0 ? event.deltaX : event.deltaY;
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoom, zoomTo]);

  /** The frame under a pointer position; less than 0 at the left of frame 0. */
  const rawFrameAt = useCallback((clientX: number) => {
    const content = contentRef.current;
    if (!content) return 0;
    return (clientX - content.getBoundingClientRect().left) / zoom;
  }, [zoom]);
  const frameAt = useCallback((clientX: number) => Math.max(0, rawFrameAt(clientX)), [rawFrameAt]);

  /* A press on the ruler moves the playhead, and it follows the pointer until release. */
  const onRulerPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    onPlayhead(Math.round(frameAt(event.clientX)));
  };
  const onRulerPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) onPlayhead(Math.round(frameAt(event.clientX)));
  };

  /**
   * A press on the track. On a clip: select it (Ctrl adds or removes it),
   * and a drag then moves the selected clips, or trims the clip when the
   * press is on one of its ends. On the empty track: a click clears the
   * selection and moves the playhead; a drag selects the clips in a box.
   */
  const press = useRef<Press | null>(null);

  const endDrag = useCallback(() => {
    press.current = null;
    setBox(null);
    setDraft(null);
    setDraggingIds(null);
    setSnapLine(null);
  }, []);

  /* Esc stops a drag and puts the clips back. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !press.current?.dragging) return;
      event.stopPropagation();
      event.preventDefault();
      endDrag();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [endDrag]);

  const onTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    const clipId = target.closest<HTMLElement>("[data-clip-id]")?.dataset.clipId;
    const startX = event.clientX;
    if (!clipId) {
      event.currentTarget.setPointerCapture(event.pointerId);
      press.current = { kind: "box", startX, startFrame: frameAt(startX), dragging: false, before: event.ctrlKey ? selection : new Set() };
      return;
    }
    if (event.ctrlKey) {
      const next = new Set(selection);
      if (!next.delete(clipId)) next.add(clipId);
      onSelect(next);
      return;
    }
    const handle = target.dataset.handle;
    let ids = selection;
    let selectOnClick = false;
    if (handle || !selection.has(clipId)) {
      ids = new Set([clipId]);
      onSelect(new Set(ids));
    } else if (selection.size > 1) {
      selectOnClick = true;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    press.current = {
      kind: handle === "start" ? "trimStart" : handle === "end" ? "trimEnd" : "move",
      clipId,
      startX,
      startFrame: rawFrameAt(startX),
      dragging: false,
      ids,
      selectOnClick
    };
  };

  const onTrackPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = press.current;
    if (!current) return;
    if (!current.dragging && Math.abs(event.clientX - current.startX) < DRAG_THRESHOLD) return;
    current.dragging = true;

    /* Near a side of the view, the view scrolls, so a drag can go past what is on screen. */
    const scroller = scrollRef.current;
    if (scroller) {
      const bounds = scroller.getBoundingClientRect();
      if (event.clientX < bounds.left + EDGE_SCROLL_ZONE) scroller.scrollLeft -= EDGE_SCROLL_STEP;
      else if (event.clientX > bounds.right - EDGE_SCROLL_ZONE) scroller.scrollLeft += EDGE_SCROLL_STEP;
    }

    if (current.kind === "box") {
      const from = Math.min(current.startFrame, frameAt(event.clientX));
      const to = Math.max(current.startFrame, frameAt(event.clientX));
      setBox({ from, to });
      const next = new Set(current.before);
      for (const clip of savedProject.clips) {
        if (clip.start < to && clipEnd(clip) > from) next.add(clip.id);
      }
      onSelect(next);
      return;
    }

    const delta = Math.round(rawFrameAt(event.clientX) - current.startFrame);
    const range = SNAP_PIXELS / zoom;
    const targets = snapping ? snapTargets(savedProject, current.ids, playhead) : [];
    const pressed = savedProject.clips.find((clip) => clip.id === current.clipId);
    if (!pressed) return;
    let next = savedProject;
    let line: number | null = null;
    if (current.kind === "move") {
      const moving = savedProject.clips.filter((clip) => current.ids.has(clip.id));
      const snap = findSnap(moving.flatMap((clip) => [clip.start + delta, clipEnd(clip) + delta]), targets, range);
      const wanted = delta + (snap?.adjust ?? 0);
      next = moveClips(savedProject, current.ids, wanted);
      /* The line shows only when the clips are really at the snapped place (a full place moves them on). */
      const moved = next.clips.find((clip) => clip.id === pressed.id);
      if (snap && moved && moved.start === pressed.start + wanted) line = snap.target;
    } else if (current.kind === "trimStart") {
      const snap = findSnap([pressed.start + delta], targets, range);
      const wanted = pressed.start + delta + (snap?.adjust ?? 0);
      next = trimStart(savedProject, pressed.id, wanted);
      if (snap && next.clips.find((clip) => clip.id === pressed.id)?.start === wanted) line = snap.target;
    } else {
      const snap = findSnap([clipEnd(pressed) + delta], targets, range);
      const wanted = clipEnd(pressed) + delta + (snap?.adjust ?? 0);
      next = trimEnd(savedProject, pressed.id, wanted);
      const trimmed = next.clips.find((clip) => clip.id === pressed.id);
      if (snap && trimmed && clipEnd(trimmed) === wanted) line = snap.target;
    }
    setDraft(next === savedProject ? null : next);
    setDraggingIds(current.ids);
    setSnapLine(line);
  };

  const onTrackPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = press.current;
    if (!current) return;
    const result = draftRef.current;
    endDrag();
    if (current.kind === "box") {
      if (!current.dragging) {
        if (!event.ctrlKey) onSelect(new Set());
        onPlayhead(Math.round(current.startFrame));
      }
    } else if (!current.dragging) {
      if (current.selectOnClick) onSelect(new Set([current.clipId]));
    } else if (result) {
      onCommit(result);
    }
  };

  /* The ruler marks that are on screen. */
  const steps = rulerSteps(zoom, project.fps);
  const marks: { frame: number; major: boolean }[] = [];
  const markStep = steps.minor || steps.major;
  const firstMark = Math.floor(scrollLeft / zoom / markStep) * markStep;
  const lastMark = (scrollLeft + viewWidth) / zoom;
  for (let frame = firstMark; frame <= lastMark && marks.length < 600; frame += markStep) {
    marks.push({ frame, major: frame % steps.major === 0 });
  }

  /* The clip pictures load for the part on screen, with a margin of half a view at each side. */
  const viewLeft = scrollLeft - viewWidth * 0.5;
  const viewRight = scrollLeft + viewWidth * 1.5;

  return (
    <section className="panel timeline-panel" aria-label="Timeline">
      <header className="panel-header">
        <h2>Timeline</h2>
        <div className="timeline-timecode" title="Playhead position / timeline length">
          <strong>{formatTimecode(playhead, project.fps)}</strong> / {formatTimecode(end, project.fps)}
        </div>
        <div className="timeline-tools">
          <button onClick={() => onSplit?.()} disabled={!onSplit} title="Split the clip at the playhead (S)" aria-label="Split at playhead"><Scissors size={15} /></button>
          <button className={snapping ? "on" : ""} onClick={onToggleSnapping} aria-pressed={snapping} title={snapping ? "Snapping is on (N)" : "Snapping is off (N)"} aria-label="Snapping"><Magnet size={15} /></button>
          <span className="timeline-tools-gap" />
          <button onClick={() => zoomTo(zoom / ZOOM_STEP)} title="Zoom out (Ctrl+-)" aria-label="Zoom out"><MagnifyingGlassMinus size={15} /></button>
          <button onClick={() => zoomTo(zoom * ZOOM_STEP)} title="Zoom in (Ctrl+=)" aria-label="Zoom in"><MagnifyingGlassPlus size={15} /></button>
          <button onClick={zoomToFit} disabled={end <= 0} title="Zoom to fit (Ctrl+0)" aria-label="Zoom to fit"><ArrowsOutLineHorizontal size={15} /></button>
        </div>
      </header>
      <div className="timeline-scroll" ref={scrollRef} onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}>
        <div className="timeline-content" ref={contentRef} style={{ width: contentWidth }}>
          <div className="timeline-ruler" onPointerDown={onRulerPointerDown} onPointerMove={onRulerPointerMove}>
            {marks.map((mark) => (
              <div key={mark.frame} className={mark.major ? "ruler-mark major" : "ruler-mark"} style={{ left: mark.frame * zoom }}>
                {mark.major && <span>{rulerLabel(mark.frame, project.fps, steps.showFrames)}</span>}
              </div>
            ))}
          </div>
          <div className="timeline-track" onPointerDown={onTrackPointerDown} onPointerMove={onTrackPointerMove} onPointerUp={onTrackPointerUp} onPointerCancel={onTrackPointerUp}>
            {project.clips.length === 0 && <p className="timeline-empty">Double-click a video in the Media list to put it on the timeline.</p>}
            {project.clips.map((clip) => (
              <ClipView
                key={clip.id}
                clip={clip}
                media={mediaById.get(clip.mediaId)}
                fps={project.fps}
                zoom={zoom}
                selected={selection.has(clip.id)}
                dragging={draggingIds?.has(clip.id) ?? false}
                viewLeft={viewLeft}
                viewRight={viewRight}
              />
            ))}
            {box && <div className="timeline-box" style={{ left: box.from * zoom, width: (box.to - box.from) * zoom }} />}
          </div>
          {snapLine !== null && <div className="timeline-snap-line" style={{ left: snapLine * zoom }} />}
          <div className="timeline-playhead" style={{ left: playhead * zoom }} />
        </div>
      </div>
    </section>
  );
});
