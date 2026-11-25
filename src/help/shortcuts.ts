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
      { keys: ["Ctrl+W"], does: "Close the project" },
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
      { keys: ["S"], does: "Split at the playhead (the selected clips, or all clips there)" },
      { keys: ["Ctrl+J"], does: "Join the selected clips" },
      { keys: ["R"], does: "Reverse the selected clips (play them from end to start)" },
      { keys: ["Ctrl+Drag"], does: "On a clip's end: stretch the clip (slower when longer, faster when shorter)" }
    ]
  },
  {
    title: "Playback",
    shortcuts: [
      { keys: ["Space"], does: "Play or pause" },
      { keys: ["L"], does: "Turn loop play on or off (the selected clips, or the timeline)" },
      { keys: ["Left", "Right"], does: "Go one frame back or forward" },
      { keys: ["Shift+Left", "Shift+Right"], does: "Go 10 frames back or forward" },
      { keys: ["Ctrl+Left", "Ctrl+Right"], does: "Go one second back or forward" },
      { keys: ["Ctrl+Shift+Left", "Ctrl+Shift+Right"], does: "Go 10 seconds back or forward" },
      { keys: ["Home", "End"], does: "Go to the start or the end" },
      { keys: ["Shift+Home"], does: "Go to the start of the selected clips" }
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
