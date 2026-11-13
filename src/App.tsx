import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AboutDialog } from "./components/AboutDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { MediaBin } from "./components/MediaBin";
import { MenuBar, type Menu } from "./components/MenuBar";
import { Notices, type Notice } from "./components/Notices";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { Timeline, type TimelineHandle } from "./components/Timeline";
import { TitleBar } from "./components/TitleBar";
import { record, startHistory } from "./editor/history";
import { emptyProject, projectEnd, type MediaItem, type Project } from "./editor/model";
import { addMedia, insertMedia, removeMedia } from "./editor/operations";
import { probeMedia, VIDEO_EXTENSIONS } from "./lib/media";
import { revealMainWindow } from "./lib/splash";
import { checkForUpdate, getAppVersion, type UpdateInfo } from "./lib/updater";

/** A menu command that a later build phase adds; it shows disabled until then. */
const later = { disabled: true, run: () => {} };

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

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
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const timelineRef = useRef<TimelineHandle>(null);

  const project = history.present;
  const projectRef = useRef(project);
  projectRef.current = project;
  const end = projectEnd(project);
  /* The playhead stays on the timeline when an edit makes the timeline shorter. */
  const playhead = Math.min(playheadFrame, end);
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;

  /** Moves the playhead to a frame; it stops at frame 0 and at the end of the last clip. */
  const movePlayhead = useCallback((frame: number) => {
    setPlayheadFrame(Math.max(0, Math.min(Math.round(frame), projectEnd(projectRef.current))));
  }, []);

  /** Makes an edit to the project, as one undo step. */
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

  /** Puts a media file on the timeline after the last clip, and selects the new clip. */
  const addToTimeline = useCallback((item: MediaItem) => {
    const added = insertMedia(projectRef.current, item.id, projectEnd(projectRef.current));
    if (!added.clipId) return;
    edit(() => added.project);
    setSelection(new Set([added.clipId]));
  }, [edit]);

  const importMedia = useCallback(async () => {
    if (!isTauri()) return;
    const picked = await open({ multiple: true, title: "Import Media", filters: [{ name: "Video files", extensions: VIDEO_EXTENSIONS }] });
    if (picked) await importPaths(Array.isArray(picked) ? picked : [picked]);
  }, [importPaths]);

  /** Removes a media file. If clips use it, the user must agree first, because the clips go too. */
  const requestRemove = useCallback((item: MediaItem) => {
    if (projectRef.current.clips.some((clip) => clip.mediaId === item.id)) setRemoving(item);
    else edit((current) => removeMedia(current, item.id));
  }, [edit]);

  useEffect(() => {
    void revealMainWindow();
    if (!isTauri()) return;
    let cancelled = false;
    getAppVersion().then((version) => { if (!cancelled) setAppVersion(version); }).catch(() => {});
    checkForUpdate().then((info) => { if (!cancelled && info) setStartupUpdate(info); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.closest("input, textarea")) return;
      const ctrl = event.ctrlKey && !event.shiftKey && !event.altKey;
      const plain = !event.ctrlKey && !event.shiftKey && !event.altKey;
      const key = event.key.toLowerCase();
      let handled = true;
      if (event.key === "?") setShortcutsOpen(true);
      else if (ctrl && key === "i") void importMedia();
      else if (ctrl && key === "a") setSelection(new Set(projectRef.current.clips.map((clip) => clip.id)));
      else if (ctrl && (key === "=" || key === "+")) timelineRef.current?.zoomIn();
      else if (ctrl && key === "-") timelineRef.current?.zoomOut();
      else if (ctrl && key === "0") timelineRef.current?.zoomToFit();
      else if (plain && key === "escape") setSelection(new Set());
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

  const menus = useMemo<Menu[]>(() => [
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
        { label: "Undo", shortcut: "Ctrl+Z", ...later },
        { label: "Redo", shortcut: "Ctrl+Y", ...later },
        "separator",
        { label: "Cut", shortcut: "Ctrl+X", ...later },
        { label: "Copy", shortcut: "Ctrl+C", ...later },
        { label: "Paste", shortcut: "Ctrl+V", ...later },
        { label: "Delete", shortcut: "Delete", ...later },
        { label: "Select All", shortcut: "Ctrl+A", run: () => setSelection(new Set(projectRef.current.clips.map((clip) => clip.id))) },
        "separator",
        { label: "Split at Playhead", shortcut: "S", ...later },
        { label: "Join Clips", shortcut: "Ctrl+J", ...later },
        { label: "Close Gaps", ...later }
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
        { label: "Snapping", shortcut: "N", ...later }
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
  ], [importMedia]);

  return (
    <div className="app">
      <TitleBar updateAvailable={startupUpdate !== null} onAbout={() => setAboutOpen(true)} fileName="Untitled Project" dirty={false} />
      <MenuBar menus={menus} />
      <main className="workspace">
        <MediaBin media={project.media} importing={importing} dropActive={dropActive} onImport={() => void importMedia()} onRemove={requestRemove} onAddToTimeline={addToTimeline} />
        <section className="panel preview-panel" aria-label="Preview">
          <p className="placeholder">The preview comes in a later build phase.</p>
        </section>
        <Timeline ref={timelineRef} project={project} playhead={playhead} onPlayhead={movePlayhead} selection={selection} onSelect={setSelection} />
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
