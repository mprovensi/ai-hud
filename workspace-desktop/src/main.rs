#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Deserialize, Default)]
struct HudConfig {
    port: Option<u16>,
    token: Option<String>,
}

#[derive(Clone)]
struct AppUrls {
    workspace: String,
    sessions: String,
}

struct ManagedServer {
    child: Arc<Mutex<Option<Child>>>,
}

impl ManagedServer {
    fn stop(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn find_repo_root() -> Option<PathBuf> {
    if let Ok(env_root) = std::env::var("AI_HUD_ROOT") {
        let p = PathBuf::from(env_root);
        if p.join("server.js").exists() {
            return Some(p);
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.clone());
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.to_path_buf());
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent().map(Path::to_path_buf);
        for _ in 0..5 {
            if let Some(dir) = cur {
                candidates.push(dir.clone());
                cur = dir.parent().map(Path::to_path_buf);
            }
        }
    }

    candidates.into_iter().find(|p| p.join("server.js").exists())
}

fn read_hud_config(root: Option<&Path>) -> HudConfig {
    let config_path = std::env::var("AI_HUD_DATA_DIR")
        .ok()
        .map(|d| PathBuf::from(d).join("config.json"))
        .or_else(|| root.map(|r| r.join("data").join("config.json")));

    let Some(path) = config_path else {
        return HudConfig::default();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<HudConfig>(&raw).ok())
        .unwrap_or_default()
}

fn port_open(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn ensure_local_server(root: Option<&Path>, port: u16) -> Option<Child> {
    if port_open(port) {
        return None;
    }
    let root_dir = root?;
    let mut cmd = Command::new("node");
    cmd.arg("server.js").current_dir(root_dir);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let child = cmd.spawn().ok()?;
    for _ in 0..24 {
        if port_open(port) {
            break;
        }
        thread::sleep(Duration::from_millis(250));
    }
    Some(child)
}

fn resolve_urls(cfg: &HudConfig) -> AppUrls {
    if let Ok(custom) = std::env::var("AI_HUD_URL") {
        let trimmed = custom.trim().trim_end_matches('/').to_string();
        if !trimmed.is_empty() {
            let workspace = if trimmed.contains("/workspace") {
                trimmed.clone()
            } else if let Some((base, query)) = trimmed.split_once('?') {
                format!("{}/workspace?{}", base.trim_end_matches('/'), query)
            } else {
                format!("{}/workspace", trimmed)
            };
            let sessions = trimmed.replace("/workspace", "");
            return AppUrls {
                workspace,
                sessions,
            };
        }
    }

    let port = cfg.port.unwrap_or(8787);
    let q = cfg
        .token
        .as_deref()
        .filter(|t| !t.is_empty())
        .map(|t| format!("?t={}", t))
        .unwrap_or_default();
    AppUrls {
        workspace: format!("http://127.0.0.1:{}/workspace{}", port, q),
        sessions: format!("http://127.0.0.1:{}/{}", port, q),
    }
}

fn open_or_focus_window(app: &AppHandle, label: &str, title: &str, url_str: &str, w: f64, h: f64) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return;
    }
    if let Ok(url) = Url::parse(url_str) {
        let _ = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
            .title(title)
            .inner_size(w, h)
            .min_inner_size(840.0, 560.0)
            .center()
            .build();
    }
}

fn open_in_browser(url: &str) {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", "", url]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg(url).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = Command::new("xdg-open").arg(url).spawn();
    }
}

fn main() {
    let root = find_repo_root();
    let cfg = read_hud_config(root.as_deref());
    let urls = resolve_urls(&cfg);
    let use_remote = std::env::var("AI_HUD_URL")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);

    let spawned_child = if use_remote {
        None
    } else {
        ensure_local_server(root.as_deref(), cfg.port.unwrap_or(8787))
    };

    let managed = ManagedServer {
        child: Arc::new(Mutex::new(spawned_child)),
    };
    let urls_for_setup = urls.clone();

    let app = tauri::Builder::default()
        .manage(managed)
        .manage(urls)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let u = app.state::<AppUrls>();
            open_or_focus_window(app, "workspace", "AI Workspace", &u.workspace, 1360.0, 860.0);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .on_window_event(|window, event| {
            // Fechar a janela principal recolhe para a bandeja (reabertura instantânea);
            // a 2ª janela (sessions) fecha normalmente.
            if window.label() == "workspace" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(move |app| {
            open_or_focus_window(
                app.handle(),
                "workspace",
                "AI Workspace",
                &urls_for_setup.workspace,
                1360.0,
                860.0,
            );

            let open_ws = MenuItem::with_id(app, "open_workspace", "Abrir AI Workspace", true, None::<&str>)?;
            let open_hud = MenuItem::with_id(app, "open_sessions", "Abrir Sessões HUD (2ª janela)", true, None::<&str>)?;
            let open_ext = MenuItem::with_id(app, "open_browser", "Abrir no navegador", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_ws, &open_hud, &open_ext, &sep, &quit])?;

            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("AI Workspace & AI HUD")
                .on_menu_event(|app, event| {
                    let u = app.state::<AppUrls>();
                    match event.id.as_ref() {
                        "open_workspace" => {
                            open_or_focus_window(app, "workspace", "AI Workspace", &u.workspace, 1360.0, 860.0);
                        }
                        "open_sessions" => {
                            open_or_focus_window(app, "sessions", "AI HUD — Sessões", &u.sessions, 1080.0, 780.0);
                        }
                        "open_browser" => {
                            open_in_browser(&u.workspace);
                        }
                        "quit" => {
                            app.state::<ManagedServer>().stop();
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        let u = app.state::<AppUrls>();
                        open_or_focus_window(app, "workspace", "AI Workspace", &u.workspace, 1360.0, 860.0);
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            let _ = tray.build(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erro ao inicializar AI Workspace desktop");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            app_handle.state::<ManagedServer>().stop();
        }
    });
}
