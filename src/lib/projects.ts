import { invoke } from "@tauri-apps/api/core";

/** Reads the text of a project file. Rejects with a message for the user. */
export const readProjectFile = (path: string) => invoke<string>("read_project", { path });

/** Writes the text of a project file. Rejects with a message for the user. */
export const writeProjectFile = (path: string, text: string) => invoke<void>("write_project", { path, text });

/** The recent projects, newest first. */
export const recentProjects = () => invoke<string[]>("recent_projects");

/** Puts a project first in the recent list, and gives the new list. */
export const addRecentProject = (path: string) => invoke<string[]>("add_recent_project", { path });

/** Gives the paths, of those given, that are not files on this computer now. */
export const missingFiles = (paths: string[]) => invoke<string[]>("missing_files", { paths });
