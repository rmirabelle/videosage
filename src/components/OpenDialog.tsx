import { invoke } from "@tauri-apps/api/core";
import { ArrowClockwise, ArrowUp, CaretDown, CaretRight, CaretUp, CheckCircle, Copy, Desktop, DownloadSimple, FilmSlate, Folder, FolderOpen, HardDrive, House, MagnifyingGlass, PencilSimple, SpinnerGap, Trash, VideoCamera, WarningCircle, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectEnd } from "../editor/model";
import { parseProject } from "../editor/projectFile";
import { formatDuration, formatFps, pictureUrl, probeMedia } from "../lib/media";
import { readProjectFile } from "../lib/projects";
import { videoUrl } from "../lib/videos";

/** The kind of file the dialog opens: a video file, or a Video Sage project (.vsage). */
export type OpenKind = "video" | "project";

interface Props {
  kind: OpenKind;
  /** The dialog's heading. */
  title: string;
  /** The line under the heading, in place of the kind's own (see TEXT). */
  hint?: string;
  /** The text of the button that opens the file; "Open" when not given. */
  openLabel?: string;
  /**
   * When true, several files can be selected (Ctrl + click, Shift + click,
   * Shift + arrow keys, Ctrl + A), and the button opens them all, in list order.
   */
  multiple?: boolean;
  onCancel: () => void;
  onOpen: (paths: string[]) => void;
}

type EntryKind = "folder" | OpenKind;
type PlaceKind = "home" | "desktop" | "documents" | "videos" | "downloads" | "drive";
type SortKey = "name" | "type" | "modified" | "size";
type SortDirection = "asc" | "desc";

interface SortState {
  key: SortKey;
  direction: SortDirection;
}

const DEFAULT_SORT: SortState = { key: "name", direction: "asc" };

type Notice = { tone: "error" | "success"; message: string } | null;

interface ContextMenuState {
  x: number;
  y: number;
  entry: BrowseEntry;
}

interface RenameState {
  path: string;
  value: string;
}

interface BrowseEntry {
  name: string;
  path: string;
  kind: EntryKind;
  size: number;
  modifiedMs: number | null;
}

interface BrowseListing {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

interface BrowsePlace {
  name: string;
  path: string;
  kind: PlaceKind;
}

/** The facts of a video file. It plays in the preview when the player can play it; if not, a picture of it shows. */
interface VideoPreviewData {
  kind: "video";
  playUrl: string | null;
  pictureUrl: string | null;
  width: number;
  height: number;
  durationSec: number;
  fps: number;
  hasSound: boolean;
}

/** The facts of a project file, with a picture of its first clip when the media file of that clip is found. */
interface ProjectPreviewData {
  kind: "project";
  pictureUrl: string | null;
  width: number;
  height: number;
  durationSec: number;
  fps: number;
  clips: number;
  mediaFiles: number;
}

type PreviewData = VideoPreviewData | ProjectPreviewData;

type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: PreviewData }
  | { status: "error"; message: string };

const DIRECTORY_KEY = "videosage.open-directory";
const STATE_KEY = "videosage.open-dialog";
/** The width of the preview picture, in pixels. It stays sharp when the preview column is made large. */
const PICTURE_WIDTH = 960;
const PREVIEW_CACHE_LIMIT = 24;
const MIN_WIDTH = 1040;
const MIN_HEIGHT = 700;
/** Space kept between the dialog and the window edge. */
const OVERLAY_MARGIN = 28;

const VIDEO_TYPES: Record<string, string> = {
  mp4: "MP4 video", m4v: "MP4 video", mov: "MOV video", webm: "WebM video", mkv: "Matroska video", avi: "AVI video",
  wmv: "Windows Media video", mpg: "MPEG video", mpeg: "MPEG video", ts: "MPEG transport stream", mts: "AVCHD video",
  m2ts: "AVCHD video", flv: "Flash video", "3gp": "3GP video"
};

const TEXT: Record<OpenKind, { hint: string; empty: string; startPlace: PlaceKind }> = {
  video: { hint: "Choose a video file. Select a file to see it at the right.", empty: "This folder has no video files.", startPlace: "videos" },
  project: { hint: "Choose a Video Sage project (.vsage). It opens in place of the open project.", empty: "This folder has no Video Sage projects.", startPlace: "documents" }
};

interface DialogFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const RESIZE_EDGES: ResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/** Widths of the two outer columns; the file list takes what is left. */
interface ColumnWidths {
  places: number;
  preview: number;
}

const DEFAULT_COLUMNS: ColumnWidths = { places: 172, preview: 380 };
const SPLITTER_WIDTH = 6;
const PLACES_MIN = 120;
const PLACES_MAX = 400;
const PREVIEW_MIN = 200;
const FILES_MIN = 320;

const clampColumns = (columns: ColumnWidths, dialogWidth: number): ColumnWidths => {
  const available = dialogWidth - SPLITTER_WIDTH * 2;
  const places = Math.min(PLACES_MAX, Math.max(PLACES_MIN, Math.min(columns.places, available - FILES_MIN - PREVIEW_MIN)));
  const preview = Math.max(PREVIEW_MIN, Math.min(columns.preview, available - places - FILES_MIN));
  return { places, preview };
};

interface StoredState {
  frame?: DialogFrame;
  columns?: ColumnWidths;
  sort?: SortState;
}

