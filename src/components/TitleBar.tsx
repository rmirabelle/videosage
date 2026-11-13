import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DownloadSimple } from "@phosphor-icons/react";
import { WindowControls } from "./WindowControls";

interface Props {
  updateAvailable: boolean;
  onAbout: () => void;
  /** The open project's file name, or "Untitled Project" for a project that was never saved. */
  fileName: string;
  /** True when the project has changes that are not saved; a red asterisk shows. */
  dirty: boolean;
}

/** The window's title bar: the app name, the open project, the update button when an update is ready, and the window controls. */
export function TitleBar({ updateAvailable, onAbout, fileName, dirty }: Props) {
  return (
    <header
      className="titlebar"
      data-tauri-drag-region
      onDoubleClick={() => isTauri() && getCurrentWindow().toggleMaximize()}
    >
      <div className="brand" data-tauri-drag-region>
        <img src="/icon.ico" alt="" />
        <span>Video Sage</span>
        {/* Only the dev build shows this, so it is never mixed up with the installed app. */}
        {import.meta.env.DEV && <span className="brand-dev">DEV</span>}
      </div>
      <div className="titlebar-file" data-tauri-drag-region>
        <span className="titlebar-file-name">{fileName}</span>
        {dirty && <span className="titlebar-dirty">*</span>}
      </div>
      {updateAvailable && (
        <button className="titlebar-update-button" onClick={onAbout}>
          <DownloadSimple size={14} weight="bold" /> Update available
        </button>
      )}
      <div className="titlebar-spacer" data-tauri-drag-region />
      <WindowControls />
    </header>
  );
}
