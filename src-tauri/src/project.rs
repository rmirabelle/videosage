//! Reads and writes .vsage project files, and keeps the list of recent projects.

use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

/// The most projects that the recent list keeps.
const RECENT_LIMIT: usize = 8;

/// A project file is small JSON text. A larger file is not a project.
const PROJECT_SIZE_LIMIT: u64 = 64 * 1024 * 1024;

fn recent_list_file(app: &AppHandle) -> Result<PathBuf, String> {
    let folder = app.path().app_config_dir().map_err(|error| error.to_string())?;
    Ok(folder.join("recent-projects.json"))
}

fn read_recent(file: &Path) -> Vec<String> {
    fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/** Puts a path first in the list. The path is in the list one time only (Windows paths: upper and lower case are the same). */
fn with_added(list: Vec<String>, path: &str) -> Vec<String> {
    let mut next = vec![path.to_string()];
    next.extend(list.into_iter().filter(|other| !other.eq_ignore_ascii_case(path)));
    next.truncate(RECENT_LIMIT);
    next
}

/** Writes a file fully before it takes the place of the old one, so a failure cannot leave half a file. */
fn write_whole(path: &Path, text: &str) -> std::io::Result<()> {
    let mut part = path.as_os_str().to_owned();
    part.push(".part");
    let part = PathBuf::from(part);
    fs::write(&part, text)?;
    fs::rename(&part, path).inspect_err(|_| {
        let _ = fs::remove_file(&part);
    })
}

#[tauri::command]
pub async fn read_project(path: String) -> Result<String, String> {
    let size = fs::metadata(&path).map_err(|error| format!("Could not read the file. {error}"))?.len();
    if size > PROJECT_SIZE_LIMIT {
        return Err("This file is not a Video Sage project.".into());
    }
    fs::read_to_string(&path).map_err(|error| match error.kind() {
        std::io::ErrorKind::InvalidData => "This file is not a Video Sage project.".to_string(),
        _ => format!("Could not read the file. {error}"),
    })
}

#[tauri::command]
pub async fn write_project(path: String, text: String) -> Result<(), String> {
    write_whole(Path::new(&path), &text).map_err(|error| format!("Could not write the file. {error}"))
}

/** The recent projects, newest first. A project whose file is gone is not in the list. */
#[tauri::command]
pub async fn recent_projects(app: AppHandle) -> Result<Vec<String>, String> {
    let list = read_recent(&recent_list_file(&app)?);
    Ok(list.into_iter().filter(|path| Path::new(path).is_file()).collect())
}

/** Puts a project first in the recent list, and gives the new list. */
#[tauri::command]
pub async fn add_recent_project(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let file = recent_list_file(&app)?;
    let list = with_added(read_recent(&file), &path);
    if let Some(folder) = file.parent() {
        fs::create_dir_all(folder).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(&list).map_err(|error| error.to_string())?;
    write_whole(&file, &text).map_err(|error| error.to_string())?;
    Ok(list)
}

/** Gives the paths, of those given, that are not files on this computer now. */
#[tauri::command]
pub async fn missing_files(paths: Vec<String>) -> Vec<String> {
    paths.into_iter().filter(|path| !Path::new(path).is_file()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recent_project_goes_first_and_is_in_the_list_one_time() {
        let list = vec!["C:\\a.vsage".to_string(), "C:\\b.vsage".to_string()];
        assert_eq!(with_added(list, "c:\\B.vsage"), vec!["c:\\B.vsage", "C:\\a.vsage"]);
    }

    #[test]
    fn the_recent_list_has_a_limit() {
        let list = (0..20).map(|index| format!("C:\\{index}.vsage")).collect();
        let next = with_added(list, "C:\\new.vsage");
        assert_eq!(next.len(), RECENT_LIMIT);
        assert_eq!(next[0], "C:\\new.vsage");
    }

    #[test]
    fn a_written_file_takes_the_place_of_the_old_one() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("project.vsage");
        write_whole(&path, "one").unwrap();
        write_whole(&path, "two").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "two");
        assert!(!folder.path().join("project.vsage.part").exists());
    }
}