const isSort = (value: unknown): value is SortState => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (record.key === "name" || record.key === "type" || record.key === "modified" || record.key === "size")
    && (record.direction === "asc" || record.direction === "desc");
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const extensionOf = (name: string) => name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";

/** A file's type in a word, for the Type column: Folder, Project, or a video's extension (MP4, WEBM). */
const shortType = (entry: BrowseEntry) => {
  if (entry.kind === "folder") return "Folder";
  if (entry.kind === "project") return "Project";
  return extensionOf(entry.name).toUpperCase();
};

/** Folders always come first; within each group the chosen column decides the order, then the name. */
const compareEntries = (a: BrowseEntry, b: BrowseEntry, sort: SortState) => {
  if ((a.kind === "folder") !== (b.kind === "folder")) return a.kind === "folder" ? -1 : 1;
  let result = 0;
  if (sort.key === "type") result = collator.compare(shortType(a), shortType(b));
  else if (sort.key === "modified") result = (a.modifiedMs ?? 0) - (b.modifiedMs ?? 0);
  else if (sort.key === "size") result = a.size - b.size;
  if (result === 0) result = collator.compare(a.name, b.name);
  return sort.direction === "asc" ? result : -result;
};

/** Selects the file name without its extension, the way File Explorer does. */
const selectBaseName = (input: HTMLInputElement) => {
  const dot = input.value.lastIndexOf(".");
  input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
};

const hasNumbers = (value: unknown, keys: string[]) => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return keys.every((key) => typeof record[key] === "number" && Number.isFinite(record[key]));
};

const isFrame = (value: unknown): value is DialogFrame => hasNumbers(value, ["left", "top", "width", "height"]);
const isColumns = (value: unknown): value is ColumnWidths => hasNumbers(value, ["places", "preview"]);

/** Reads the last dialog frame, column widths and sort order; ignores anything malformed. */
const loadStoredState = (): StoredState => {
  try {
    const stored = JSON.parse(localStorage.getItem(STATE_KEY) || "null") as Record<string, unknown> | null;
    if (!stored || typeof stored !== "object") return {};
    return {
      frame: isFrame(stored.frame) ? stored.frame : undefined,
      columns: isColumns(stored.columns) ? stored.columns : undefined,
      sort: isSort(stored.sort) ? stored.sort : undefined
    };
  } catch {
    return {};
  }
};

const saveStoredState = (patch: StoredState) => {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({ ...loadStoredState(), ...patch }));
  } catch {
    /* The dialog works without its stored state. */
  }
};

/**
 * Fits a requested frame into the overlay: never smaller than the minimum
 * size (or the overlay, when the window is smaller than that) and never
 * outside the overlay's padded content box.
 */
const clampFrame = (frame: DialogFrame, bounds: { width: number; height: number }): DialogFrame => {
  const minWidth = Math.min(MIN_WIDTH, bounds.width);
  const minHeight = Math.min(MIN_HEIGHT, bounds.height);
  const width = Math.min(bounds.width, Math.max(minWidth, frame.width));
  const height = Math.min(bounds.height, Math.max(minHeight, frame.height));
  return {
    width,
    height,
    left: Math.min(bounds.width - width, Math.max(0, frame.left)),
    top: Math.min(bounds.height - height, Math.max(0, frame.top))
  };
};

const centeredFrame = (size: { width: number; height: number }, bounds: { width: number; height: number }) =>
  clampFrame({
    width: size.width,
    height: size.height,
    left: (bounds.width - size.width) / 2,
    top: (bounds.height - size.height) / 2
  }, bounds);

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const formatDate = (value: number | null) => {
  if (value === null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date);
};

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
};

const typeLabel = (entry: BrowseEntry) => {
  if (entry.kind === "folder") return "Folder";
  if (entry.kind === "project") return "Video Sage project";
  return VIDEO_TYPES[extensionOf(entry.name)] ?? "Video";
};

async function buildVideoPreview(path: string): Promise<VideoPreviewData> {
  const media = await probeMedia(path);
  const facts = { width: media.width, height: media.height, durationSec: media.durationSec, fps: media.fps, hasSound: media.hasSound };
  if (media.playable) return { kind: "video", playUrl: await videoUrl(path), pictureUrl: null, ...facts };
  /* The first frame is often black, so the picture comes from a tenth of the way in, at most 5 s. */
  const picture = await pictureUrl(path, Math.min(5, media.durationSec * 0.1), PICTURE_WIDTH);
  return { kind: "video", playUrl: null, pictureUrl: picture, ...facts };
}

async function buildProjectPreview(path: string): Promise<ProjectPreviewData> {
  const project = parseProject(await readProjectFile(path));
  const first = project.clips[0];
  const media = first ? project.media.find((item) => item.id === first.mediaId) : undefined;
  let picture: string | null = null;
  if (first && media) {
    try {
      picture = await pictureUrl(media.path, first.sourceIn / project.fps, PICTURE_WIDTH);
    } catch {
      /* The media file is not there now; the preview shows the facts with no picture. */
    }
  }
  return {
    kind: "project",
    pictureUrl: picture,
    width: project.width,
    height: project.height,
    durationSec: projectEnd(project) / project.fps,
    fps: project.fps,
    clips: project.clips.length,
    mediaFiles: project.media.length
  };
}

const buildPreview = (entry: BrowseEntry): Promise<PreviewData> =>
  entry.kind === "project" ? buildProjectPreview(entry.path) : buildVideoPreview(entry.path);

