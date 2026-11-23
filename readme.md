# Video Sage

At last, there is a need for a bona-fide linear video editor.

Video Sage, like other Sage apps, was borne of the ancient need for man to craft tool to do thing.

It's focused and simple. Basic timeline. clip editing (split, join, drag, snap to clip, cut, copy, paste with a single video track only (for now). Audio track is a "nice to have, later" feature.

## What it does

- Import video files (MP4, MOV, MKV, WebM, AVI and more).
- Put clips on layers. A clip on a higher layer shows on top of the layers under it.
  Each clip keeps its own sound, and the sound of all layers plays.
- When the timeline has clips, each new import goes on a new layer at the playhead.
- Split, join, move and trim clips. Cut, copy, paste and delete them.
- Snap a clip to other clips, to the playhead and to the start.
- Play the timeline in the preview, with frame steps (hold Shift or Ctrl for larger steps).
- Loop play the selected clips, or the whole timeline.
- Undo and redo every edit.
- Save the project as a `.vsage` file. The file holds the paths of the videos, not the videos.
- Export the timeline, or only the selected clips (right-click a clip), to one MP4 file (H.264 video, AAC sound).

Press `?` in the app for the list of keys.

## Install

Download `VideoSage_<version>_x64-setup.exe` from the
[latest release](https://github.com/rmirabelle/videosage/releases/latest) and run it.
Video Sage is for Windows 10 and Windows 11. It looks for a new version each time it starts.

## Build from source

You need Node.js, Rust and the Tauri 2 requirements for Windows.

```powershell
npm install
.\tools\get-ffmpeg.ps1
npm run tauri dev
```

`tools\get-ffmpeg.ps1` downloads `ffmpeg.exe` and `ffprobe.exe`, which are too large for the repository.

Run the tests with `npm test`, and with `cargo test` in `src-tauri`.
See `docs/RELEASING.md` for how to make a release.

## FFmpeg

Video Sage runs FFmpeg and ffprobe as separate programs to read, show and export videos.
The installer includes a GPL build of FFmpeg, with its license in `ffmpeg\LICENSE.txt`
and the place of its source code in `ffmpeg\SOURCE.txt`.
