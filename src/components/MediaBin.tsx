import { CircleNotch, FilmStrip, Plus, SpeakerSlash, Warning, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { MediaItem } from "../editor/model";
import { formatDuration, formatFps, thumbnailUrl } from "../lib/media";

interface Props {
  media: MediaItem[];
  /** The names of files that an import reads now. */
  importing: string[];
  /** True while the user holds dragged files over the window. */
  dropActive: boolean;
  onImport: () => void;
  onRemove: (media: MediaItem) => void;
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

/** The media list: the imported video files, with the Import button. */
export function MediaBin({ media, importing, dropActive, onImport, onRemove }: Props) {
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
            <li key={item.id} className="media-item">
              <Thumbnail media={item} />
              <div className="media-text">
                <span className="media-name" title={item.path}>{item.name}</span>
                <span className="media-facts">{item.width}×{item.height} · {formatFps(item.fps)} fps</span>
                <span className="media-badges">
                  {!item.hasSound && <span title="This video has no sound"><SpeakerSlash size={13} /> No sound</span>}
                  {!item.playable && <span className="warning" title="The preview player cannot play this file directly. Video Sage makes a preview copy of it."><Warning size={13} /> Needs a preview copy</span>}
                </span>
              </div>
              <button className="media-remove" onClick={() => onRemove(item)} aria-label={`Remove ${item.name}`} title="Remove from the project">
                <X size={13} />
              </button>
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
