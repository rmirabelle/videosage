# VideoSage repository instructions

Video Sage is a simple linear video editor with video layers (a higher layer
shows on top; the sound of all layers plays).
Tauri 2 + React + FFmpeg. `PLAN.md` holds the build plan and its phases.

## Layout

- `src/editor/` holds the timeline data and its operations (split, join,
  move, trim, snap, undo). Keep it free of React; every operation has a test.
- `src/components/` holds the UI. The title bar, menu bar and dialogs are the
  same as the other Sage apps (copied from KaleidoSage).
- `src-tauri/src/updater.rs` checks `rmirabelle/videosage` GitHub releases.
- `src-tauri/ffmpeg/` holds `ffmpeg.exe` and `ffprobe.exe`. They are not in
  Git; `tools/get-ffmpeg.ps1` downloads them.
- Dev ports: 14530 (Vite), 14531 (HMR), 14532 (preview).

## Release memory

- Read `docs/RELEASING.md` before changing installer configuration, preparing a
  release, or publishing.
- Preserve the shared XSage per-user installer contract. Keep
  `src-tauri/installer.nsi`, the bundled `icons/icon.ico` resource, and the
  Windows GUI-subsystem attribute intact.
- Use `set-version.ps1` and `publish.ps1`; do not manually create release tags or
  GitHub releases. A local build is not authorization to publish.

## Development process

- The dev app must run outside Claude's process tree. Everything Claude starts
  directly stops when Claude quits, and the user's dev app (and its unsaved
  work) goes down with it. Start it only with `start-dev.vbs`, opened through
  Explorer:
  `Start-Process "$env:WINDIR\explorer.exe" '"D:\Code\VideoSage\start-dev.vbs"'`.
  It runs `npm run tauri dev -- --no-watch` with no console window, and writes
  its output to `dev.log` in the project folder: read that file for build
  errors and for `[client] hot update applied: <file>`. Start or restart the
  dev app only when the user asks or agrees.
- Stop it with `.\kill-dev.ps1`. It first closes the window the gentle way,
  so unsaved changes get the "Save changes?" question, and waits up to 10
  seconds for the app to close. Exit code 1 means the app is still open: tell
  the user, and never use `-Force` (it loses unsaved work) without their
  go-ahead. Then it tree-kills what is left of `videosage.exe` and frees ports
  14530 and 14531.
- Do not start the dev app while an installed Video Sage is running; the
  single-instance plugin would route the launch to it.
