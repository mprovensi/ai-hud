#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Deserialize, Default, Clone)]
struct PeerConfig {
    name: Option<String>,
    url: Option<String>,
    #[serde(rename = "publicUrl")]
    public_url: Option<String>,
    token: Option<String>,
    primary: Option<bool>,
}

#[derive(Debug, Deserialize, Default)]
struct HudConfig {
    port: Option<u16>,
    token: Option<String>,
    #[serde(rename = "primaryHubUrl")]
    primary_hub_url: Option<String>,
    peers: Option<Vec<PeerConfig>>,
}

#[derive(Clone)]
struct TargetUrls {
    label: String,
    workspace: String,
    sessions: String,
    probe_url: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ActiveMode {
    Primary,
    Local,
}

struct RuntimeState {
    primary: Option<TargetUrls>,
    local: TargetUrls,
    local_port: u16,
    local_token: String,
    mode: Mutex<ActiveMode>,
    pinned_local: Mutex<bool>,
}

impl RuntimeState {
    fn active_target(&self) -> (ActiveMode, TargetUrls) {
        let mode = *self.mode.lock().unwrap_or_else(|e| e.into_inner());
        if mode == ActiveMode::Primary {
            if let Some(ref p) = self.primary {
                return (ActiveMode::Primary, p.clone());
            }
        }
        (ActiveMode::Local, self.local.clone())
    }

    fn set_mode(&self, mode: ActiveMode, pin_local: bool) {
        if let Ok(mut g) = self.mode.lock() {
            *g = mode;
        }
        if let Ok(mut p) = self.pinned_local.lock() {
            *p = pin_local;
        }
    }

    fn is_pinned_local(&self) -> bool {
        *self.pinned_local.lock().unwrap_or_else(|e| e.into_inner())
    }
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

fn build_target_from_url(label: String, raw_url: &str, probe_override: Option<String>) -> Option<TargetUrls> {
    let trimmed = raw_url.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        return None;
    }
    let workspace = if trimmed.contains("/workspace") {
        trimmed.clone()
    } else if let Some((base, query)) = trimmed.split_once('?') {
        format!("{}/workspace?{}", base.trim_end_matches('/'), query)
    } else {
        format!("{}/workspace", trimmed)
    };
    let sessions = trimmed.replace("/workspace", "");
    let probe_url = probe_override.unwrap_or_else(|| workspace.clone());
    Some(TargetUrls {
        label,
        workspace,
        sessions,
        probe_url,
    })
}

fn build_endpoints(cfg: &HudConfig) -> (Option<TargetUrls>, TargetUrls, u16, String) {
    let port = cfg.port.unwrap_or(8787);
    let local_token = cfg.token.clone().unwrap_or_default();
    let q = if local_token.is_empty() {
        String::new()
    } else {
        format!("?t={}", local_token)
    };
    let local = TargetUrls {
        label: "Local (Offline)".to_string(),
        workspace: format!("http://127.0.0.1:{}/workspace{}", port, q),
        sessions: format!("http://127.0.0.1:{}/{}", port, q),
        probe_url: format!("http://127.0.0.1:{}/api/workspace/index{}", port, q),
    };

    // Peer marcado como primary: true em config.json
    let primary_peer = cfg
        .peers
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .find(|p| p.primary == Some(true) && p.url.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false));

    let peer_probe = primary_peer.and_then(|p| {
        let base = p.url.as_deref()?.trim().trim_end_matches('/');
        let tok = p.token.as_deref().unwrap_or("").trim();
        if tok.is_empty() {
            Some(format!("{}/api/workspace/index", base))
        } else {
            Some(format!("{}/api/workspace/index?t={}", base, tok))
        }
    });

    // 1. AI_HUD_URL env var
    if let Ok(env_url) = std::env::var("AI_HUD_URL") {
        if let Some(t) = build_target_from_url("VPS Principal".to_string(), &env_url, peer_probe.clone()) {
            return (Some(t), local, port, local_token);
        }
    }

    // 2. config.primaryHubUrl
    if let Some(ref hub_url) = cfg.primary_hub_url {
        if let Some(t) = build_target_from_url("VPS Principal".to_string(), hub_url, peer_probe.clone()) {
            return (Some(t), local, port, local_token);
        }
    }

    // 3. Peer com primary: true (usa publicUrl HTTPS se configurado, senão url direta)
    if let Some(p) = primary_peer {
        let base = p
            .public_url
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .or(p.url.as_deref())
            .unwrap_or("")
            .trim()
            .trim_end_matches('/');
        let tok = p.token.as_deref().unwrap_or("").trim();
        let full = if tok.is_empty() {
            base.to_string()
        } else {
            format!("{}/?t={}", base, tok)
        };
        let label = p.name.clone().unwrap_or_else(|| "VPS Principal".to_string());
        if let Some(t) = build_target_from_url(label, &full, peer_probe) {
            return (Some(t), local, port, local_token);
        }
    }

    (None, local, port, local_token)
}

