mod export;
mod media;
mod project;
mod proxy;
mod updater;
mod video_stream;

use std::time::Duration;
use tauri::Manager;

/// How long the splash window may stay up before the main window is shown anyway.
const SPLASH_TIME_LIMIT: Duration = Duration::from_secs(15);

fn restore_main_window(app: &tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

/**
 * The main window starts hidden behind the splash window, and the page shows
 * it when it is ready (src/lib/splash.ts). If the page fails before that, this
 * shows it and closes the splash after a time limit.
 */
fn end_splash_after_time_limit(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(SPLASH_TIME_LIMIT);
        let hidden = app
            .get_webview_window("main")
            .is_some_and(|main| !main.is_visible().unwrap_or(true));
        if hidden {
            restore_main_window(&app);
        }
        if let Some(splash) = app.get_webview_window("splash") {
            let _ = splash.close();
        }
    });
}

/** Writes an error from the webview to the app's error output, so crashes show in the dev log. */
#[tauri::command]
fn log_frontend_error(message: String) {
    eprintln!("[videosage] frontend error: {}", message.chars().take(4000).collect::<String>());
}

/** Returns the OS cursor position in physical pixels, for the window-control hover fix. */
#[tauri::command]
fn cursor_position() -> (i32, i32) {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut point = POINT { x: 0, y: 0 };
        unsafe {
            let _ = GetCursorPos(&mut point);
        }
        (point.x, point.y)
    }
    #[cfg(not(windows))]
    {
        (0, 0)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Full screen is not restored: the app always starts in a window.
    let window_state_flags = tauri_plugin_window_state::StateFlags::SIZE
        | tauri_plugin_window_state::StateFlags::POSITION
        | tauri_plugin_window_state::StateFlags::MAXIMIZED;

    let builder = tauri::Builder::default();
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        restore_main_window(app);
    }));
    builder
        .manage(video_stream::Videos::default())
        .register_asynchronous_uri_scheme_protocol("video", |ctx, request, responder| {
            let id = request.uri().path().trim_start_matches('/');
            let source = ctx.app_handle().state::<video_stream::Videos>().get(id);
            tauri::async_runtime::spawn_blocking(move || responder.respond(video_stream::response(request, source)));
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            // The splash window is always centered, so its state is not saved.
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags)
                .with_denylist(&["splash"])
                .build(),
        )
        .setup(|app| {
            end_splash_after_time_limit(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            log_frontend_error,
            cursor_position,
            media::probe_media,
            media::media_thumbnail,
            export::export_video,
            export::cancel_export,
            export::show_in_folder,
            project::read_project,
            project::write_project,
            project::recent_projects,
            project::add_recent_project,
            project::missing_files,
            proxy::make_proxy,
            video_stream::open_video_file,
            updater::check_for_update,
            updater::download_and_run_installer,
            updater::get_app_version
        ])
        .run(tauri::generate_context!())
        .expect("error while running Video Sage");
}
