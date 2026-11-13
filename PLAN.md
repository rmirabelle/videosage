# Video Sage build plan

Written 2026-11-13. This is the plan for the first build session. Nothing is built yet.
The folder holds only `readme.md`, `icon-pack.zip` and this file.

## 1. What version 1 does

A simple linear video editor for Windows with one video track.

- Import video files into a media list.
- Put clips on one timeline track.
- Edit clips: select, drag, trim the two ends, split at the playhead, join, cut, copy, paste, delete.
- Snap a dragged clip or trimmed end to other clip ends, to the playhead and to time 0.
- Play the timeline in a preview, with scrub and frame step.
- Undo and redo for every edit.
- Save and open a project file.
- Export the timeline to one MP4 file.

Not in version 1: a separate audio track, more video tracks, transitions, titles, effects, colour tools, speed change.

## 2. Assumptions to confirm before the build

These are my choices where the request did not say. Confirm or change them at the start of the build session.

1. **Clip sound.** Each clip keeps the sound from its own video file, in preview and in export. The later "audio track" feature is a second, separate track for music.
2. **Gaps.** A clip can be at any position on the track. An empty gap plays as black with silence. Clips cannot overlap: a clip dropped on another clip moves to the nearest free position. A "Close gaps" command moves all clips together.
3. **Project file.** `.vsage` is one JSON file that holds paths to the media files. It does not hold the videos (KaleidoSage's `.ksage` ZIP holds its media; videos are too large for that).
4. **Export.** The export always encodes again (H.264 + AAC in MP4) so cuts are exact to the frame. A fast copy without encode cuts only at key frames, so it is not in version 1.
5. **GitHub repository.** Public `rmirabelle/videosage`, the same pattern as `rmirabelle/kaleidosage`. The updater needs no token for a public repository.

## 3. Conventions taken from KaleidoSage

Source: `D:\Code\KaleidoSage`. Copy the file, then change the names. Do not write these again from zero.

### Stack

- Tauri 2, React 19, TypeScript 5.8, Vite 7, Vitest 3. `@tauri-apps/cli` pinned to the version KaleidoSage uses (2.10.1 on the plan date).
- `@phosphor-icons/react` for icons.
- Plugins: `tauri-plugin-dialog`, `tauri-plugin-window-state`, `tauri-plugin-single-instance` (Windows).
- Rust crates: `serde`, `serde_json`, `anyhow`, `tokio`, `reqwest` (rustls, json, stream), `futures-util`, `tempfile`, `windows`.
- Alias `@` to `./src`. Vite file watch with polling, as in KaleidoSage `vite.config.ts`.

### Names

| Item | Value |
| --- | --- |
| Product name | `Video Sage` |
| Package, crate, exe | `videosage` (`videosage_lib`, `videosage.exe`) |
| Identifier | `com.robmirabelle.videosage` |
| Installer asset | `VideoSage_<version>_x64-setup.exe` |
| Updater user agent | `VideoSage-Updater` |
| Project file | `.vsage` |
| Dev ports | 14530 (Vite), 14531 (HMR), 14532 (preview). ChatSage uses 14520 and 14521. |
| First version | `0.1.0` |

### Files to copy and adapt

| KaleidoSage file | Change for Video Sage |
| --- | --- |
| `src-tauri/installer.nsi` | **Copy from `D:/Code/IconSage/src-tauri/installer.nsi` before the first build** (global rule 4). No changes. |
| `src-tauri/tauri.conf.json` | Names, ports, window size. Keep: splash + main windows, `decorations: false`, `targets: ["nsis"]`, `nsis.template: "installer.nsi"`, `icons/icon.ico` in `resources`. Remove the WebXR browser arguments. |
| `src-tauri/capabilities/default.json` | Same permission list. |
| `src-tauri/src/main.rs` | Same (`windows_subsystem = "windows"`, per-monitor DPI). |
| `src-tauri/src/updater.rs` | Repository URLs and user agent only. |
| `src/lib/updater.ts`, `src/lib/splash.ts` | Names only. |
| `src-tauri/src/video_stream.rs` | Keep the `video://` protocol with range reads. Remove the upload and audio-playlist parts not needed. |
| `src-tauri/src/export_stream.rs` | Use as a pattern for how to find and run the bundled FFmpeg and how to test for GPU encode. The export itself is different (see section 6). |
| `tools/get-ffmpeg.ps1` | Also copy `ffprobe.exe` from the same download. |
| `src/components/TitleBar.tsx`, `WindowControls.tsx`, `MenuBar.tsx`, `ContextMenu.tsx`, `ConfirmDialog.tsx`, `AboutDialog.tsx`, `ShortcutsDialog.tsx`, `Dropdown.tsx`, `Slider.tsx`, `LoadingOverlay.tsx` | Copy with their CSS from `src/index.css`. `WindowControls` must keep the cursor-poll hover fix (global rule 7) and its Rust `cursor_position` command. |
| `splash.html`, `index.html`, `src/main.tsx` (client log to `dev.log`) | Names and logo. |
| `set-version.ps1`, `publish.ps1`, `kill-dev.ps1`, `start-dev.vbs` | Names, ports, repository. In `publish.ps1` add `ffprobe.exe` to the FFmpeg checks. |
| `.gitignore` | Same pattern. Ignore `/icon-pack.zip`, `ffmpeg.exe`, `ffprobe.exe`. |
| `CLAUDE.md`, `docs/RELEASING.md` | Write the Video Sage versions: layout, release rules, dev process (start only with `start-dev.vbs` through Explorer, stop with `kill-dev.ps1`, never `-Force` without a go-ahead). |

### Icon pack

`icon-pack.zip` holds `windows/icon.ico` and Android PNG files.

- `windows/icon.ico` → `src-tauri/icons/icon.ico` and `public/icon.ico`.
- `android/play_store_512.png` → `src-tauri/icons/icon.png` and `public/video-sage-logo.png` (splash, About dialog).
- The ZIP stays out of Git.

### Standard app menu

Custom `MenuBar` under the custom title bar, as in KaleidoSage.

- **File:** New, Open, Save, Save As, Import Media, Export Video, Exit.
- **Edit:** Undo, Redo, Cut, Copy, Paste, Delete, Select All, Split at Playhead, Join Clips, Close Gaps.
- **View:** Zoom In, Zoom Out, Zoom to Fit, Snapping (on/off).
- **Help:** Keyboard Shortcuts, Check for Updates, About Video Sage.

### Other rules that apply

- Comments of two or more lines use `/** */` blocks, never stacked `//` (global rule 3).
- No plain secret text in the binary (global rule 5). Version 1 needs no secret.
- FFmpeg is a GPL build: ship `ffmpeg/LICENSE.txt` and `ffmpeg/SOURCE.txt` as KaleidoSage does.

## 4. Code layout

```
src/
  editor/          no React in this folder; all of it has unit tests
    time.ts        frame <-> seconds, timecode text
    model.ts       Project, MediaItem, Clip types
    operations.ts  split, join, move, trim, cut, copy, paste, delete, close gaps
    snap.ts        snap targets and the nearest target in range
    history.ts     undo and redo stack
    projectFile.ts read, write and version check of .vsage
  playback/
    player.ts      timeline clock and the two <video> elements
  components/      TitleBar, MenuBar, MediaBin, Preview, Transport, Timeline, ExportDialog, ...
  lib/             updater.ts, splash.ts, media.ts (invoke wrappers), shortcuts.ts
src-tauri/src/
  lib.rs, main.rs, updater.rs, video_stream.rs
  probe.rs         ffprobe: duration, frame rate, size, codecs, has sound
  thumbnails.rs    FFmpeg frame strips, cached on disk
  proxy.rs         preview copy for files that WebView2 cannot play
  export.rs        builds and runs the FFmpeg export
  project.rs       read and write .vsage, recent files
```

## 5. Data model

Timeline time is a whole number of **frames** at the project frame rate. The project takes its frame rate and frame size from the first imported clip; the user can change them in the export dialog. Whole frames prevent rounding errors and make snap and join exact.

```ts
type MediaItem = { id: string; path: string; durationSec: number; fps: number; width: number; height: number; hasSound: boolean; proxyPath?: string };
type Clip = { id: string; mediaId: string; start: number; sourceIn: number; length: number };  // all in project frames
type Project = { version: 1; fps: number; width: number; height: number; media: MediaItem[]; clips: Clip[] };
```

- `clips` stays sorted by `start`, with no overlap.
- Every operation is a pure function `(project, arguments) => project`. The history keeps the old project objects.
- **Split:** one clip becomes two at the playhead; `sourceIn` of the second part moves forward by the same number of frames.
- **Join:** allowed only for two selected clips that touch, come from the same media, and continue in the source (`a.sourceIn + a.length === b.sourceIn`). Otherwise the command is disabled.
- **Clipboard:** copy holds clips with positions relative to the first clip. Paste puts them at the playhead and moves later clips right to make room.

## 6. Hard parts and the chosen method

### Preview playback

- The preview uses HTML `<video>` elements that read files through the `video://` protocol.
- Two `<video>` elements: one plays the current clip, the other loads and seeks the next clip before the cut, then they swap. This hides the load delay at each cut.
- A timeline clock (from `requestAnimationFrame` and `performance.now()`) is the master. The player sets `currentTime` at each clip start and corrects drift above about one frame. In a gap it shows black.
- Scrub and frame step set `currentTime` directly. Use `requestVideoFrameCallback` to know when the frame is shown.
- **Risk:** a cut is not always exact to the frame in the preview. This is acceptable for the preview; the export is exact.

### Files that WebView2 cannot play

- At import, `probe.rs` reads the codecs. H.264, VP9 and AV1 in MP4, WebM or MOV play directly.
- For other files (for example HEVC without the Windows extension, ProRes, MKV), `proxy.rs` makes an H.264 720p preview copy with many key frames in the app cache folder. The export always reads the original file.

### Timeline strips

- `thumbnails.rs` asks FFmpeg for small frames at fixed time steps and writes one strip image per media file to the cache folder (key: path + size + modified time).
- The timeline draws the part of the strip that the clip uses. Draw with DOM elements first; change to a canvas only if a long timeline is slow.

### Export

- `export.rs` writes an FFmpeg command with one input per clip segment (`-ss` and `-t` before `-i`), a `filter_complex` that scales and pads each segment to the project size and frame rate, black and silent segments for gaps and for clips without sound, and one `concat` filter with `v=1:a=1`.
- Encoder: test NVENC, Quick Sync and AMF as KaleidoSage does in `gpu_can_encode`; fall back to `libx264`. Sound is AAC.
- Progress comes from `-progress pipe:1`. Cancel kills the FFmpeg process and deletes the part file.
- For a very long timeline the command line can become too long: write the filter graph to a file and use `-filter_complex_script`.

## 7. Build phases

Each phase ends with a working app and a commit.

1. **Shell (done).** Copy the conventions in section 3. `git init`. Result: an empty Video Sage window with splash, title bar, menu bar, About dialog, window state, single instance. `npm run build` and `cargo check` pass. Copy `installer.nsi` now.
2. **Editor core (done).** `src/editor/` with Vitest tests for every operation, snap and history. No UI.
3. **Import.** FFmpeg and ffprobe in place. Import dialog and drag-and-drop of files, probe, media list with thumbnails.
4. **Timeline view.** Ruler, zoom, scroll, clips with strips, playhead, selection (click, Ctrl+click, box).
5. **Timeline edit.** Drag with snap, trim handles, split, join, cut, copy, paste, delete, close gaps, undo, redo, menu items and shortcuts.
6. **Preview.** Player with two video elements, transport controls, scrub, frame step, proxy files.
7. **Project file.** New, Open, Save, Save As, "Save changes?" on close, recent files, a missing-media message with a relink command.
8. **Export.** Export dialog (size, frame rate, quality), progress, cancel.
9. **Release.** Updater check at start and from the Help menu, `set-version.ps1`, `publish.ps1`, `docs/RELEASING.md`, README. Create the GitHub repository. Test the installer with a normal (not silent) install and check the shortcut icons. Publish only when the user says so.

## 8. Keyboard shortcuts

| Key | Action |
| --- | --- |
| Space | Play or pause |
| Left / Right | One frame back / forward |
| Home / End | Go to start / end |
| S | Split at playhead |
| Ctrl+J | Join clips |
| Ctrl+X / C / V | Cut / copy / paste |
| Delete | Delete selected clips |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+A | Select all |
| N | Snapping on or off |
| Ctrl+= / Ctrl+- / Ctrl+0 | Zoom in / out / to fit |
| Ctrl+N / O / S / Shift+S | New / open / save / save as |
| Ctrl+I | Import media |
| Ctrl+E | Export video |

## 9. Later

- Separate audio track (music), with clip volume and fade.
- Fast export without encode when all clips have the same format.
- More video tracks, transitions, titles.
