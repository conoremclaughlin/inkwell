//! Inkwell desktop shell.
//!
//! A thin native wrapper around the locally running Inkwell web dashboard
//! (Next.js, default `http://localhost:3000`). The app does NOT bundle the web
//! app — it points the webview at the local dev/prod server.
//!
//! On launch the window shows a bundled "waiting for server" page while a
//! background thread polls the server's TCP port. As soon as the server is
//! reachable the webview navigates to it. The target host/port can be
//! overridden via `~/.ink/desktop.json` (see `DesktopConfig`).

use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const MAIN_WINDOW: &str = "main";
const DEFAULT_HOST: &str = "localhost";
/// Web dashboard default port (`INK_PORT_BASE - 1`, i.e. 3001 - 1).
const DEFAULT_PORT: u16 = 3000;
const POLL_INTERVAL: Duration = Duration::from_millis(1500);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(800);

/// Optional user config at `~/.ink/desktop.json`:
///
/// ```json
/// { "host": "localhost", "port": 3000 }
/// ```
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct DesktopConfig {
    host: Option<String>,
    port: Option<u16>,
}

/// Resolved server target the shell points at.
#[derive(Debug, Clone)]
struct ServerTarget {
    host: String,
    port: u16,
}

impl ServerTarget {
    fn base_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    /// Cheap reachability probe: can we open a TCP connection to the server?
    fn reachable(&self) -> bool {
        match (self.host.as_str(), self.port).to_socket_addrs() {
            Ok(addrs) => addrs
                .take(4)
                .any(|addr| TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).is_ok()),
            Err(_) => false,
        }
    }
}

/// Load `~/.ink/desktop.json`, falling back to defaults on any error.
fn load_target(app: &tauri::App) -> ServerTarget {
    let config: DesktopConfig = app
        .path()
        .home_dir()
        .ok()
        .map(|home| home.join(".ink").join("desktop.json"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| match serde_json::from_str(&raw) {
            Ok(cfg) => Some(cfg),
            Err(err) => {
                eprintln!("[inkwell-desktop] invalid ~/.ink/desktop.json ({err}); using defaults");
                None
            }
        })
        .unwrap_or_default();

    ServerTarget {
        host: config.host.unwrap_or_else(|| DEFAULT_HOST.to_string()),
        port: config.port.unwrap_or(DEFAULT_PORT),
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// Navigate the main webview to a dashboard route and bring it to front.
/// If the server isn't reachable yet, just show the window — the bundled
/// waiting page is still loaded and the startup poller will connect later.
fn open_route(app: &AppHandle, target: &ServerTarget, path: &str) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        if target.reachable() {
            if let Ok(url) = Url::parse(&format!("{}{}", target.base_url(), path)) {
                let _ = window.navigate(url);
            }
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_tray(handle: &AppHandle, target: ServerTarget) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(handle, "toggle", "Show/Hide Inkwell", true, None::<&str>)?;
    let sessions = MenuItem::with_id(handle, "open-sessions", "Open Sessions", true, None::<&str>)?;
    let automations = MenuItem::with_id(
        handle,
        "open-automations",
        "Open Automations",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(handle, "quit", "Quit Inkwell", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(handle)?;
    let sep2 = PredefinedMenuItem::separator(handle)?;

    let menu = Menu::with_items(
        handle,
        &[&toggle, &sep1, &sessions, &automations, &sep2, &quit],
    )?;

    let mut tray = TrayIconBuilder::with_id("inkwell-tray")
        .menu(&menu)
        .tooltip("Inkwell")
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "toggle" => toggle_main_window(app),
            "open-sessions" => open_route(app, &target, "/sessions"),
            "open-automations" => open_route(app, &target, "/automations"),
            "quit" => app.exit(0),
            _ => {}
        });

    if let Some(icon) = handle.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.build(handle)?;
    Ok(())
}

/// Poll the server in a background thread; navigate to it once reachable.
fn connect_when_ready(handle: AppHandle, target: ServerTarget) {
    std::thread::spawn(move || loop {
        if target.reachable() {
            if let Some(window) = handle.get_webview_window(MAIN_WINDOW) {
                if let Ok(url) = Url::parse(&target.base_url()) {
                    let _ = window.navigate(url);
                }
            }
            break;
        }
        std::thread::sleep(POLL_INTERVAL);
    });
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let target = load_target(app);
            let server_url = target.base_url();

            // Explicit default menu: gives macOS the standard app/Edit menus,
            // including Cmd+C / Cmd+V / Cmd+X bindings for the webview.
            let menu = Menu::default(app.handle())?;
            app.set_menu(menu)?;

            // The window starts on the bundled waiting page (ui/index.html) so
            // the user never sees a blank white window. The initialization
            // script tells that page which server URL we're waiting for.
            WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
                .title("Inkwell")
                .inner_size(1280.0, 850.0)
                .min_inner_size(720.0, 480.0)
                .initialization_script(&format!(
                    "window.__INK_SERVER_URL__ = {};",
                    serde_json::to_string(&server_url)?
                ))
                .build()?;

            build_tray(app.handle(), target.clone())?;
            connect_when_ready(app.handle().clone(), target);

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides it instead of quitting — the app stays
            // alive in the tray (macOS convention). Quit via tray or Cmd+Q.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Inkwell desktop app")
        .run(
            #[allow(unused_variables)]
            |app, event| {
                // Clicking the dock icon re-opens the hidden window on macOS.
                #[cfg(target_os = "macos")]
                if let tauri::RunEvent::Reopen { .. } = event {
                    show_main_window(app);
                }
            },
        );
}
