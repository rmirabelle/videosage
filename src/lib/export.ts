import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ExportSegment } from "../editor/export";

export type ExportQuality = "standard" | "high";

export interface ExportRequest {
  output: string;
  width: number;
  height: number;
  fps: number;
  quality: ExportQuality;
  /** The layers from the bottom up; each one is as long as the timeline. */
  layers: ExportSegment[][];
}

/** The error text of an export that the user stopped. */
export const EXPORT_CANCELLED = "cancelled";

/** Exports the timeline to a video file. Rejects with a message for the user, or with EXPORT_CANCELLED. */
export const exportVideo = (request: ExportRequest) => invoke<void>("export_video", { request });

/** Stops the export that is in progress. */
export const cancelExport = () => invoke<void>("cancel_export");

/** Calls the handler with how far the export is (0 to 1). */
export const onExportProgress = (handler: (fraction: number) => void): Promise<UnlistenFn> =>
  listen<number>("export-progress", (event) => handler(event.payload));

/** Opens File Explorer with the file selected. */
export const showInFolder = (path: string) => invoke<void>("show_in_folder", { path });
