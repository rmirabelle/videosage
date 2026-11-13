/**
 * Every key of the app, in groups, for the keyboard shortcuts sheet. Keep it
 * the same as the menus (src/App.tsx) when a menu changes.
 */

export interface Shortcut {
  /** The keys, each as the menus write it ("Ctrl+S"); several mean "or". */
  keys: readonly string[];
  /** What it does, short. */
  does: string;
}

export interface ShortcutGroup {
  title: string;
  shortcuts: readonly Shortcut[];
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: "Project",
    shortcuts: [
      { keys: ["Ctrl+N"], does: "New project" },
      { keys: ["Ctrl+O"], does: "Open a project" },
      { keys: ["Ctrl+S"], does: "Save the project" },
      { keys: ["Ctrl+Shift+S"], does: "Save the project as" },
      { keys: ["Ctrl+I"], does: "Import media" },
      { keys: ["Ctrl+E"], does: "Export the video" }
    ]
  },
  {
    title: "Edit",
    shortcuts: [
      { keys: ["Ctrl+Z"], does: "Undo" },
      { keys: ["Ctrl+Y"], does: "Redo" },
      { keys: ["Ctrl+X"], does: "Cut the selected clips" },
      { keys: ["Ctrl+C"], does: "Copy the selected clips" },
      { keys: ["Ctrl+V"], does: "Paste at the playhead" },
      { keys: ["Delete"], does: "Delete the selected clips" },
      { keys: ["Ctrl+A"], does: "Select all clips" },
      { keys: ["S"], does: "Split the clip at the playhead" },
      { keys: ["Ctrl+J"], does: "Join the selected clips" }
    ]
  },
  {
    title: "Playback",
    shortcuts: [
      { keys: ["Space"], does: "Play or pause" },
      { keys: ["Left", "Right"], does: "Go one frame back or forward" },
      { keys: ["Home", "End"], does: "Go to the start or the end" }
    ]
  },
  {
    title: "View",
    shortcuts: [
      { keys: ["Ctrl+="], does: "Zoom in" },
      { keys: ["Ctrl+-"], does: "Zoom out" },
      { keys: ["Ctrl+0"], does: "Zoom to fit" },
      { keys: ["N"], does: "Turn snapping on or off" },
      { keys: ["?"], does: "Show this sheet" }
    ]
  }
];