fn is_endpoint_reachable(probe_url: &str) -> bool {
    let Ok(url) = Url::parse(probe_url) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let scheme = url.scheme();
    let port = url.port_or_known_default().unwrap_or(if scheme == "https" { 443 } else { 80 });
    let Ok(mut addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    let Some(addr) = addrs.next() else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(1800)) else {
        return false;
    };
    if scheme != "http" {
        return true;
    }
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1200)));
    let path_q = match url.query() {
        Some(q) => format!("{}?{}", url.path(), q),
        None => url.path().to_string(),
    };
    let req = format!(
        "GET {} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\n\r\n",
        path_q, host, port
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 256];
    let Ok(n) = stream.read(&mut buf) else {
        return false;
    };
    let head = String::from_utf8_lossy(&buf[..n]);
    head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
}

fn trigger_local_peer_sync(port: u16, token: &str) {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(1200)) else {
        return;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(12)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1500)));
    let path = if token.is_empty() {
        "/api/workspace/peer-sync".to_string()
    } else {
        format!("/api/workspace/peer-sync?t={}", token)
    };
    let body = "{}";
    let req = format!(
        "POST {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        path,
        port,
        body.len(),
        body
    );
    let _ = stream.write_all(req.as_bytes());
    let mut drain = [0u8; 512];
    let _ = stream.read(&mut drain);
}

fn window_title(base: &str, label: &str) -> String {
    format!("{} — {}", base, label)
}

fn open_or_focus_window(app: &AppHandle, label: &str, title: &str, url_str: &str, w: f64, h: f64) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.set_title(title);
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

