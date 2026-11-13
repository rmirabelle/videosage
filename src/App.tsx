import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useState } from "react";
import { AboutDialog } from "./components/AboutDialog";
import { MenuBar, type Menu } from "./components/MenuBar";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { TitleBar } from "./components/TitleBar";
import { revealMainWindow } from "./lib/splash";
import { checkForUpdate, getAppVersion, type UpdateInfo } from "./lib/updater";

/** A menu command that a later build phase adds; it shows disabled until then. */
const later = { disabled: true, run: () => {} };

export default function App() {
  const [appVersion, setAppVersion] = useState("");
  const [startupUpdate, setStartupUpdate] = useState<UpdateInfo | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    void revealMainWindow();
    if (!isTauri()) return;
    let cancelled = false;
    getAppVersion().then((version) => { if (!cancelled) setAppVersion(version); }).catch(() => {});
    checkForUpdate().then((info) => { if (!cancelled && info) setStartupUpdate(info); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "?" && !(event.target as HTMLElement | null)?.closest("input, textarea")) setShortcutsOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
        { label: "Import Media…", shortcut: "Ctrl+I", ...later },
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
        { label: "Select All", shortcut: "Ctrl+A", ...later },
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
        { label: "Zoom In", shortcut: "Ctrl+=", ...later },
        { label: "Zoom Out", shortcut: "Ctrl+-", ...later },
        { label: "Zoom to Fit", shortcut: "Ctrl+0", ...later },
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
  ], []);

  return (
    <div className="app">
      <TitleBar updateAvailable={startupUpdate !== null} onAbout={() => setAboutOpen(true)} fileName="Untitled Project" dirty={false} />
      <MenuBar menus={menus} />
      <main className="workspace">The editor comes in the next build phases.</main>
      {aboutOpen && <AboutDialog version={appVersion} initialUpdateInfo={startupUpdate} onClose={() => setAboutOpen(false)} />}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}
