import { clipEnd, type Clip, type MediaItem, type Project } from "./model";

/**
 * The .vsage project file: JSON text that holds the project. It holds the
 * paths of the media files, not the videos.
 */

export const FILE_VERSION = 1;
export const FILE_EXTENSION = "vsage";

export function serializeProject(project: Project): string {
  return JSON.stringify({ app: "Video Sage", ...project }, null, 2);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const isPositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

function readMedia(value: unknown): MediaItem {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.path !== "string" || !isPositive(value.durationSec) || !isPositive(value.fps)) {
    throw new Error("The project file has a media entry that is not correct.");
  }
  return {
    id: value.id,
    path: value.path,
    name: typeof value.name === "string" ? value.name : value.path.split(/[\\/]/).pop() ?? value.path,
    durationSec: value.durationSec,
    fps: value.fps,
    width: isPositive(value.width) ? value.width : 0,
    height: isPositive(value.height) ? value.height : 0,
    hasSound: value.hasSound === true,
    playable: value.playable !== false
  };
}

function readClip(value: unknown, mediaIds: Set<string>): Clip {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.mediaId !== "string"
    || !isWhole(value.start) || value.start < 0 || !isWhole(value.sourceIn) || value.sourceIn < 0 || !isWhole(value.length) || value.length < 1) {
    throw new Error("The project file has a clip that is not correct.");
  }
  if (!mediaIds.has(value.mediaId)) throw new Error("The project file has a clip with no media file.");
  return { id: value.id, mediaId: value.mediaId, start: value.start, sourceIn: value.sourceIn, length: value.length };
}

/** Reads the text of a .vsage file. Throws an Error with a message for the user when the text is not a correct project. */
export function parseProject(text: string): Project {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("This file is not a Video Sage project.");
  }
  if (!isRecord(data) || !isWhole(data.version) || !Array.isArray(data.media) || !Array.isArray(data.clips)) {
    throw new Error("This file is not a Video Sage project.");
  }
  if (data.version > FILE_VERSION) throw new Error("A newer version of Video Sage made this project. Update Video Sage to open it.");
  if (!isPositive(data.fps) || !isPositive(data.width) || !isPositive(data.height)) throw new Error("The project file has settings that are not correct.");
  const media = data.media.map(readMedia);
  const mediaIds = new Set(media.map((item) => item.id));
  const clips = data.clips.map((clip) => readClip(clip, mediaIds)).sort((a, b) => a.start - b.start);
  for (let index = 1; index < clips.length; index++) {
    if (clips[index].start < clipEnd(clips[index - 1])) throw new Error("The project file has clips that overlap.");
  }
  return { version: 1, fps: data.fps, width: data.width, height: data.height, media, clips };
}
