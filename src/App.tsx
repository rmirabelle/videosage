import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { Check } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AboutDialog } from "./components/AboutDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { MediaBin } from "./components/MediaBin";
import { MenuBar, type Menu } from "./components/MenuBar";
import { Notices, type Notice } from "./components/Notices";
import { Preview } from "./components/Preview";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { Timeline, type TimelineHandle } from "./components/Timeline";
import { TitleBar } from "./components/TitleBar";
import { canRedo, canUndo, record, redo, startHistory, undo } from "./editor/history";
import { clipEnd, emptyProject, projectEnd, type ClipboardClip, type MediaItem, type Project } from "./editor/model";
import { addMedia, canJoin, clipAt, closeGaps, copyClips, deleteClips, insertMedia, joinClips, pasteClips, removeMedia, splitAt } from "./editor/operations";
import { probeMedia, VIDEO_EXTENSIONS } from "./lib/media";
import { revealMainWindow } from "./lib/splash";
import { checkForUpdate, getAppVersion, type UpdateInfo } from "./lib/updater";
import { makeProxy, onProxyProgress, videoUrl, type ProxyState } from "./lib/videos";

/** A menu command that a later build phase adds; it shows disabled until then. */
const later = { disabled: true, run: () => {} };

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

const NO_SELECTION: ReadonlySet<string> = new Set();

let nextNoticeId = 1;

