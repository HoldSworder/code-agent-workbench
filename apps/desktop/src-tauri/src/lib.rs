use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_pty::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let handle = app.handle().clone();
                app.set_activation_policy(tauri::ActivationPolicy::Regular);
                handle.on_menu_event(|_, _| {});
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app = window.app_handle();
                if app.webview_windows().len() <= 1 {
                    #[cfg(target_os = "macos")]
                    {
                        // Hide instead of quit on macOS
                        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = _event {
                if !has_visible_windows {
                    let _ = tauri::WebviewWindowBuilder::new(
                        _app,
                        "main",
                        tauri::WebviewUrl::App("index.html".into()),
                    )
                    .title("Code Agent")
                    .inner_size(1200.0, 800.0)
                    .build();
                }
            }
        });
}
