use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_pty::init())
        .setup(|app| {
            #[cfg(any(windows, target_os = "linux"))]
            {
                app.deep_link().register_all()?;
            }

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