fn switch_workspace_window(app: &AppHandle, target: &TargetUrls, focus: bool) {
    let title = window_title("AI Workspace", &target.label);
    if let Some(win) = app.get_webview_window("workspace") {
        let _ = win.set_title(&title);
        if let Ok(url) = Url::parse(&target.workspace) {
            let _ = win.navigate(url);
        }
        if focus {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
    } else if focus {
        open_or_focus_window(app, "workspace", &title, &target.workspace, 1360.0, 860.0);
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

fn close_splash_and_show_workspace(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("workspace") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    if let Some(sp) = app.get_webview_window("splash") {
        let _ = sp.close();
    }
}

fn open_workspace_with_splash(app: &AppHandle, title: &str, url_str: &str) {
    if app.get_webview_window("workspace").is_some() {
        close_splash_and_show_workspace(app);
        return;
    }
    if let Ok(url) = Url::parse(url_str) {
        let app_for_load = app.clone();
        let _ = WebviewWindowBuilder::new(app, "workspace", WebviewUrl::External(url))
            .title(title)
            .inner_size(1360.0, 860.0)
            .min_inner_size(840.0, 560.0)
            .center()
            .visible(false)
            .on_page_load(move |_window, payload| {
                if matches!(payload.event(), PageLoadEvent::Finished) {
                    close_splash_and_show_workspace(&app_for_load);
                }
            })
            .build();
    }
}

fn main() {
    let root = find_repo_root();
    let cfg = read_hud_config(root.as_deref());
    let (primary, local, local_port, local_token) = build_endpoints(&cfg);

    let managed = ManagedServer {
        child: Arc::new(Mutex::new(None)),
    };
    let managed_child_boot = managed.child.clone();
    let runtime = Arc::new(RuntimeState {
        primary,
        local,
        local_port,
        local_token,
        mode: Mutex::new(ActiveMode::Local),
        pinned_local: Mutex::new(false),
    });
    let runtime_setup = runtime.clone();
    let root_boot = root.clone();

    let app = tauri::Builder::default()
        .manage(managed)
        .manage(runtime)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let rt = app.state::<Arc<RuntimeState>>();
            let (_, target) = rt.active_target();
            let title = window_title("AI Workspace", &target.label);
            open_or_focus_window(app, "workspace", &title, &target.workspace, 1360.0, 860.0);
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["splash"])
                .build(),
        )
        .on_window_event(|window, event| {
            if window.label() == "workspace" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(move |app| {
            // 1. Splash screen nativo instantâneo (sem borda, centralizado, embutido no executável)
            let _ = WebviewWindowBuilder::new(app, "splash", WebviewUrl::App("splash.html".into()))
                .title("AI Workspace")
                .inner_size(420.0, 270.0)
                .resizable(false)
                .decorations(false)
                .always_on_top(true)
                .center()
                .build();

            // 2. Boot assíncrono: inicia servidor local, testa VPS principal e carrega janela principal em segundo plano
            {
                let app_boot = app.handle().clone();
                let rt_boot = runtime_setup.clone();
                let managed_child = managed_child_boot.clone();
                let root_dir = root_boot.clone();
                thread::spawn(move || {
                    let spawned = ensure_local_server(root_dir.as_deref(), rt_boot.local_port);
                    if let Ok(mut g) = managed_child.lock() {
                        *g = spawned;
                    }
                    let mode = match rt_boot.primary {
                        Some(ref p) if is_endpoint_reachable(&p.probe_url) => ActiveMode::Primary,
                        _ => ActiveMode::Local,
                    };
                    rt_boot.set_mode(mode, false);
                    let (_, target) = rt_boot.active_target();
                    let title = window_title("AI Workspace", &target.label);
                    open_workspace_with_splash(&app_boot, &title, &target.workspace);

                    // Fallback de segurança: garante que o splash feche mesmo se o WebView demorar
                    thread::sleep(Duration::from_secs(6));
                    close_splash_and_show_workspace(&app_boot);
                });
            }

            // Monitor em segundo plano: se abriu em Fallback Local e a VPS voltar,
            // sincroniza alterações offline e reconecta na VPS Principal automaticamente.
            if let Some(ref primary_target) = runtime_setup.primary {
                let app_bg = app.handle().clone();
                let rt_bg = runtime_setup.clone();
                let primary_bg = primary_target.clone();
                thread::spawn(move || {
                    let mut fail_streak: u8 = 0;
                    loop {
                        thread::sleep(Duration::from_secs(15));
                        if rt_bg.is_pinned_local() {
                            fail_streak = 0;
                            continue;
                        }
                        let (cur_mode, _) = rt_bg.active_target();
                        let vps_up = is_endpoint_reachable(&primary_bg.probe_url);
                        if vps_up {
                            fail_streak = 0;
                            if cur_mode == ActiveMode::Local {
                                trigger_local_peer_sync(rt_bg.local_port, &rt_bg.local_token);
                                rt_bg.set_mode(ActiveMode::Primary, false);
                                switch_workspace_window(&app_bg, &primary_bg, false);
                            }
                        } else if cur_mode == ActiveMode::Primary {
                            fail_streak = fail_streak.saturating_add(1);
                            if fail_streak >= 2 {
                                rt_bg.set_mode(ActiveMode::Local, false);
                                switch_workspace_window(&app_bg, &rt_bg.local, false);
                            }
                        }
                    }
                });
            }

            let open_ws = MenuItem::with_id(app, "open_workspace", "Abrir AI Workspace", true, None::<&str>)?;
            let open_hud = MenuItem::with_id(app, "open_sessions", "Abrir Sessões HUD (2ª janela)", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let use_vps = MenuItem::with_id(
                app,
                "use_primary",
                "Usar VPS Principal",
                runtime_setup.primary.is_some(),
                None::<&str>,
            )?;
            let use_local = MenuItem::with_id(app, "use_local", "Usar Local (Fallback)", true, None::<&str>)?;
            let sync_now = MenuItem::with_id(app, "sync_now", "Sincronizar Workspace agora", true, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let open_ext = MenuItem::with_id(app, "open_browser", "Abrir no navegador", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &open_ws, &open_hud, &sep1, &use_vps, &use_local, &sync_now, &sep2, &open_ext,
                    &quit,
                ],
            )?;

            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("AI Workspace & AI HUD")
                .on_menu_event(|app, event| {
                    let rt = app.state::<Arc<RuntimeState>>();
                    match event.id.as_ref() {
                        "open_workspace" => {
                            let (_, target) = rt.active_target();
                            let title = window_title("AI Workspace", &target.label);
                            open_or_focus_window(app, "workspace", &title, &target.workspace, 1360.0, 860.0);
                        }
                        "open_sessions" => {
                            let (_, target) = rt.active_target();
                            let title = window_title("AI HUD — Sessões", &target.label);
                            open_or_focus_window(app, "sessions", &title, &target.sessions, 1080.0, 780.0);
                        }
                        "use_primary" => {
                            if let Some(ref p) = rt.primary {
                                if is_endpoint_reachable(&p.probe_url) {
                                    let port = rt.local_port;
                                    let tok = rt.local_token.clone();
                                    let app_c = app.clone();
                                    let p_c = p.clone();
                                    let rt_c = rt.inner().clone();
                                    thread::spawn(move || {
                                        trigger_local_peer_sync(port, &tok);
                                        rt_c.set_mode(ActiveMode::Primary, false);
                                        switch_workspace_window(&app_c, &p_c, true);
                                    });
                                } else {
                                    rt.set_mode(ActiveMode::Local, false);
                                    switch_workspace_window(app, &rt.local, true);
                                }
                            }
                        }
                        "use_local" => {
                            rt.set_mode(ActiveMode::Local, true);
                            switch_workspace_window(app, &rt.local, true);
                        }
                        "sync_now" => {
                            let port = rt.local_port;
                            let tok = rt.local_token.clone();
                            thread::spawn(move || {
                                trigger_local_peer_sync(port, &tok);
                            });
                        }
                        "open_browser" => {
                            let (_, target) = rt.active_target();
                            open_in_browser(&target.workspace);
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
                        let rt = app.state::<Arc<RuntimeState>>();
                        let (_, target) = rt.active_target();
                        let title = window_title("AI Workspace", &target.label);
                        open_or_focus_window(app, "workspace", &title, &target.workspace, 1360.0, 860.0);
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