/** Native controls provide play/pause, seeking, and time for the selected video. */
function VideoPreview({ url }: { url: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const player = ref.current;
    if (!player) return;
    player.src = url;
    return () => {
      player.pause();
      player.removeAttribute("src");
      player.load();
    };
  }, [url]);
  return <video ref={ref} className="open-preview-video" controls loop playsInline preload="auto" aria-label="Video preview" />;
}

const placeIcon = (kind: PlaceKind) => {
  switch (kind) {
    case "home": return <House size={16} />;
    case "desktop": return <Desktop size={16} />;
    case "documents": return <Folder size={16} />;
    case "videos": return <VideoCamera size={16} />;
    case "downloads": return <DownloadSimple size={16} />;
    default: return <HardDrive size={16} />;
  }
};

const entryIcon = (entry: BrowseEntry) => {
  if (entry.kind === "folder") return <Folder size={17} weight="fill" className="open-entry-icon folder" />;
  if (entry.kind === "project") return <img className="open-entry-icon" src="/icon.ico" alt="" />;
  return <FilmSlate size={17} weight="duotone" className="open-entry-icon image" />;
};

/**
 * The app's own Open dialog, with a preview (File Explorer shows no picture
 * for some video types, such as WebM). A video plays in the preview, or
 * shows as a picture when the player cannot play it; a project shows its
 * first clip. The dialog can be moved and resized, and the preview column
 * can be made wider or narrower with the bar at its left side. The dialog
 * remembers its size, column widths, sort order and the last folder for
 * each kind of file. Right-click a file to rename, copy or delete it.
 */
