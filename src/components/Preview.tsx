import { CaretLeft, CaretRight, Pause, Play, SkipBack, SkipForward, SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { clipEnd, projectEnd, type Clip, type Project } from "../editor/model";
import { clipAt } from "../editor/operations";
import { formatTimecode } from "../editor/time";

type Slot = 0 | 1;

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
}

/** What plays now: a clip in one of the two video elements, or a gap that the clock counts through. */
type Segment =
  | { kind: "clip"; clip: Clip; slot: Slot }
  | { kind: "gap"; until: number; wallStart: number; frameStart: number };

/**
 * The preview: it shows the frame under the playhead, and plays the
 * timeline. It has two <video> elements. One plays the current clip; the
 * other holds the next clip, loaded and at its first frame, so a cut does
 * not wait for a load. During a clip, the video's own time moves the
 * playhead, so picture and sound stay together. In a gap, a clock moves it
 * and the picture is black.
 */
export function Preview({ project, playhead, sources, playing, onPlaying, onPlayerFrame, onSeek, seekCount }: Props) {
  const elementA = useRef<HTMLVideoElement>(null);
  const elementB = useRef<HTMLVideoElement>(null);
  const element = (slot: Slot) => (slot === 0 ? elementA.current : elementB.current)!;
  /** The URL that each element has now. */
  const loaded = useRef<[string | null, string | null]>([null, null]);
  /** A seek that waits for the element to finish the seek before it. */
  const waitingSeek = useRef<[number | null, number | null]>([null, null]);
  /** True after an element could not play its file. */
  const failed = useRef<[boolean, boolean]>([false, false]);
  const active = useRef<Slot>(0);
  const [shown, setShown] = useState<Slot | null>(null);
  const [notReady, setNotReady] = useState(false);
  const [muted, setMuted] = useState(false);
  const latest = useRef({ project, playhead, sources, onPlaying, onPlayerFrame, seekCount });
  latest.current = { project, playhead, sources, onPlaying, onPlayerFrame, seekCount };

  const setSource = (slot: Slot, url: string) => {
    if (loaded.current[slot] === url) return;
    loaded.current[slot] = url;
    waitingSeek.current[slot] = null;
    failed.current[slot] = false;
    element(slot).src = url;
  };

  /** Seeks an element. While it does a seek, only the newest wanted time is kept, so a fast scrub does not queue up seeks. */
  const seek = (slot: Slot, seconds: number) => {
    const video = element(slot);
    if (video.seeking) waitingSeek.current[slot] = seconds;
    else if (Math.abs(video.currentTime - seconds) > 0.0005) video.currentTime = seconds;
  };
  const onSeeked = (slot: Slot) => {
    const seconds = waitingSeek.current[slot];
    if (seconds === null) return;
    waitingSeek.current[slot] = null;
    element(slot).currentTime = seconds;
  };

  const pauseAll = () => {
    element(0).pause();
    element(1).pause();
  };

  /* Not playing: show the frame under the playhead. */
  useEffect(() => {
    if (playing) return;
    /* At the end of the timeline, the last frame of the last clip shows. */
    const timelineEnd = projectEnd(project);
    const frame = timelineEnd > 0 && playhead >= timelineEnd ? timelineEnd - 1 : playhead;
    const clip = clipAt(project, frame);
    const url = clip && sources.get(clip.mediaId);
    if (!clip || !url) {
      setShown(null);
      setNotReady(Boolean(clip));
      return;
    }
    const slot = active.current;
    setSource(slot, url);
    /* The middle of the frame, so a rounding error cannot show the frame before. */
    seek(slot, (clip.sourceIn + frame - clip.start + 0.5) / project.fps);
    setShown(slot);
    setNotReady(false);
  }, [playing, project, playhead, sources]);

  /* Playing: the loop below runs on each screen frame until play stops. */
  useEffect(() => {
    if (!playing) return;
    let request = 0;
    let segment: Segment | null = null;
    /** The clip that the other element holds ready, at its first frame. */
    let readyClipId: string | null = null;
    let reported = -1;
    let seenProject = latest.current.project;
    let seenSeek = latest.current.seekCount;

    const report = (frame: number) => {
      const whole = Math.floor(frame);
      if (whole === reported) return;
      reported = whole;
      latest.current.onPlayerFrame(whole);
    };

    /** Loads the clip after this one into the other element, at its first frame. */
    const prepareNext = (after: Clip) => {
      const { project, sources } = latest.current;
      readyClipId = null;
      const next = project.clips.find((clip) => clip.start >= clipEnd(after));
      const url = next && sources.get(next.mediaId);
      if (!next || !url) return;
      const slot = (1 - active.current) as Slot;
      element(slot).pause();
      setSource(slot, url);
      seek(slot, next.sourceIn / project.fps + 0.001);
      readyClipId = next.id;
    };

    /** Starts to play from a frame: a clip, a gap, or the end of the timeline. */
    const enter = (frame: number) => {
      const { project, sources } = latest.current;
      const end = projectEnd(project);
      if (frame >= end) {
        pauseAll();
        segment = null;
        latest.current.onPlayerFrame(end);
        latest.current.onPlaying(false);
        return;
      }
      const clip = clipAt(project, frame);
      const url = clip && sources.get(clip.mediaId);
      if (clip && url) {
        let slot = active.current;
        if (readyClipId === clip.id && frame === clip.start && !failed.current[1 - slot]) {
          /* The other element already has this clip at its first frame: change to it. */
          element(slot).pause();
          slot = (1 - slot) as Slot;
          active.current = slot;
        } else {
          element((1 - slot) as Slot).pause();
          setSource(slot, url);
          waitingSeek.current[slot] = null;
          element(slot).currentTime = (clip.sourceIn + frame - clip.start) / project.fps + 0.001;
        }
        void element(slot).play().catch(() => {});
        segment = { kind: "clip", clip, slot };
        setShown(slot);
        setNotReady(false);
        prepareNext(clip);
      } else {
        /* A gap, or a clip whose file is not ready: the clock counts to the next clip. */
        pauseAll();
        const until = clip ? clipEnd(clip) : project.clips.find((other) => other.start > frame)?.start ?? end;
        segment = { kind: "gap", until, wallStart: performance.now(), frameStart: frame };
        setShown(null);
        setNotReady(Boolean(clip));
      }
      report(frame);
    };

    const tick = () => {
      request = requestAnimationFrame(tick);
      const { project, playhead, seekCount } = latest.current;
      /* After an edit or a move of the playhead by the user, play starts again from the playhead. */
      if (project !== seenProject || seekCount !== seenSeek) {
        seenProject = project;
        seenSeek = seekCount;
        readyClipId = null;
        enter(playhead);
        return;
      }
      if (!segment) return;
      if (segment.kind === "gap") {
        const frame = segment.frameStart + ((performance.now() - segment.wallStart) / 1000) * project.fps;
        if (frame >= segment.until) enter(segment.until);
        else report(frame);
        return;
      }
      const { clip, slot } = segment;
      const video = element(slot);
      if (failed.current[slot]) {
        /* The file cannot play: count through the rest of the clip as a gap, with the message. */
        segment = { kind: "gap", until: clipEnd(clip), wallStart: performance.now(), frameStart: Math.max(reported, clip.start) };
        setShown(null);
        setNotReady(true);
        return;
      }
      const frame = clip.start + video.currentTime * project.fps - clip.sourceIn;
      if (frame < clipEnd(clip) && !video.ended) {
        report(Math.max(clip.start, frame));
        return;
      }
      const next = clipAt(project, clipEnd(clip));
      if (next && !video.ended && next.mediaId === clip.mediaId && next.sourceIn === clip.sourceIn + clip.length) {
        /* The next clip continues the same file (a split with no other change): play on with no seek. */
        segment = { kind: "clip", clip: next, slot };
        prepareNext(next);
        report(next.start);
      } else {
        enter(clipEnd(clip));
      }
    };

    /* Play at the end of the timeline starts again from frame 0. */
    const start = latest.current.playhead >= projectEnd(latest.current.project) ? 0 : latest.current.playhead;
    enter(start);
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
          <video ref={elementA} className={shown === 0 ? "shown" : ""} muted={muted} playsInline preload="auto" onSeeked={() => onSeeked(0)} onError={() => { failed.current[0] = true; }} />
          <video ref={elementB} className={shown === 1 ? "shown" : ""} muted={muted} playsInline preload="auto" onSeeked={() => onSeeked(1)} onError={() => { failed.current[1] = true; }} />
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
          <button onClick={() => setMuted((current) => !current)} title={muted ? "Sound is off" : "Sound is on"} aria-label="Sound" aria-pressed={!muted}>
            {muted ? <SpeakerSlash size={16} /> : <SpeakerHigh size={16} />}
          </button>
        </div>
      </footer>
    </section>
  );
}