export default function App() {
  const [appVersion, setAppVersion] = useState("");
  const [startupUpdate, setStartupUpdate] = useState<UpdateInfo | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [history, setHistory] = useState(() => startHistory(emptyProject()));
  const [importing, setImporting] = useState<string[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [removing, setRemoving] = useState<MediaItem | null>(null);
  const [playheadFrame, setPlayheadFrame] = useState(0);
  const [rawSelection, setSelection] = useState<ReadonlySet<string>>(NO_SELECTION);
  const [clipboard, setClipboard] = useState<ClipboardClip[]>([]);
  const [snapping, setSnapping] = useState(true);
  const [playing, setPlaying] = useState(false);
  /** Goes up by one each time the user moves the playhead; the player follows it during play. */
  const [seekCount, setSeekCount] = useState(0);
  /** The preview copies of the files that the player cannot play directly, by file path. */
  const [proxies, setProxies] = useState<Record<string, ProxyState>>({});
  const proxiesRef = useRef(proxies);
  proxiesRef.current = proxies;
  /** The URL that plays each file, by the path of the file or of its preview copy. */
  const [playUrls, setPlayUrls] = useState<Record<string, string>>({});
  const timelineRef = useRef<TimelineHandle>(null);

  const project = history.present;
  const projectRef = useRef(project);
  projectRef.current = project;
  const end = projectEnd(project);
  /* The playhead stays on the timeline when an edit makes the timeline shorter. */
  const playhead = Math.min(playheadFrame, end);

  /* An edit or an undo can remove selected clips; only clips that the project has stay selected. */
  const selection = useMemo(() => {
    const ids = new Set(project.clips.map((clip) => clip.id));
    const kept = [...rawSelection].filter((id) => ids.has(id));
    return kept.length === rawSelection.size ? rawSelection : new Set(kept);
  }, [project.clips, rawSelection]);

  /** Moves the playhead to a frame; it stops at frame 0 and at the end of the last clip. */
  const movePlayhead = useCallback((frame: number) => {
    setPlayheadFrame(Math.max(0, Math.min(Math.round(frame), projectEnd(projectRef.current))));
    setSeekCount((count) => count + 1);
  }, []);

  /** Makes an edit to the project, as one undo step. An edit that changes nothing makes no step. */
  const edit = useCallback((change: (project: Project) => Project) => {
    setHistory((current) => record(current, change(current.present)));
  }, []);

  const notify = useCallback((text: string) => {
    setNotices((current) => [...current, { id: nextNoticeId++, text }]);
  }, []);

  /** Reads the files one at a time and adds each video to the media list. A file that fails shows a message. */
  const importPaths = useCallback(async (paths: string[]) => {
    for (const path of paths) {
      if (projectRef.current.media.some((item) => item.path === path)) continue;
      const name = fileName(path);
      setImporting((current) => [...current, name]);
      try {
        const item = await probeMedia(path);
        edit((current) => addMedia(current, item));
      } catch (error) {
        notify(`Could not import ${name}. ${String(error)}`);
      } finally {
        setImporting((current) => {
          const index = current.indexOf(name);
          return index < 0 ? current : [...current.slice(0, index), ...current.slice(index + 1)];
        });
      }
    }
  }, [edit, notify]);

  const importMedia = useCallback(async () => {
    if (!isTauri()) return;
    const picked = await open({ multiple: true, title: "Import Media", filters: [{ name: "Video files", extensions: VIDEO_EXTENSIONS }] });
    if (picked) await importPaths(Array.isArray(picked) ? picked : [picked]);
  }, [importPaths]);

  /** Puts a media file on the timeline after the last clip, and selects the new clip. */
  const addToTimeline = useCallback((item: MediaItem) => {
    const added = insertMedia(projectRef.current, item.id, projectEnd(projectRef.current));
    if (!added.clipId) return;
    edit(() => added.project);
    setSelection(new Set([added.clipId]));
  }, [edit]);

  /** Removes a media file. If clips use it, the user must agree first, because the clips go too. */
  const requestRemove = useCallback((item: MediaItem) => {
    if (projectRef.current.clips.some((clip) => clip.mediaId === item.id)) setRemoving(item);
    else edit((current) => removeMedia(current, item.id));
  }, [edit]);

  /**
   * The edit commands, for the menus, the keys and the timeline's buttons.
   * Each one has "can" (false shows the menu item disabled) and "run".
   * They are made again on each render, so they always see the current
   * project, selection, playhead and clipboard.
   */
  const hasSelection = selection.size > 0;
  const splitClip = clipAt(project, playhead);
  const commands = {
    undo: { can: canUndo(history), run: () => setHistory(undo) },
    redo: { can: canRedo(history), run: () => setHistory(redo) },
    copy: { can: hasSelection, run: () => setClipboard(copyClips(project, selection)) },
    cut: {
      can: hasSelection,
      run: () => {
        setClipboard(copyClips(project, selection));
        edit((current) => deleteClips(current, selection));
      }
    },
    paste: {
      can: clipboard.length > 0,
      run: () => {
        const pasted = pasteClips(project, clipboard, playhead);
        if (pasted.pastedIds.length === 0) return;
        edit(() => pasted.project);
        const ids = new Set(pasted.pastedIds);
        setSelection(ids);
        /* The playhead goes to the end of the pasted clips, so the next paste comes after them. */
        setPlayheadFrame(Math.max(...pasted.project.clips.filter((clip) => ids.has(clip.id)).map(clipEnd)));
        setSeekCount((count) => count + 1);
      }
    },
    delete: { can: hasSelection, run: () => edit((current) => deleteClips(current, selection)) },
    selectAll: { can: project.clips.length > 0, run: () => setSelection(new Set(project.clips.map((clip) => clip.id))) },
    split: { can: splitClip !== undefined && splitClip.start !== playhead, run: () => edit((current) => splitAt(current, playhead)) },
    join: { can: canJoin(project, selection), run: () => edit((current) => joinClips(current, selection)) },
    closeGaps: { can: closeGaps(project) !== project, run: () => edit(closeGaps) },
    toggleSnapping: { can: true, run: () => setSnapping((current) => !current) },
    togglePlay: { can: end > 0, run: () => setPlaying((current) => !current) }
  };
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;

  useEffect(() => {
    void revealMainWindow();
    if (!isTauri()) return;
    let cancelled = false;
    getAppVersion().then((version) => { if (!cancelled) setAppVersion(version); }).catch(() => {});
    checkForUpdate().then((info) => { if (!cancelled && info) setStartupUpdate(info); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  /* A file that the player cannot play directly gets a preview copy, made one time and kept in the cache. */
  useEffect(() => {
    for (const item of project.media) {
      if (item.playable || proxiesRef.current[item.path]) continue;
      const set = (state: ProxyState) => setProxies((current) => ({ ...current, [item.path]: state }));
      proxiesRef.current = { ...proxiesRef.current, [item.path]: { status: "making", fraction: 0 } };
      set({ status: "making", fraction: 0 });
      makeProxy(item.path, item.durationSec)
        .then((path) => set({ status: "ready", path }))
        .catch((error) => {
          set({ status: "failed" });
          notify(`${item.name}: ${String(error)}`);
        });
    }
  }, [project.media, notify]);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = onProxyProgress((path, fraction) => {
      setProxies((current) => current[path]?.status === "making" ? { ...current, [path]: { status: "making", fraction } } : current);
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, []);

  /** The path that the preview plays for a media file: the file, or its preview copy; null while the copy is not ready. */
  const playPath = useCallback((item: MediaItem) => {
    if (item.playable) return item.path;
    const proxy = proxies[item.path];
    return proxy?.status === "ready" ? proxy.path : null;
  }, [proxies]);

  /* Each file that can play gets its URL from Rust. */
  useEffect(() => {
    if (!isTauri()) return;
    for (const item of project.media) {
      const path = playPath(item);
      if (!path || playUrls[path]) continue;
      videoUrl(path)
        .then((url) => setPlayUrls((current) => current[path] ? current : { ...current, [path]: url }))
        .catch((error) => notify(`Could not open ${item.name} for the preview. ${String(error)}`));
    }
  }, [project.media, playPath, playUrls, notify]);

  const sources = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of project.media) {
      const path = playPath(item);
      if (path && playUrls[path]) map.set(item.id, playUrls[path]);
    }
    return map;
  }, [project.media, playPath, playUrls]);

  /* Files dropped on the window from File Explorer are imported. */
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") setDropActive(true);
      else setDropActive(false);
      if (event.payload.type === "drop") void importPaths(event.payload.paths);
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, [importPaths]);

  /* The keys. Each key is the same as its menu item (see also src/help/shortcuts.ts). */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.closest("input, textarea")) return;
      const ctrl = event.ctrlKey && !event.shiftKey && !event.altKey;
      const ctrlShift = event.ctrlKey && event.shiftKey && !event.altKey;
      const plain = !event.ctrlKey && !event.shiftKey && !event.altKey;
      const key = event.key.toLowerCase();
      const run = (name: keyof typeof commands) => {
        const command = commandsRef.current[name];
        if (command.can) command.run();
      };
      let handled = true;
      if (event.key === "?") setShortcutsOpen(true);
      else if (ctrl && key === "i") void importMedia();
      else if (ctrl && key === "z") run("undo");
      else if ((ctrl && key === "y") || (ctrlShift && key === "z")) run("redo");
      else if (ctrl && key === "x") run("cut");
      else if (ctrl && key === "c") run("copy");
      else if (ctrl && key === "v") run("paste");
      else if (ctrl && key === "a") run("selectAll");
      else if (ctrl && key === "j") run("join");
      else if (plain && (key === "delete" || key === "backspace")) run("delete");
      else if (plain && key === "s") run("split");
      else if (plain && key === "n") run("toggleSnapping");
      else if (plain && key === " ") run("togglePlay");
      else if (ctrl && (key === "=" || key === "+")) timelineRef.current?.zoomIn();
      else if (ctrl && key === "-") timelineRef.current?.zoomOut();
      else if (ctrl && key === "0") timelineRef.current?.zoomToFit();
      else if (plain && key === "escape") setSelection(NO_SELECTION);
      else if (plain && key === "home") movePlayhead(0);
      else if (plain && key === "end") movePlayhead(Infinity);
      else if (plain && key === "arrowleft") movePlayhead(playheadRef.current - 1);
      else if (plain && key === "arrowright") movePlayhead(playheadRef.current + 1);
      else handled = false;
      if (handled) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [importMedia, movePlayhead]);

  /** A menu item for an edit command: disabled when the command cannot run now. */
  const item = (label: string, shortcut: string | undefined, name: keyof typeof commands) => ({
    label,
    shortcut,
    disabled: !commands[name].can,
    run: () => commandsRef.current[name].run()
  });

  const menus: Menu[] = [
    {
      id: "file",
      label: "File",
      items: [
        { label: "New Project", shortcut: "Ctrl+N", ...later },
        { label: "Open Project…", shortcut: "Ctrl+O", ...later },
        "separator",
        { label: "Save", shortcut: "Ctrl+S", ...later },
        { label: "Save As…", shortcut: "Ctrl+Shift+S", ...later },
        "separator",
        { label: "Import Media…", shortcut: "Ctrl+I", run: () => void importMedia() },
        { label: "Export Video…", shortcut: "Ctrl+E", ...later },
        "separator",
        { label: "Exit", shortcut: "Alt+F4", run: () => { if (isTauri()) void getCurrentWindow().close(); } }
      ]
    },
    {
      id: "edit",
      label: "Edit",
      items: [
        item("Undo", "Ctrl+Z", "undo"),
        item("Redo", "Ctrl+Y", "redo"),
        "separator",
        item("Cut", "Ctrl+X", "cut"),
        item("Copy", "Ctrl+C", "copy"),
        item("Paste", "Ctrl+V", "paste"),
        item("Delete", "Delete", "delete"),
        item("Select All", "Ctrl+A", "selectAll"),
        "separator",
        item("Split at Playhead", "S", "split"),
        item("Join Clips", "Ctrl+J", "join"),
        item("Close Gaps", undefined, "closeGaps")
      ]
    },
    {
      id: "view",
      label: "View",
      items: [
        { label: "Zoom In", shortcut: "Ctrl+=", run: () => timelineRef.current?.zoomIn() },
        { label: "Zoom Out", shortcut: "Ctrl+-", run: () => timelineRef.current?.zoomOut() },
        { label: "Zoom to Fit", shortcut: "Ctrl+0", run: () => timelineRef.current?.zoomToFit() },
        "separator",
        { ...item("Snapping", "N", "toggleSnapping"), icon: snapping ? <Check size={13} weight="bold" /> : undefined }
      ]
    },
    {
      id: "help",
      label: "Help",
      items: [
        { label: "Keyboard Shortcuts", shortcut: "?", run: () => setShortcutsOpen(true) },
        "separator",
        { label: "Check for Updates…", run: () => setAboutOpen(true) },
        { label: "About Video Sage", run: () => setAboutOpen(true) }
      ]
    }
  ];

  return (
    <div className="app">
      <TitleBar updateAvailable={startupUpdate !== null} onAbout={() => setAboutOpen(true)} fileName="Untitled Project" dirty={false} />
      <MenuBar menus={menus} />
      <main className="workspace">
        <MediaBin media={project.media} proxies={proxies} importing={importing} dropActive={dropActive} onImport={() => void importMedia()} onRemove={requestRemove} onAddToTimeline={addToTimeline} />
        <Preview
          project={project}
          playhead={playhead}
          sources={sources}
          playing={playing}
          onPlaying={setPlaying}
          onPlayerFrame={setPlayheadFrame}
          onSeek={movePlayhead}
          seekCount={seekCount}
        />
        <Timeline
          ref={timelineRef}
          project={project}
          playhead={playhead}
          onPlayhead={movePlayhead}
          selection={selection}
          onSelect={setSelection}
          onCommit={(next) => edit(() => next)}
          snapping={snapping}
          onToggleSnapping={commands.toggleSnapping.run}
          onSplit={commands.split.can ? commands.split.run : null}
          follow={playing}
        />
      </main>
      <Notices notices={notices} onClose={(id) => setNotices((current) => current.filter((notice) => notice.id !== id))} />
      {removing && (
        <ConfirmDialog
          title="Remove media?"
          message={<>The timeline has clips of <strong>{removing.name}</strong>. If you remove the file, those clips go too.</>}
          confirmLabel="Remove"
          onConfirm={() => { edit((current) => removeMedia(current, removing.id)); setRemoving(null); }}
          onCancel={() => setRemoving(null)}
        />
      )}
      {aboutOpen && <AboutDialog version={appVersion} initialUpdateInfo={startupUpdate} onClose={() => setAboutOpen(false)} />}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}