export function OpenDialog({ kind, title, hint, openLabel = "Open", multiple = false, onCancel, onOpen }: Props) {
  const directoryKey = `${DIRECTORY_KEY}.${kind}`;
  const text = TEXT[kind];
  const [places, setPlaces] = useState<BrowsePlace[]>([]);
  const [listing, setListing] = useState<BrowseListing | null>(null);
  const [notice, setNoticeState] = useState<Notice>(null);
  const [loadingDirectory, setLoadingDirectory] = useState(true);
  const [search, setSearch] = useState("");
  const [sort, setSortState] = useState<SortState>(() => loadStoredState().sort ?? DEFAULT_SORT);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renaming, setRenaming] = useState<RenameState | null>(null);
  const noticeTimer = useRef<number | null>(null);

  const setNotice = useCallback((next: Notice) => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
    setNoticeState(next);
    if (next?.tone === "success") {
      noticeTimer.current = window.setTimeout(() => setNoticeState(null), 3200);
    }
  }, []);

  useEffect(() => () => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
  }, []);

  /** Clicking the active column flips its direction; clicking another column sorts by it ascending. */
  const sortBy = useCallback((key: SortKey) => {
    setSortState((current) => {
      const next: SortState = current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" };
      saveStoredState({ sort: next });
      return next;
    });
  }, []);
  /** The entry with the focus: it shows in the preview, and the keys move from it. */
  const [selected, setSelected] = useState<BrowseEntry | null>(null);
  /** The picked files (paths); with one file, the one with the focus. Folders are never picked. */
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  /** Where a Shift + click range starts: the last entry picked without Shift. */
  const anchorRef = useRef<string | null>(null);
  /** Gives the focus to one entry and picks only it (a plain click, the arrow keys). */
  const selectOne = useCallback((entry: BrowseEntry | null) => {
    setSelected(entry);
    setPicked(new Set(entry && entry.kind !== "folder" ? [entry.path] : []));
    anchorRef.current = entry?.path ?? null;
  }, []);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [frame, setFrame] = useState<DialogFrame | null>(null);
  const [columns, setColumns] = useState<ColumnWidths>(() => loadStoredState().columns ?? DEFAULT_COLUMNS);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const directoryRequest = useRef(0);
  const previewRequest = useRef(0);
  const previewCache = useRef(new Map<string, PreviewData>());
  const listRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<DialogFrame | null>(null);
  frameRef.current = frame;

  /** Takes a file's preview out of the cache and frees its picture. */
  const forgetPreview = useCallback((path: string) => {
    const data = previewCache.current.get(path);
    if (data?.pictureUrl) URL.revokeObjectURL(data.pictureUrl);
    previewCache.current.delete(path);
  }, []);

  /* The pictures are freed when the dialog closes. */
  useEffect(() => {
    const cache = previewCache.current;
    return () => {
      for (const path of [...cache.keys()]) forgetPreview(path);
    };
  }, [forgetPreview]);

  const overlayBounds = useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay) return { width: MIN_WIDTH, height: MIN_HEIGHT };
    return {
      width: Math.max(0, overlay.clientWidth - OVERLAY_MARGIN * 2),
      height: Math.max(0, overlay.clientHeight - OVERLAY_MARGIN * 2)
    };
  }, []);

  /**
   * The dialog reopens at its last size and position, or centered at the
   * default size the first time. A ResizeObserver keeps it inside the window
   * when the window shrinks.
   */
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const stored = loadStoredState().frame;
    setFrame(stored
      ? clampFrame(stored, overlayBounds())
      : centeredFrame({ width: MIN_WIDTH + 120, height: MIN_HEIGHT }, overlayBounds()));
    const observer = new ResizeObserver(() => {
      setFrame((current) => (current ? clampFrame(current, overlayBounds()) : current));
    });
    observer.observe(overlay);
    return () => observer.disconnect();
  }, [overlayBounds]);

  const startMove = (event: React.PointerEvent<HTMLElement>) => {
    const origin = frameRef.current;
    if (!origin || event.button !== 0) return;
    /* Buttons in the header (the close button) keep their normal click behavior. */
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const bounds = overlayBounds();
    const startX = event.clientX;
    const startY = event.clientY;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);

    const onMove = (move: PointerEvent) => {
      setFrame(clampFrame({
        ...origin,
        left: origin.left + move.clientX - startX,
        top: origin.top + move.clientY - startY
      }, bounds));
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      const final = frameRef.current;
      if (final) saveStoredState({ frame: final });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  /** A drag of the bar between two columns changes the width of the places column or of the preview column. */
  const startColumnResize = (side: keyof ColumnWidths) => (event: React.PointerEvent<HTMLDivElement>) => {
    const dialog = frameRef.current;
    if (!dialog || event.button !== 0) return;
    event.preventDefault();
    const origin = columnsRef.current;
    const startX = event.clientX;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);

    const onMove = (move: PointerEvent) => {
      const dx = move.clientX - startX;
      /* The places column grows to the right; the preview column grows to the left. */
      const next = side === "places"
        ? { ...origin, places: origin.places + dx }
        : { ...origin, preview: origin.preview - dx };
      setColumns(clampColumns(next, dialog.width));
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      saveStoredState({ columns: columnsRef.current });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  /** The arrow keys change a column's width too, when its bar has the focus. */
  const onSplitterKeyDown = (side: keyof ColumnWidths) => (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const step = (event.key === "ArrowRight" ? 24 : -24) * (side === "places" ? 1 : -1);
    const next = clampColumns({ ...columnsRef.current, [side]: columnsRef.current[side] + step }, frameRef.current?.width ?? MIN_WIDTH);
    setColumns(next);
    saveStoredState({ columns: next });
  };

  const startResize = (edge: ResizeEdge) => (event: React.PointerEvent<HTMLDivElement>) => {
    const origin = frameRef.current;
    if (!origin || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = overlayBounds();
    const minWidth = Math.min(MIN_WIDTH, bounds.width);
    const minHeight = Math.min(MIN_HEIGHT, bounds.height);
    const startX = event.clientX;
    const startY = event.clientY;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);

    const onMove = (move: PointerEvent) => {
      const dx = move.clientX - startX;
      const dy = move.clientY - startY;
      let { left, top, width, height } = origin;
      if (edge.includes("e")) width = Math.min(bounds.width - left, Math.max(minWidth, origin.width + dx));
      if (edge.includes("s")) height = Math.min(bounds.height - top, Math.max(minHeight, origin.height + dy));
      if (edge.includes("w")) {
        width = Math.min(origin.left + origin.width, Math.max(minWidth, origin.width - dx));
        left = origin.left + origin.width - width;
      }
      if (edge.includes("n")) {
        height = Math.min(origin.top + origin.height, Math.max(minHeight, origin.height - dy));
        top = origin.top + origin.height - height;
      }
      setFrame({ left, top, width, height });
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      const final = frameRef.current;
      if (final) saveStoredState({ frame: final });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  /**
   * Lists a folder, and remembers it as the folder to start in the next
   * time. `selectPath` re-selects an entry after a refresh, for example the
   * file that was just renamed.
   */
  const navigate = useCallback(async (path: string, selectPath: string | null = null) => {
    const request = ++directoryRequest.current;
    setLoadingDirectory(true);
    setContextMenu(null);
    setRenaming(null);
    try {
      const next = await invoke<BrowseListing>("list_browse_directory", { path });
      if (request !== directoryRequest.current) return false;
      setListing(next);
      setNotice(null);
      setSearch("");
      selectOne(next.entries.find((entry) => entry.path === selectPath) ?? null);
      try {
        localStorage.setItem(directoryKey, next.path);
      } catch {
        /* The dialog then starts in the default folder next time. */
      }
      return true;
    } catch (error) {
      if (request === directoryRequest.current) setNotice({ tone: "error", message: String(error) });
      return false;
    } finally {
      if (request === directoryRequest.current) setLoadingDirectory(false);
    }
  }, [directoryKey, selectOne, setNotice]);

  const beginRename = useCallback((entry: BrowseEntry) => {
    setContextMenu(null);
    selectOne(entry);
    setRenaming({ path: entry.path, value: entry.name });
  }, [selectOne]);

  const commitRename = useCallback(async () => {
    const current = renaming;
    if (!current) return;
    const entry = listing?.entries.find((candidate) => candidate.path === current.path);
    setRenaming(null);
    if (!entry || current.value.trim() === "" || current.value.trim() === entry.name) return;
    try {
      const newPath = await invoke<string>("rename_browse_entry", { path: entry.path, newName: current.value });
      forgetPreview(entry.path);
      await navigate(listing?.path ?? "", newPath);
      setNotice({ tone: "success", message: `Renamed to ${current.value.trim()}` });
    } catch (error) {
      setNotice({ tone: "error", message: String(error) });
    }
  }, [forgetPreview, listing, navigate, renaming, setNotice]);

  const deleteEntry = useCallback(async (entry: BrowseEntry) => {
    setContextMenu(null);
    try {
      await invoke("delete_browse_entry", { path: entry.path });
      forgetPreview(entry.path);
      await navigate(listing?.path ?? "");
      setNotice({ tone: "success", message: `Moved ${entry.name} to the Recycle Bin` });
    } catch (error) {
      setNotice({ tone: "error", message: String(error) });
    }
  }, [forgetPreview, listing?.path, navigate, setNotice]);

  const copyEntry = useCallback(async (entry: BrowseEntry) => {
    setContextMenu(null);
    try {
      await invoke("copy_browse_entry", { path: entry.path });
      setNotice({ tone: "success", message: `Copied ${entry.name}. Paste it in File Explorer.` });
    } catch (error) {
      setNotice({ tone: "error", message: String(error) });
    }
  }, [setNotice]);

  const openContextMenu = (entry: BrowseEntry) => (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    /* A right-click on a picked file keeps the other picks. */
    if (picked.has(entry.path)) setSelected(entry);
    else selectOne(entry);
    setRenaming(null);
    setContextMenu({ x: event.clientX, y: event.clientY, entry });
  };

  /* Any click, scroll or key outside the menu closes it. */
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target as HTMLElement | null)?.closest(".open-context-menu")) close();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", close);
    window.addEventListener("wheel", close, true);
    window.addEventListener("keydown", close, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("keydown", close, true);
    };
  }, [contextMenu]);

  /* The dialog starts in the last folder that it showed for this kind of file, if that folder is still there. */
  useEffect(() => {
    let active = true;
    void (async () => {
      let nextPlaces: BrowsePlace[] = [];
      try {
        nextPlaces = await invoke<BrowsePlace[]>("browse_places");
      } catch {
        /* Places are a convenience; the dialog still works without them. */
      }
      if (!active) return;
      setPlaces(nextPlaces);
      let remembered: string | null = null;
      try {
        remembered = localStorage.getItem(directoryKey);
      } catch {
        /* Start in the default folder. */
      }
      const candidates = [
        remembered,
        nextPlaces.find((place) => place.kind === text.startPlace)?.path,
        nextPlaces.find((place) => place.kind === "home")?.path,
        ...nextPlaces.map((place) => place.path)
      ].filter((candidate): candidate is string => Boolean(candidate));
      for (const candidate of candidates) {
        if (!active) return;
        if (await navigate(candidate)) return;
      }
      if (active) {
        setNotice({ tone: "error", message: "Video Sage could not find a folder to browse." });
        setLoadingDirectory(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [directoryKey, navigate, setNotice, text.startPlace]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      /* A non-empty search box clears itself first; a second Escape closes the dialog. */
      const target = event.target as HTMLElement | null;
      if (target?.classList.contains("open-search-input") && (target as HTMLInputElement).value !== "") {
        setSearch("");
        return;
      }
      onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const visibleEntries = useMemo(() => {
    if (!listing) return [];
    const needle = search.trim().toLowerCase();
    return listing.entries
      .filter((entry) => (entry.kind === "folder" || entry.kind === kind) && (needle === "" || entry.name.toLowerCase().includes(needle)))
      .sort((a, b) => compareEntries(a, b, sort));
  }, [kind, listing, search, sort]);

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || (event.key === "Enter" && visibleEntries.length > 0)) {
      event.preventDefault();
      if (!selected || !visibleEntries.some((entry) => entry.path === selected.path)) selectOne(visibleEntries[0] ?? null);
      listRef.current?.focus();
    }
  };

  /* A search that hides the focused entry clears it; hidden picks are dropped. */
  useEffect(() => {
    if (selected && !visibleEntries.some((entry) => entry.path === selected.path)) setSelected(null);
    setPicked((current) => {
      const shown = [...current].filter((path) => visibleEntries.some((entry) => entry.path === path));
      return shown.length === current.size ? current : new Set(shown);
    });
  }, [selected, visibleEntries]);

  /**
   * A click with Ctrl adds the file to the picks or takes it out; with
   * Shift, it picks every file from the anchor to it. Folders, and every
   * click when only one file can be picked, pick only that entry.
   */
  const selectWith = (entry: BrowseEntry, { ctrlKey, shiftKey }: { ctrlKey: boolean; shiftKey: boolean }) => {
    if (!multiple || entry.kind === "folder" || (!ctrlKey && !shiftKey)) {
      selectOne(entry);
      return;
    }
    if (shiftKey) {
      const from = visibleEntries.findIndex((candidate) => candidate.path === anchorRef.current);
      const to = visibleEntries.findIndex((candidate) => candidate.path === entry.path);
      if (from < 0 || to < 0) {
        selectOne(entry);
        return;
      }
      const range = visibleEntries.slice(Math.min(from, to), Math.max(from, to) + 1);
      setPicked(new Set(range.filter((candidate) => candidate.kind !== "folder").map((candidate) => candidate.path)));
      setSelected(entry);
      return;
    }
    const next = new Set(picked);
    if (next.has(entry.path)) next.delete(entry.path);
    else next.add(entry.path);
    setPicked(next);
    setSelected(entry);
    anchorRef.current = entry.path;
  };

  /** The picked files, in list order. */
  const pickedPaths = visibleEntries.filter((entry) => picked.has(entry.path)).map((entry) => entry.path);

  useEffect(() => {
    if (!selected || selected.kind === "folder") {
      previewRequest.current++;
      setPreview({ status: "idle" });
      return;
    }
    const cached = previewCache.current.get(selected.path);
    if (cached) {
      previewRequest.current++;
      setPreview({ status: "ready", data: cached });
      return;
    }
    const request = ++previewRequest.current;
    setPreview({ status: "loading" });
    let cancelled = false;
    void buildPreview(selected)
      .then((data) => {
        if (cancelled) {
          if (data.pictureUrl) URL.revokeObjectURL(data.pictureUrl);
          return;
        }
        const cache = previewCache.current;
        cache.set(selected.path, data);
        while (cache.size > PREVIEW_CACHE_LIMIT) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          forgetPreview(oldest);
        }
        if (request === previewRequest.current) setPreview({ status: "ready", data });
      })
      .catch((error) => {
        if (!cancelled && request === previewRequest.current) {
          setPreview({ status: "error", message: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => { cancelled = true; };
  }, [forgetPreview, selected]);

  useEffect(() => {
    if (!selected) return;
    document.getElementById(`open-entry-${selected.path}`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const activate = useCallback((entry: BrowseEntry) => {
    if (entry.kind === "folder") void navigate(entry.path);
    else onOpen([entry.path]);
  }, [navigate, onOpen]);

  /** The button and Enter: every picked file when there are several, else the focused entry. */
  const openPicked = () => {
    if (pickedPaths.length > 1) onOpen(pickedPaths);
    else if (selected) activate(selected);
  };

  const goUp = useCallback(() => {
    if (listing?.parent) void navigate(listing.parent);
  }, [listing, navigate]);

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (renaming) return;
    if (visibleEntries.length === 0 && event.key !== "Backspace") return;
    const index = selected ? visibleEntries.findIndex((entry) => entry.path === selected.path) : -1;
    /* Shift + an arrow key picks every file from the anchor, as Shift + click does. */
    const moveTo = (next: number) => {
      event.preventDefault();
      const target = visibleEntries[Math.min(visibleEntries.length - 1, Math.max(0, next))];
      if (event.shiftKey) selectWith(target, { ctrlKey: false, shiftKey: true });
      else selectOne(target);
    };
    if (multiple && event.ctrlKey && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setPicked(new Set(visibleEntries.filter((entry) => entry.kind !== "folder").map((entry) => entry.path)));
      return;
    }
    switch (event.key) {
      case "ArrowDown": moveTo(index + 1); break;
      case "ArrowUp": moveTo(index <= 0 ? 0 : index - 1); break;
      case "Home": moveTo(0); break;
      case "End": moveTo(visibleEntries.length - 1); break;
      case "PageDown": moveTo(index + 10); break;
      case "PageUp": moveTo(index - 10); break;
      case "Enter":
        if (selected || pickedPaths.length > 0) {
          event.preventDefault();
          openPicked();
        }
        break;
      case "Backspace":
        event.preventDefault();
        goUp();
        break;
      case "F2":
        if (selected) {
          event.preventDefault();
          beginRename(selected);
        }
        break;
      case "Delete":
        if (selected) {
          event.preventDefault();
          void deleteEntry(selected);
        }
        break;
      default:
        break;
    }
  };

  const onRenameKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    /* Keep Enter and Escape inside the rename box; the list and the dialog must not react. */
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void commitRename();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setRenaming(null);
      listRef.current?.focus();
    } else {
      event.stopPropagation();
    }
  };

  const sortIndicator = (key: SortKey) => {
    if (sort.key !== key) return null;
    return sort.direction === "asc" ? <CaretUp size={11} weight="bold" /> : <CaretDown size={11} weight="bold" />;
  };

  const sortHeader = (key: SortKey, label: string) => (
    <button
      type="button"
      className={`open-sort-button ${sort.key === key ? "active" : ""}`}
      onClick={() => sortBy(key)}
      aria-sort={sort.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      data-tip={`Sort by ${label.toLowerCase()}`}
    >
      <span>{label}</span>
      {sortIndicator(key)}
    </button>
  );

  const crumbs = useMemo(() => {
    if (!listing) return [];
    const separator = listing.path.includes("\\") ? "\\" : "/";
    const absolutePrefix = /^[\\/]/.test(listing.path) ? separator : "";
    const parts = listing.path.split(/[\\/]+/).filter(Boolean);
    return parts.map((part, index) => {
      const isDrive = index === 0 && /^[A-Za-z]:$/.test(part);
      return {
        label: isDrive ? `${part}${separator}` : part,
        path: isDrive ? `${part}${separator}` : absolutePrefix + parts.slice(0, index + 1).join(separator)
      };
    });
  }, [listing]);

  const folderPlaces = places.filter((place) => place.kind !== "drive");
  const drivePlaces = places.filter((place) => place.kind === "drive");
  const currentPath = listing?.path ?? null;
  const selectedId = selected ? `open-entry-${selected.path}` : undefined;
  const layout = clampColumns(columns, frame?.width ?? MIN_WIDTH);
  const gridTemplateColumns =
    `${layout.places}px ${SPLITTER_WIDTH}px minmax(0, 1fr) ${SPLITTER_WIDTH}px ${layout.preview}px`;
  const ready = preview.status === "ready" ? preview.data : null;

  const renderPlace = (place: BrowsePlace) => (
    <button
      key={place.path}
      type="button"
      className={`open-place ${currentPath === place.path ? "active" : ""}`}
      onClick={() => void navigate(place.path)}
      data-tip={place.path}
    >
      {placeIcon(place.kind)} <span>{place.name}</span>
    </button>
  );

  return (
    <div ref={overlayRef} className="open-dialog-overlay" role="presentation" onPointerDown={onCancel}>
      <div
        className="open-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-file-title"
        style={frame
          ? { left: frame.left + OVERLAY_MARGIN, top: frame.top + OVERLAY_MARGIN, width: frame.width, height: frame.height }
          : { visibility: "hidden" }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {RESIZE_EDGES.map((edge) => (
          <div key={edge} className={`open-resize-handle ${edge}`} onPointerDown={startResize(edge)} aria-hidden="true" />
        ))}
        <header className="open-dialog-header" onPointerDown={startMove}>
          <div className="open-dialog-title-icon">
            {kind === "project" ? <FolderOpen size={22} weight="fill" /> : <FilmSlate size={22} weight="fill" />}
          </div>
          <div>
            <h2 id="open-file-title">{title}</h2>
            <p>{hint ?? text.hint}</p>
          </div>
          <button className="open-dialog-close" onClick={onCancel} aria-label="Close" data-tip="Close `Esc`">
            <X size={18} />
          </button>
        </header>

        <div className="open-dialog-body" style={{ gridTemplateColumns }}>
          <nav className="open-places" aria-label="Places">
            {folderPlaces.length > 0 && (
              <div className="open-places-group">
                <span>Places</span>
                {folderPlaces.map(renderPlace)}
              </div>
            )}
            {drivePlaces.length > 0 && (
              <div className="open-places-group">
                <span>Drives</span>
                {drivePlaces.map(renderPlace)}
              </div>
            )}
          </nav>

          <div
            className="open-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the places column"
            tabIndex={0}
            onPointerDown={startColumnResize("places")}
            onKeyDown={onSplitterKeyDown("places")}
          />

          <section className="open-files" aria-label="Files">
            <div className="open-toolbar">
              <div className="open-toolbar-row">
                <button
                  type="button"
                  className="open-toolbar-button"
                  onClick={goUp}
                  disabled={!listing?.parent}
                  aria-label="Go to the parent folder"
                  data-tip="Parent folder `Backspace`"
                >
                  <ArrowUp size={15} weight="bold" />
                </button>
                <div className="open-breadcrumbs" data-tip={currentPath ?? undefined}>
                  {crumbs.map((crumb, index) => (
                    <span className="open-crumb" key={crumb.path}>
                      {index > 0 && <CaretRight size={11} className="open-crumb-separator" />}
                      <button
                        type="button"
                        className={index === crumbs.length - 1 ? "current" : ""}
                        onClick={() => void navigate(crumb.path)}
                      >
                        {crumb.label}
                      </button>
                    </span>
                  ))}
                </div>
              </div>
              <div className="open-toolbar-row">
                <label className="open-search">
                  <MagnifyingGlass size={14} />
                  <input
                    type="text"
                    className="open-search-input"
                    placeholder="Search this folder"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    onKeyDown={onSearchKeyDown}
                    aria-label="Search this folder by name"
                    spellCheck={false}
                  />
                  {search !== "" && (
                    <button type="button" onClick={() => setSearch("")} aria-label="Clear search" data-tip="Clear">
                      <X size={12} weight="bold" />
                    </button>
                  )}
                </label>
                <button
                  type="button"
                  className="open-toolbar-button"
                  onClick={() => { if (currentPath) void navigate(currentPath); }}
                  disabled={!currentPath}
                  aria-label="Refresh this folder"
                  data-tip="Refresh"
                >
                  <ArrowClockwise size={15} weight="bold" />
                </button>
              </div>
            </div>

            {notice && (
              <div className={`open-listing-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
                {notice.tone === "error"
                  ? <WarningCircle size={15} weight="fill" />
                  : <CheckCircle size={15} weight="fill" />}
                <span className={notice.tone === "error" ? "selectable" : undefined}>{notice.message}</span>
                <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" data-tip="Dismiss">
                  <X size={12} weight="bold" />
                </button>
              </div>
            )}

            <div className="open-list-header">
              {sortHeader("name", "Name")}
              {sortHeader("type", "Type")}
              {sortHeader("modified", "Modified")}
              {sortHeader("size", "Size")}
            </div>
            <div
              ref={listRef}
              className="open-list"
              role="listbox"
              aria-label="Folder contents"
              aria-multiselectable={multiple || undefined}
              aria-activedescendant={selectedId}
              tabIndex={0}
              onKeyDown={onListKeyDown}
            >
              {loadingDirectory && listing === null && (
                <div className="open-list-empty"><SpinnerGap className="spin" size={18} /> Loading…</div>
              )}
              {listing !== null && visibleEntries.length === 0 && !loadingDirectory && (
                <div className="open-list-empty">
                  {search.trim() !== "" ? `Nothing here matches “${search.trim()}”.` : text.empty}
                </div>
              )}
              {visibleEntries.map((entry) => {
                const focused = selected?.path === entry.path;
                const active = picked.has(entry.path) || (focused && entry.kind === "folder");
                return (
                  <div
                    key={entry.path}
                    id={`open-entry-${entry.path}`}
                    role="option"
                    aria-selected={active}
                    className={`open-entry ${active ? "selected" : ""} ${focused && multiple ? "focused" : ""}`}
                    onClick={(event) => selectWith(entry, event)}
                    onDoubleClick={() => activate(entry)}
                    onContextMenu={openContextMenu(entry)}
                  >
                    <span className="open-entry-name">
                      {entryIcon(entry)}
                      {renaming?.path === entry.path ? (
                        <input
                          type="text"
                          className="open-rename-input"
                          value={renaming.value}
                          autoFocus
                          spellCheck={false}
                          aria-label={`New name for ${entry.name}`}
                          onFocus={(event) => selectBaseName(event.currentTarget)}
                          onChange={(event) => setRenaming({ path: entry.path, value: event.target.value })}
                          onKeyDown={onRenameKeyDown}
                          onBlur={() => void commitRename()}
                          onClick={(event) => event.stopPropagation()}
                          onDoubleClick={(event) => event.stopPropagation()}
                        />
                      ) : (
                        <span>{entry.name}</span>
                      )}
                    </span>
                    <span className="open-entry-meta" data-tip={typeLabel(entry)}>{shortType(entry)}</span>
                    <span className="open-entry-meta">{formatDate(entry.modifiedMs)}</span>
                    <span className="open-entry-meta">{entry.kind === "folder" ? "" : formatSize(entry.size)}</span>
                  </div>
                );
              })}
            </div>
          </section>

          <div
            className="open-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the preview column"
            data-tip="Drag to make the preview larger or smaller"
            tabIndex={0}
            onPointerDown={startColumnResize("preview")}
            onKeyDown={onSplitterKeyDown("preview")}
          />

          <aside className="open-preview" aria-label="Preview">
            <div className="open-preview-frame">
              {preview.status === "idle" && (
                <div className="open-preview-placeholder">
                  <FilmSlate size={34} weight="duotone" />
                  <span>{selected?.kind === "folder" ? "Double-click a folder to open it." : "Select a file to preview it."}</span>
                </div>
              )}
              {preview.status === "loading" && (
                <div className="open-preview-placeholder"><SpinnerGap className="spin" size={26} /><span>Loading preview…</span></div>
              )}
              {preview.status === "error" && (
                <div className="open-preview-placeholder error"><WarningCircle size={30} weight="fill" /><span>{preview.message}</span></div>
              )}
              {ready?.kind === "video" && ready.playUrl && <VideoPreview url={ready.playUrl} />}
              {ready && !(ready.kind === "video" && ready.playUrl) && (ready.pictureUrl
                ? <img src={ready.pictureUrl} alt={selected ? `Preview of ${selected.name}` : "Preview"} />
                : <div className="open-preview-placeholder"><FilmSlate size={34} weight="duotone" /><span>{ready.kind === "project" && ready.clips === 0 ? "This project has no clips." : "No picture: the media file of the first clip was not found."}</span></div>)}
            </div>
            {selected && (
              <dl className="open-preview-details">
                <dt>Name</dt>
                <dd className="open-preview-name" data-tip={selected.name}>{selected.name}</dd>
                <dt>Type</dt>
                <dd>{typeLabel(selected)}</dd>
                {ready && (
                  <>
                    <dt>{ready.kind === "project" ? "Frame size" : "Dimensions"}</dt>
                    <dd>{ready.width} × {ready.height} px</dd>
                    <dt>Length</dt>
                    <dd>{formatDuration(ready.durationSec)}</dd>
                    <dt>Frame rate</dt>
                    <dd>{formatFps(ready.fps)} fps</dd>
                  </>
                )}
                {ready?.kind === "video" && (
                  <>
                    <dt>Sound</dt>
                    <dd>{ready.hasSound ? "Yes" : "No"}</dd>
                  </>
                )}
                {ready?.kind === "project" && (
                  <>
                    <dt>Clips</dt>
                    <dd>{ready.clips}</dd>
                    <dt>Media files</dt>
                    <dd>{ready.mediaFiles}</dd>
                  </>
                )}
                <dt>Modified</dt>
                <dd>{formatDate(selected.modifiedMs)}</dd>
                {selected.kind !== "folder" && (
                  <>
                    <dt>File size</dt>
                    <dd>{formatSize(selected.size)}</dd>
                  </>
                )}
              </dl>
            )}
          </aside>
        </div>

        {contextMenu && (
          <div
            className="open-context-menu"
            role="menu"
            aria-label={`Actions for ${contextMenu.entry.name}`}
            style={{
              left: Math.min(contextMenu.x, window.innerWidth - 190),
              top: Math.min(contextMenu.y, window.innerHeight - 130)
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button type="button" role="menuitem" onClick={() => beginRename(contextMenu.entry)}>
              <PencilSimple size={15} /> <span>Rename</span> <kbd>F2</kbd>
            </button>
            <button type="button" role="menuitem" onClick={() => void copyEntry(contextMenu.entry)}>
              <Copy size={15} /> <span>Copy</span>
            </button>
            <button type="button" role="menuitem" className="danger" onClick={() => void deleteEntry(contextMenu.entry)}>
              <Trash size={15} /> <span>Delete</span> <kbd>Del</kbd>
            </button>
          </div>
        )}

        <footer className="open-dialog-actions">
          {multiple && <span className="open-dialog-hint">Ctrl + click or Shift + click to select several files.</span>}
          <button className="button secondary" onClick={onCancel}>Cancel</button>
          <button
            className="button primary"
            disabled={!selected && pickedPaths.length === 0}
            onClick={openPicked}
          >
            <FolderOpen size={18} weight="fill" /> {pickedPaths.length > 1 ? `${openLabel} ${pickedPaths.length} files` : openLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
