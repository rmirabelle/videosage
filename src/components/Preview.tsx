import { CaretLeft, CaretRight, Pause, Play, Repeat, SkipBack, SkipForward, SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { clipEnd, layerCount, projectEnd, type Clip, type Project } from "../editor/model";
import { clipAt, topClipAt } from "../editor/operations";
import { formatTimecode } from "../editor/time";

type Slot = 0 | 1;

/** The part of the timeline that play repeats: from start to the frame before end. */
export interface LoopRange {
  start: number;
  end: number;
}

interface Props {
  project: Project;
  playhead: number;
  /** The URL to play each media file, by media id. A file with no URL is not ready (its preview copy is not made yet). */
  sources: ReadonlyMap<string, string>;
  playing: boolean;
  onPlaying: (playing: boolean) => void;
  /** The player tells where it is during play. */
  onPlayerFrame: (frame: number) => void;
  /** The user moves the playhead (the transport buttons). */
  onSeek: (frame: number) => void;
  /** Goes up by one each time the user moves the playhead, so the player can follow during play. */
  seekCount: number;
  /** With a range, play repeats that range; null plays to the end and stops. */
  loopRange: LoopRange | null;
  loop: boolean;
  onToggleLoop: () => void;
}

/** What the player keeps for the two <video> elements of one layer. */
interface Lane {
  /** The URL that each element has now. */
  loaded: [string | null, string | null];
  /** A seek that waits for the element to finish the seek before it. */
  waitingSeek: [number | null, number | null];
  /** True after an element could not play its file. */
  failed: [boolean, boolean];
  /** The element that shows the layer's clip now. */
  active: Slot;
}

const newLane = (): Lane => ({ loaded: [null, null], waitingSeek: [null, null], failed: [false, false], active: 0 });

/** What one layer plays now, during play. */
interface Playing {
  /** The clip under the clock; null in a gap. */
  clip: Clip | null;
  /** False when the clip's file cannot play now (no preview copy yet, or an error). */
  ready: boolean;
  /** The clip that the other element holds ready, at its first frame. */
  nextId: string | null;
}

/** A video that is this far from the clock, in seconds, seeks to the clock. */
const DRIFT_LIMIT = 0.15;

/**
 * The preview: it shows the frame under the playhead, and plays the
 * timeline. Each layer has two <video> elements. One plays the layer's
 * current clip; the other holds the next clip, loaded and at its first
 * frame, so a cut does not wait for a load. A higher layer shows on top, and
 * its gaps and bars are transparent. The sound of all layers plays.
 *
 * During play, the video of the highest layer that plays a clip moves the
 * clock, so picture and sound stay together; the videos of other layers
 * seek when they are too far from it. In a gap on all layers, a wall clock
 * moves it, and the picture is black.
 */
export function Preview({ project, playhead, sources, playing, onPlaying, onPlayerFrame, onSeek, seekCount, loopRange, loop, onToggleLoop }: Props) {
  /** The two video elements of each layer, by layer. */
  const videos = useRef<(HTMLVideoElement | null)[][]>([]);
  const lanes = useRef<Lane[]>([]);
  const lane = (layer: number) => (lanes.current[layer] ??= newLane());
  const element = (layer: number, slot: Slot) => videos.current[layer]?.[slot] ?? null;
  const layers = layerCount(project);
  /** The element that shows on each layer, or null for none. */
  const [shown, setShown] = useState<(Slot | null)[]>([]);
  const shownRef = useRef(shown);
  const [notReady, setNotReady] = useState(false);
  const [muted, setMuted] = useState(false);
  const latest = useRef({ project, playhead, sources, onPlaying, onPlayerFrame, seekCount, loopRange });
  latest.current = { project, playhead, sources, onPlaying, onPlayerFrame, seekCount, loopRange };

  /** Shows one element of a layer, or none. A change that changes nothing makes no render. */
  const show = (layer: number, slot: Slot | null) => {
    if ((shownRef.current[layer] ?? null) === slot) return;
    const next = [...shownRef.current];
    next[layer] = slot;
    shownRef.current = next;
    setShown(next);
  };

  const setSource = (layer: number, slot: Slot, url: string) => {
    const state = lane(layer);
    const video = element(layer, slot);
    if (!video || state.loaded[slot] === url) return;
    state.loaded[slot] = url;
    state.waitingSeek[slot] = null;
    state.failed[slot] = false;
    video.src = url;
  };

  /** Seeks an element. While it does a seek, only the newest wanted time is kept, so a fast scrub does not queue up seeks. */
  const seek = (layer: number, slot: Slot, seconds: number) => {
    const video = element(layer, slot);
    if (!video) return;
    if (video.seeking) lane(layer).waitingSeek[slot] = seconds;
    else if (Math.abs(video.currentTime - seconds) > 0.0005) video.currentTime = seconds;
  };
  const onSeeked = (layer: number, slot: Slot) => {
    const state = lane(layer);
    const seconds = state.waitingSeek[slot];
    const video = element(layer, slot);
    if (seconds === null || !video) return;
    state.waitingSeek[slot] = null;
    video.currentTime = seconds;
  };

  const pauseLayer = (layer: number) => {
    element(layer, 0)?.pause();
    element(layer, 1)?.pause();
  };
  const pauseAll = () => videos.current.forEach((_, layer) => pauseLayer(layer));

  /* Not playing: each layer shows its frame under the playhead. */
  useEffect(() => {
    if (playing) return;
    /* At the end of the timeline, the last frame shows. */
    const timelineEnd = projectEnd(project);
    const frame = timelineEnd > 0 && playhead >= timelineEnd ? timelineEnd - 1 : playhead;
    for (let layer = 0; layer < videos.current.length; layer++) {
      const clip = layer < layers ? clipAt(project, frame, layer) : undefined;
      const url = clip && sources.get(clip.mediaId);
      if (!clip || !url) {
        show(layer, null);
        continue;
      }
      const slot = lane(layer).active;
      setSource(layer, slot, url);
      /* The middle of the frame, so a rounding error cannot show the frame before. */
      seek(layer, slot, (clip.sourceIn + frame - clip.start + 0.5) / project.fps);
      show(layer, slot);
    }
    const top = topClipAt(project, frame);
    setNotReady(Boolean(top && !sources.get(top.mediaId)));
  }, [playing, project, playhead, sources, layers]);

  /* Playing: the loop below runs on each screen frame until play stops. */
  useEffect(() => {
    if (!playing) return;
    let request = 0;
    let reported = -1;
    let seenProject = latest.current.project;
    let seenSeek = latest.current.seekCount;
    /** The clock: the frame at a time of performance.now(). */
    let clock = { frame: 0, wall: 0 };
    let now: Playing[] = [];

    const report = (frame: number) => {
      const whole = Math.floor(frame);
      if (whole === reported) return;
      reported = whole;
      latest.current.onPlayerFrame(whole);
    };

    /** Loads the clip after this one on its layer into the other element, at its first frame. */
    const prepareNext = (layer: number, after: Clip) => {
      const { project, sources } = latest.current;
      const state = now[layer];
      state.nextId = null;
      const next = project.clips.find((clip) => clip.layer === layer && clip.start >= clipEnd(after));
      const url = next && sources.get(next.mediaId);
      if (!next || !url) return;
      const slot = (1 - lane(layer).active) as Slot;
      element(layer, slot)?.pause();
      setSource(layer, slot, url);
      seek(layer, slot, next.sourceIn / project.fps + 0.001);
      state.nextId = next.id;
    };

    /** The time in the clip's file for a frame of the timeline. */
    const fileTime = (clip: Clip, frame: number) => (clip.sourceIn + frame - clip.start) / latest.current.project.fps + 0.001;

    /** Starts a clip on a layer at a frame: from the element that holds it ready, or with a seek. */
    const enter = (layer: number, clip: Clip, frame: number) => {
      const { sources } = latest.current;
      const state = now[layer];
      const info = lane(layer);
      const url = sources.get(clip.mediaId);
      state.clip = clip;
      if (!url) {
        state.ready = false;
        pauseLayer(layer);
        show(layer, null);
        return;
      }
      let slot = info.active;
      const other = (1 - slot) as Slot;
      if (state.nextId === clip.id && frame - clip.start < 2 && !info.failed[other]) {
        /* The other element already has this clip at its first frame: change to it. */
        element(layer, slot)?.pause();
        slot = other;
        info.active = slot;
      } else {
        element(layer, other)?.pause();
        setSource(layer, slot, url);
        info.waitingSeek[slot] = null;
        const video = element(layer, slot);
        if (video) video.currentTime = fileTime(clip, frame);
      }
      state.ready = true;
      void element(layer, slot)?.play().catch(() => {});
      show(layer, slot);
      prepareNext(layer, clip);
    };

    /** Brings one layer to a frame of the clock: a new clip starts, a gap hides the layer, a late video seeks. */
    const follow = (layer: number, frame: number, lead: boolean) => {
      const { project } = latest.current;
      const state = (now[layer] ??= { clip: null, ready: false, nextId: null });
      const info = lane(layer);
      const clip = clipAt(project, Math.floor(frame), layer) ?? null;
      const video = element(layer, info.active);
      if (clip && state.clip?.id === clip.id) {
        if (!state.ready) return;
        if (info.failed[info.active]) {
          state.ready = false;
          show(layer, null);
          return;
        }
        const wanted = fileTime(clip, frame);
        if (!lead && video && !video.seeking && !video.ended && Math.abs(video.currentTime - wanted) > DRIFT_LIMIT) video.currentTime = wanted;
        return;
      }
      if (!clip) {
        state.clip = null;
        pauseLayer(layer);
        show(layer, null);
        return;
      }
      const before = state.clip;
      if (before && state.ready && video && !video.ended && before.mediaId === clip.mediaId && clipEnd(before) === clip.start && before.sourceIn + before.length === clip.sourceIn) {
        /* The next clip continues the same file (a split with no other change): play on with no seek. */
        state.clip = clip;
        prepareNext(layer, clip);
        return;
      }
      enter(layer, clip, frame);
    };

    /** Starts to play from a frame: every layer seeks there. */
    const restart = (frame: number) => {
      now = [];
      clock = { frame, wall: performance.now() };
      report(frame);
      for (let layer = 0; layer < layerCount(latest.current.project); layer++) {
        now[layer] = { clip: null, ready: false, nextId: null };
        follow(layer, frame, false);
      }
    };

    const stop = (frame: number) => {
      pauseAll();
      latest.current.onPlayerFrame(frame);
      latest.current.onPlaying(false);
    };

    const tick = () => {
      request = requestAnimationFrame(tick);
      const { project, playhead, seekCount, loopRange, sources } = latest.current;
      /* After an edit or a move of the playhead by the user, play starts again from the playhead. */
      if (project !== seenProject || seekCount !== seenSeek) {
        seenProject = project;
        seenSeek = seekCount;
        restart(playhead);
        return;
      }
      let frame = clock.frame + ((performance.now() - clock.wall) / 1000) * project.fps;
      /* The highest layer whose video plays its clip moves the clock. */
      let leadLayer = -1;
      for (let layer = now.length - 1; layer >= 0; layer--) {
        const state = now[layer];
        const info = lane(layer);
        const video = element(layer, info.active);
        if (!state?.clip || !state.ready || !video || video.paused || video.ended || info.failed[info.active]) continue;
        const videoFrame = state.clip.start + (video.currentTime - 0.001) * project.fps - state.clip.sourceIn;
        if (videoFrame < state.clip.start - 1 || videoFrame > clipEnd(state.clip) + 1) continue;
        frame = Math.max(state.clip.start, videoFrame);
        clock = { frame, wall: performance.now() };
        leadLayer = layer;
        break;
      }
      const end = loopRange ? Math.min(loopRange.end, projectEnd(project)) : projectEnd(project);
      if (frame >= end) {
        if (loopRange && end > loopRange.start) restart(loopRange.start);
        else stop(projectEnd(project));
        return;
      }
      for (let layer = 0; layer < layerCount(project); layer++) follow(layer, frame, layer === leadLayer);
      for (let layer = layerCount(project); layer < videos.current.length; layer++) pauseLayer(layer);
      const top = topClipAt(project, Math.floor(frame));
      setNotReady(Boolean(top && (!sources.get(top.mediaId) || !now[top.layer]?.ready)));
      report(frame);
    };

    /* Play starts at the loop range when the playhead is outside it, and at frame 0 at the end of the timeline. */
    const { playhead, project: current, loopRange } = latest.current;
    let start = playhead >= projectEnd(current) ? 0 : playhead;
    if (loopRange && (playhead < loopRange.start || playhead >= loopRange.end)) start = loopRange.start;
    restart(start);
    request = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(request);
      pauseAll();
    };
  }, [playing]);

  const end = projectEnd(project);
  const canPlay = end > 0;
  /* The stage has the project's shape; the style sheet uses the ratio to make it as large as the area allows. */
  const stage = { aspectRatio: `${project.width} / ${project.height}`, "--stage-ratio": project.width / project.height } as React.CSSProperties;

  return (
    <section className="panel preview-panel" aria-label="Preview">
      <div className="preview-area" onClick={() => canPlay && onPlaying(!playing)}>
        <div className="preview-stage" style={stage}>
          {Array.from({ length: layers }, (_, layer) => ([0, 1] as const).map((slot) => (
            <video
              key={`${layer}-${slot}`}
              ref={(node) => { (videos.current[layer] ??= [null, null])[slot] = node; }}
              className={shown[layer] === slot ? "shown" : ""}
              style={{ zIndex: layer }}
              muted={muted}
              playsInline
              preload="auto"
              onSeeked={() => onSeeked(layer, slot)}
              onError={() => { lane(layer).failed[slot] = true; }}
            />
          )))}
          {notReady && <p className="preview-message">The preview copy of this video is not ready.</p>}
          {!canPlay && <p className="preview-message">Put a video on the timeline to see it here.</p>}
        </div>
      </div>
      <footer className="transport">
        <span className="transport-time">{formatTimecode(playhead, project.fps)}</span>
        <div className="transport-buttons">
          <button onClick={() => onSeek(0)} disabled={!canPlay} title="Go to the start (Home)" aria-label="Go to the start"><SkipBack size={16} weight="fill" /></button>
          <button onClick={() => onSeek(playhead - 1)} disabled={!canPlay} title="One frame back (Left)" aria-label="One frame back"><CaretLeft size={16} weight="bold" /></button>
          <button className="transport-play" onClick={() => onPlaying(!playing)} disabled={!canPlay} title={playing ? "Pause (Space)" : "Play (Space)"} aria-label={playing ? "Pause" : "Play"}>
            {playing ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}
          </button>
          <button onClick={() => onSeek(playhead + 1)} disabled={!canPlay} title="One frame forward (Right)" aria-label="One frame forward"><CaretRight size={16} weight="bold" /></button>
          <button onClick={() => onSeek(end)} disabled={!canPlay} title="Go to the end (End)" aria-label="Go to the end"><SkipForward size={16} weight="fill" /></button>
        </div>
        <div className="transport-right">
          <button className={loop ? "on" : ""} onClick={onToggleLoop} title={loop ? "Loop play is on: play repeats the selected clips, or the timeline (L)" : "Loop play is off (L)"} aria-label="Loop play" aria-pressed={loop}>
            <Repeat size={16} />
          </button>
          <button onClick={() => setMuted((current) => !current)} title={muted ? "Sound is off" : "Sound is on"} aria-label="Sound" aria-pressed={!muted}>
            {muted ? <SpeakerSlash size={16} /> : <SpeakerHigh size={16} />}
          </button>
        </div>
      </footer>
    </section>
  );
}
