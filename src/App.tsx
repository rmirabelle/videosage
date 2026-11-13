import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Check } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AboutDialog } from "./components/AboutDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ExportDialog } from "./components/ExportDialog";
import { MediaBin } from "./components/MediaBin";
import { MenuBar, type Menu } from "./components/MenuBar";
import { Notices, type Notice } from "./components/Notices";
import { Preview } from "./components/Preview";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { Timeline, type TimelineHandle } from "./components/Timeline";
import { TitleBar } from "./components/TitleBar";
import { canRedo, canUndo, record, redo, startHistory, undo } from "./editor/history";
import { clipEnd, emptyProject, projectEnd, type ClipboardClip, type MediaItem, type Project } from "./editor/model";
import { addMedia, canJoin, clipAt, closeGaps, copyClips, deleteClips, insertMedia, joinClips, pasteClips, relinkMedia, removeMedia, splitAt } from "./editor/operations";
import { FILE_EXTENSION, parseProject, serializeProject } from "./editor/projectFile";
import { probeMedia, VIDEO_EXTENSIONS } from "./lib/media";
import { addRecentProject, missingFiles, readProjectFile, recentProjects, writeProjectFile } from "./lib/projects";
import { revealMainWindow } from "./lib/splash";
import { checkForUpdate, getAppVersion, type UpdateInfo } from "./lib/updater";
import { makeProxy, onProxyProgress, videoUrl, type ProxyState } from "./lib/videos";

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

const NO_SELECTION: ReadonlySet<string> = new Set();
const NO_PATHS: ReadonlySet<string> = new Set();

const PROJECT_FILTERS = [{ name: "Video Sage project", extensions: [FILE_EXTENSION] }];
/** The most recent projects that the File menu shows. */
const RECENT_IN_MENU = 5;

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

let nextNoticeId = 1;

