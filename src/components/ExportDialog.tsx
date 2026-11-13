import { save } from "@tauri-apps/plugin-dialog";
import { CheckCircle, CircleNotch, Export, FolderOpen, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { exportSegments, sizeForHeight } from "../editor/export";
import { projectEnd, type Project } from "../editor/model";
import { cancelExport, EXPORT_CANCELLED, exportVideo, onExportProgress, showInFolder, type ExportQuality } from "../lib/export";
import { formatDuration, formatFps } from "../lib/media";

interface Props {
  project: Project;
  /** The paths of the media files that were not found when the project opened. */
  missing: ReadonlySet<string>;
  /** The file that the save dialog shows first, for example "C:\Videos\My Project.mp4". */
  suggestedPath: string;
  onClose: () => void;
}

type State =
  | { kind: "settings"; error?: string }
  | { kind: "running"; output: string; fraction: number; stopping: boolean }
  | { kind: "done"; output: string };

const HEIGHTS = [2160, 1440, 1080, 720, 480];
const RATES = [24, 25, 30, 50, 60];

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * The export dialog: the user sets the size, the frame rate and the quality,
 * and chooses the file. Then the dialog shows how far the export is, with a
 * button to stop it. The dialog cannot close while the export runs.
 */
export function ExportDialog({ project, missing, suggestedPath, onClose }: Props) {
  const [state, setState] = useState<State>({ kind: "settings" });
  const [height, setHeight] = useState(project.height);
  const [fps, setFps] = useState(project.fps);
  const [quality, setQuality] = useState<ExportQuality>("standard");
  const stateRef = useRef(state);
  stateRef.current = state;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const running = state.kind === "running";
  const size = sizeForHeight(project, height);
  const lost = project.media.filter((item) => missing.has(item.path) && project.clips.some((clip) => clip.mediaId === item.id));

  /* While the dialog is open, keys do not reach the app's shortcuts. Esc closes it, but not during an export. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === "Escape" && stateRef.current.kind !== "running") closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  useEffect(() => {
    const unlisten = onExportProgress((fraction) => {
      setState((current) => current.kind === "running" ? { ...current, fraction } : current);
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, []);

  const start = async () => {
    const output = await save({ title: "Export Video", defaultPath: suggestedPath, filters: [{ name: "MP4 video", extensions: ["mp4"] }] });
    if (!output) return;
    setState({ kind: "running", output, fraction: 0, stopping: false });
    try {
      await exportVideo({ output, width: size.width, height: size.height, fps, quality, segments: exportSegments(project, fps) });
      setState({ kind: "done", output });
    } catch (error) {
      const message = String(error);
      setState(message === EXPORT_CANCELLED ? { kind: "settings" } : { kind: "settings", error: `The export failed. ${message}` });
    }
  };

  const stop = () => {
    setState((current) => current.kind === "running" ? { ...current, stopping: true } : current);
    void cancelExport();
  };

  const heights = [...new Set([project.height, ...HEIGHTS])].sort((a, b) => b - a);
  const rates = [...new Set([project.fps, ...RATES])].sort((a, b) => a - b);

  return (
    <div className="about-dialog-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget && !running) onClose(); }}>
      <div className="about-dialog confirm-dialog export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title">
        {!running && <button className="about-dialog-close" onClick={onClose} aria-label="Close" data-tip="Close `Esc`"><X size={18} /></button>}
        <div className="confirm-dialog-content">
          <h2 id="export-title">Export Video</h2>
          {state.kind === "settings" && (
            <>
              <p>The export makes one MP4 file (H.264 video, AAC sound) of the timeline, {formatDuration(projectEnd(project) / project.fps)} long.</p>
              <div className="export-fields">
                <label htmlFor="export-size">Size</label>
                <select id="export-size" value={height} onChange={(event) => setHeight(Number(event.target.value))}>
                  {heights.map((value) => {
                    const option = sizeForHeight(project, value);
                    return <option key={value} value={value}>{option.width} × {option.height}{value === project.height ? " (project)" : ""}</option>;
                  })}
                </select>
                <label htmlFor="export-rate">Frame rate</label>
                <select id="export-rate" value={fps} onChange={(event) => setFps(Number(event.target.value))}>
                  {rates.map((value) => <option key={value} value={value}>{formatFps(value)} fps{value === project.fps ? " (project)" : ""}</option>)}
                </select>
                <label htmlFor="export-quality">Quality</label>
                <select id="export-quality" value={quality} onChange={(event) => setQuality(event.target.value as ExportQuality)}>
                  <option value="standard">Standard (smaller file)</option>
                  <option value="high">High (larger file)</option>
                </select>
              </div>
              {lost.length > 0 && (
                <div className="export-status error"><WarningCircle size={17} weight="fill" /> <span>Video Sage cannot find {lost.map((item) => item.name).join(", ")}. Find the file in the Media list, or remove its clips, before the export.</span></div>
              )}
              {state.error && <div className="export-status error"><WarningCircle size={17} weight="fill" /> <span className="selectable">{state.error}</span></div>}
            </>
          )}
          {state.kind === "running" && (
            <>
              <div className="export-status"><CircleNotch className="spin" size={16} /> {state.stopping ? "Stopping the export…" : <>Exporting {fileName(state.output)} — {Math.round(state.fraction * 100)}%</>}</div>
              <div className="about-update-progress"><i style={{ width: `${Math.round(state.fraction * 100)}%` }} /></div>
            </>
          )}
          {state.kind === "done" && (
            <div className="export-status success"><CheckCircle size={17} weight="fill" /> <span><strong>{fileName(state.output)}</strong> is saved.</span></div>
          )}
        </div>
        <div className="about-dialog-actions confirm-dialog-actions">
          {state.kind === "settings" && (
            <>
              <button className="button secondary" onClick={onClose}>Cancel</button>
              <button className="button primary" onClick={() => void start()} disabled={lost.length > 0}><Export size={15} weight="bold" /> Export…</button>
            </>
          )}
          {state.kind === "running" && <button className="button secondary" onClick={stop} disabled={state.stopping}>Stop the Export</button>}
          {state.kind === "done" && (
            <>
              <button className="button secondary" onClick={() => void showInFolder(state.output).catch(() => {})}><FolderOpen size={15} /> Show in Folder</button>
              <button className="button primary" onClick={onClose}>Close</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
