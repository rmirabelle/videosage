import { ArrowLineDown, CircleNotch, FilmStrip, MagnifyingGlass, Plus, SpeakerSlash, Warning, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { MediaItem } from "../editor/model";
import { formatDuration, formatFps, thumbnailUrl } from "../lib/media";
import type { ProxyState } from "../lib/videos";

interface Props {
  media: MediaItem[];
  /** The preview copies of the files that the player cannot play directly, by file path. */
  proxies: Readonly<Record<string, ProxyState>>;
  /** The paths of the media files that were not found when the project opened. */
  missing: ReadonlySet<string>;
  /** The user wants to show where a missing file is now. */
  onRelink: (media: MediaItem) => void;
  /** The names of files that an import reads now. */
  importing: string[];
  /** True while the user holds dragged files over the window. */
  dropActive: boolean;
  onImport: () => void;
  onRemove: (media: MediaItem) => void;
  /** Puts the media file on the timeline, after the last clip. */
  onAddToTimeline: (media: MediaItem) => void;
}

/** The picture of a media file; a film icon shows until the picture is ready, or if it cannot be made. */
function Thumbnail({ media }: { media: MediaItem }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    thumbnailUrl(media).then((made) => { if (!cancelled) setUrl(made); }).catch(() => {});
    return () => { cancelled = true; };
  }, [media]);
  return (
    <div className="media-thumbnail">
      {url ? <img src={url} alt="" draggable={false} /> : <FilmStrip size={26} />}
      <span className="media-duration">{formatDuration(media.durationSec)}</span>
    </div>
  );
}

/** The state of a file's preview copy, as a line in the media list. Nothing shows when the copy is ready. */
function ProxyBadge({ state }: { state: ProxyState | undefined }) {
  if (state?.status === "ready") return null;
  if (state?.status === "failed") return <span className="warning" title="Video Sage could not make a preview copy of this file. The preview is black for it; the export still uses the file."><Warning size={13} /> No preview</span>;
  const percent = state ? Math.round(state.fraction * 100) : 0;
  return <span className="working" title="The preview player cannot play this file directly. Video Sage makes a preview copy of it."><CircleNotch className="spin" size={13} /> Preview copy {percent}%</span>;
}

/** The media list: the imported video files, with the Import button. */
export function MediaBin({ media, proxies, missing, onRelink, importing, dropActive, onImport, onRemove, onAddToTimeline }: Props) {
  const empty = media.length === 0 && importing.length === 0;
  return (
    <section className={`panel media-bin ${dropActive ? "drop-active" : ""}`} aria-label="Media">
      <header className="panel-header">
        <h2>Media</h2>
        <button className="button secondary small" onClick={onImport} title="Import video files (Ctrl+I)">
          <Plus size={13} weight="bold" /> Import
        </button>
      </header>
      {empty ? (
        <div className="media-empty">
          <FilmStrip size={34} />
          <p>Import video files, or drop them here.</p>
          <button className="button primary" onClick={onImport}><Plus size={14} weight="bold" /> Import Media</button>
        </div>
      ) : (
        <ul className="media-list">
          {media.map((item) => (
            <li key={item.id} className="media-item" onDoubleClick={() => onAddToTimeline(item)}>
              <Thumbnail media={item} />
              <div className="media-text">
                <span className="media-name" title={item.path}>{item.name}</span>
                <span className="media-facts">{item.width}×{item.height} · {formatFps(item.fps)} fps</span>
                <span className="media-badges">
                  {!item.hasSound && <span title="This video has no sound"><SpeakerSlash size={13} /> No sound</span>}
                  {missing.has(item.path)
                    ? <span className="warning" title={`Video Sage cannot find ${item.path}`}><Warning size={13} /> File not found</span>
                    : !item.playable && <ProxyBadge state={proxies[item.path]} />}
                </span>
                {missing.has(item.path) && (
                  <button className="button secondary small media-find" onClick={() => onRelink(item)} onDoubleClick={(event) => event.stopPropagation()} title="Show where this file is now">
                    <MagnifyingGlass size={12} weight="bold" /> Find file
                  </button>
                )}
              </div>
              <div className="media-actions" onDoubleClick={(event) => event.stopPropagation()}>
                <button onClick={() => onAddToTimeline(item)} aria-label={`Put ${item.name} on the timeline`} title="Put on the timeline, after the last clip">
                  <ArrowLineDown size={13} />
                </button>
                <button className="media-remove" onClick={() => onRemove(item)} aria-label={`Remove ${item.name}`} title="Remove from the project">
                  <X size={13} />
                </button>
              </div>
            </li>
          ))}
          {importing.map((name) => (
            <li key={`importing-${name}`} className="media-item importing">
              <div className="media-thumbnail"><CircleNotch className="spin" size={22} /></div>
              <div className="media-text">
                <span className="media-name">{name}</span>
                <span className="media-facts">Importing…</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