export default function App() {
  const [appVersion, setAppVersion] = useState("");
  const [startupUpdate, setStartupUpdate] = useState<UpdateInfo | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
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
  /** The path of the open project's file; null for a project that was never saved. */
  const [filePath, setFilePath] = useState<string | null>(null);
  /** The project as its file has it. The project has changes to save when it is not this object. */
  const [saved, setSaved] = useState(history.present);
  const [recent, setRecent] = useState<string[]>([]);
  /** The paths of the media files that were not found when the project opened. */
  const [missing, setMissing] = useState<ReadonlySet<string>>(NO_PATHS);
  /**
   * The "Save changes?" question is open. "then" runs after the user saves
   * or chooses not to save; "cancel" runs when the user cancels.
   */
  const [asking, setAsking] = useState<{ then: () => void; cancel?: () => void } | null>(null);

  const project = history.present;
  const dirty = project !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;
  const missingRef = useRef(missing);
  missingRef.current = missing;
  const projectName = filePath ? fileName(filePath) : "Untitled Project";
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

  /**
   * Reads the files one at a time. Each video goes in the media list and on
   * the timeline, after the last clip, as one undo step. A file that fails
   * shows a message.
   */
  const importPaths = useCallback(async (paths: string[]) => {
    for (const path of paths) {
      if (projectRef.current.media.some((item) => item.path === path)) continue;
      const name = fileName(path);
      setImporting((current) => [...current, name]);
      try {
        const item = await probeMedia(path);
        edit((current) => {
          const withMedia = addMedia(current, item);
          return withMedia === current ? current : insertMedia(withMedia, item.id, projectEnd(withMedia)).project;
        });
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

  /** Shows a project as the open project, with no undo steps and no changes to save. */
  const showProject = (next: Project, path: string | null, notFound: ReadonlySet<string>) => {
    setHistory(startHistory(next));
    setSaved(next);
    setFilePath(path);
    setMissing(notFound);
    setSelection(NO_SELECTION);
    setClipboard([]);
    setPlaying(false);
    setPlayheadFrame(0);
    setSeekCount((count) => count + 1);
  };

  const rememberRecent = (path: string) => {
    addRecentProject(path).then(setRecent).catch(() => {});
  };

  /** Writes the project to a file. Gives true when the file is written. */
  const saveTo = async (path: string) => {
    const current = projectRef.current;
    try {
      await writeProjectFile(path, serializeProject(current));
    } catch (error) {
      notify(`Could not save ${fileName(path)}. ${messageOf(error)}`);
      return false;
    }
    setSaved(current);
    setFilePath(path);
    rememberRecent(path);
    return true;
  };

  const saveProjectAs = async () => {
    if (!isTauri()) return false;
    const picked = await save({ title: "Save Project As", defaultPath: filePathRef.current ?? `Untitled Project.${FILE_EXTENSION}`, filters: PROJECT_FILTERS });
    return picked ? saveTo(picked) : false;
  };

  const saveProject = () => filePathRef.current ? saveTo(filePathRef.current) : saveProjectAs();

  /** Runs the action now, or after the user answers "Save changes?" when the project has changes. */
  const afterSaveQuestion = (action: () => void) => {
    if (dirtyRef.current) setAsking({ then: action });
    else action();
  };

  /**
   * For the update install, which closes the app: asks "Save changes?" when
   * the project has changes. Gives false when the user cancels or the save fails.
   */
  const settleChanges = () => new Promise<boolean>((resolve) => {
    if (!dirtyRef.current) resolve(true);
    else setAsking({ then: () => resolve(true), cancel: () => resolve(false) });
  });

  const openPath = async (path: string) => {
    try {
      const next = parseProject(await readProjectFile(path));
      const notFound = await missingFiles(next.media.map((item) => item.path));
      showProject(next, path, new Set(notFound));
      rememberRecent(path);
      if (notFound.length === 1) notify(`Video Sage cannot find ${fileName(notFound[0])}. Use "Find file" in the Media list.`);
      else if (notFound.length > 1) notify(`Video Sage cannot find ${notFound.length} media files. Use "Find file" in the Media list.`);
    } catch (error) {
      notify(`Could not open ${fileName(path)}. ${messageOf(error)}`);
    }
  };

  const openProject = async () => {
    if (!isTauri()) return;
    const picked = await open({ multiple: false, title: "Open Project", filters: PROJECT_FILTERS });
    if (typeof picked === "string") await openPath(picked);
  };

  /**
   * The user shows where a missing media file is now. Other missing files
   * with their old names in the same folder are found too.
   */
  const relink = async (item: MediaItem) => {
    if (!isTauri()) return;
    const picked = await open({ multiple: false, title: `Find ${item.name}`, filters: [{ name: "Video files", extensions: VIDEO_EXTENSIONS }] });
    if (typeof picked !== "string") return;
    try {
      const found: [string, MediaItem][] = [[item.id, await probeMedia(picked)]];
      if (!relinkMedia(projectRef.current, item.id, found[0][1])) {
        notify(`${fileName(picked)} cannot take the place of ${item.name}. It is shorter than the clips that use it, or the project already has it.`);
        return;
      }
      const folder = picked.slice(0, picked.length - fileName(picked).length);
      for (const other of projectRef.current.media) {
        if (other.id === item.id || !missingRef.current.has(other.path)) continue;
        try {
          found.push([other.id, await probeMedia(folder + fileName(other.path))]);
        } catch {
          /* That file is not in this folder; it stays missing. */
        }
      }
      edit((current) => found.reduce((next, [id, file]) => relinkMedia(next, id, file) ?? next, current));
    } catch (error) {
      notify(`Could not use ${fileName(picked)}. ${messageOf(error)}`);
    }
  };

  /** Files dropped on the window: a project file opens, video files are imported. */
  const dropPaths = (paths: string[]) => {
    const projectPath = paths.find((path) => path.toLowerCase().endsWith(`.${FILE_EXTENSION}`));
    if (projectPath) afterSaveQuestion(() => void openPath(projectPath));
    else void importPaths(paths);
  };
  const dropPathsRef = useRef(dropPaths);
  dropPathsRef.current = dropPaths;

  /**
   * The edit commands, for the menus, the keys and the timeline's buttons.
   * Each one has "can" (false shows the menu item disabled) and "run".
   * They are made again on each render, so they always see the current
   * project, selection, playhead and clipboard.
   */
  const hasSelection = selection.size > 0;
  const splitClip = clipAt(project, playhead);
  const commands = {
    newProject: { can: true, run: () => afterSaveQuestion(() => showProject(emptyProject(), null, NO_PATHS)) },
    openProject: { can: true, run: () => afterSaveQuestion(() => void openProject()) },
    save: { can: true, run: () => void saveProject() },
    saveAs: { can: true, run: () => void saveProjectAs() },
    exportVideo: {
      can: end > 0,
      run: () => {
        setPlaying(false);
        setExportOpen(true);
      }
    },
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
    recentProjects().then((list) => { if (!cancelled) setRecent(list); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  /* A close of the window with changes that are not saved asks "Save changes?" first. */
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = getCurrentWindow().onCloseRequested((event) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      setAsking({ then: () => void getCurrentWindow().destroy() });
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, []);

  /* A file that the player cannot play directly gets a preview copy, made one time and kept in the cache. */
  useEffect(() => {
    for (const item of project.media) {
      if (item.playable || missing.has(item.path) || proxiesRef.current[item.path]) continue;
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
  }, [project.media, missing, notify]);

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
      if (!path || missing.has(item.path) || playUrls[path]) continue;
      videoUrl(path)
        .then((url) => setPlayUrls((current) => current[path] ? current : { ...current, [path]: url }))
        .catch((error) => notify(`Could not open ${item.name} for the preview. ${String(error)}`));
    }
  }, [project.media, missing, playPath, playUrls, notify]);

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
      if (event.payload.type === "drop") dropPathsRef.current(event.payload.paths);
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, []);

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
      else if (ctrl && key === "n") run("newProject");
      else if (ctrl && key === "o") run("openProject");
      else if (ctrl && key === "s") run("save");
      else if (ctrlShift && key === "s") run("saveAs");
      else if (ctrl && key === "i") void importMedia();
      else if (ctrl && key === "e") run("exportVideo");
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

  /* The recent projects show in the File menu with a number, newest first. */
  const recentItems: Menu["items"] = recent.slice(0, RECENT_IN_MENU).map((path, index) => ({
    label: `${index + 1}  ${fileName(path)}`,
    run: () => afterSaveQuestion(() => void openPath(path))
  }));

  const menus: Menu[] = [
    {
      id: "file",
      label: "File",
      items: [
        item("New Project", "Ctrl+N", "newProject"),
        item("Open Project…", "Ctrl+O", "openProject"),
        "separator",
        item("Save", "Ctrl+S", "save"),
        item("Save As…", "Ctrl+Shift+S", "saveAs"),
        "separator",
        ...recentItems,
        ...(recentItems.length > 0 ? ["separator" as const] : []),
        { label: "Import Media…", shortcut: "Ctrl+I", run: () => void importMedia() },
        item("Export Video…", "Ctrl+E", "exportVideo"),
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
      <TitleBar updateAvailable={startupUpdate !== null} onAbout={() => setAboutOpen(true)} fileName={projectName} dirty={dirty} />
      <MenuBar menus={menus} />
      <main className="workspace">
        <MediaBin media={project.media} proxies={proxies} missing={missing} onRelink={(media) => void relink(media)} importing={importing} dropActive={dropActive} onImport={() => void importMedia()} onRemove={requestRemove} onAddToTimeline={addToTimeline} />
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
      {exportOpen && (
        <ExportDialog
          project={project}
          missing={missing}
          suggestedPath={filePath ? filePath.replace(/\.[^.\\/]*$/, "") + ".mp4" : "Untitled Project.mp4"}
          onClose={() => setExportOpen(false)}
        />
      )}
      {aboutOpen && <AboutDialog version={appVersion} initialUpdateInfo={startupUpdate} onClose={() => setAboutOpen(false)} beforeInstall={settleChanges} />}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {/* The last dialog in the page shows on top: this question can come up over the About dialog. */}
      {asking && (
        <ConfirmDialog
          title="Save changes?"
          message={<><strong>{projectName}</strong> has changes that are not saved.</>}
          confirmLabel="Save"
          otherLabel="Don't Save"
          onConfirm={() => {
            setAsking(null);
            void saveProject().then((written) => { if (written) asking.then(); else asking.cancel?.(); });
          }}
          onOther={() => { setAsking(null); asking.then(); }}
          onCancel={() => { setAsking(null); asking.cancel?.(); }}
        />
      )}
    </div>
  );
}
