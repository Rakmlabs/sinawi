use std::{
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    thread,
    time::{Duration, Instant},
};

mod browser_window;
mod computer;
mod native_browser;
mod peer_check;
mod permissions;
mod server_agent;

use tauri::{path::BaseDirectory, webview::PageLoadEvent, Manager, WindowEvent};

const SERVER_ADDRESS: &str = "127.0.0.1:3001";
const SERVER_URL: &str = "http://127.0.0.1:3001";
const HEALTH_PATH: &str = "/api/health";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
/// Must match `identifier` in tauri.conf.json.
const IDENTIFIER: &str = "dev.sinawi.app";


fn health_response_is_ours(response: &str) -> bool {
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };

    headers.starts_with("HTTP/1.1 200")
        && body.contains("\"ok\":true")
        && server_agent::is_our_app(body)
        && body.contains("\"mode\":\"production\"")
}

fn production_server_is_ready() -> bool {
    health_response().is_some()
}

/// Health body from our server, or None when it is not (yet) ours/ready.
fn health_response() -> Option<String> {
    let mut addresses = SERVER_ADDRESS.to_socket_addrs().ok()?;
    let address = addresses.next()?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(300)).ok()?;

    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let request = format!(
        "GET {HEALTH_PATH} HTTP/1.1\r\nHost: {SERVER_ADDRESS}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = String::new();
    (stream.read_to_string(&mut response).is_ok() && health_response_is_ours(&response)).then_some(response)
}

fn port_is_in_use() -> bool {
    SERVER_ADDRESS
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| addresses.next())
        .and_then(|address| TcpStream::connect_timeout(&address, Duration::from_millis(300)).ok())
        .is_some()
}

/// Native error dialog (osascript). Returns true when the user picked "로그 열기".
fn show_error_dialog(message: &str, can_continue: bool) -> bool {
    let escaped = message.replace('\\', "\\\\").replace('"', "\\\"");
    let buttons = if can_continue { "{\"로그 열기\", \"계속 대기\"}" } else { "{\"로그 열기\", \"종료\"}" };
    let script = format!("display dialog \"{escaped}\" with title \"Sinawi\" with icon caution buttons {buttons} default button 2");
    let out = std::process::Command::new("/usr/bin/osascript").args(["-e", &script]).output();
    let open_log = out.map(|o| String::from_utf8_lossy(&o.stdout).contains("로그 열기")).unwrap_or(false);
    if open_log {
        if let Some(home) = std::env::var_os("HOME") {
            let _ = std::process::Command::new("/usr/bin/open").arg(std::path::Path::new(&home).join("Library/Logs/Sinawi")).status();
        }
    }
    open_log
}

const LOG_HINT: &str = "로그: ~/Library/Logs/Sinawi/server.log";

fn server_layout<R: tauri::Runtime, M: Manager<R>>(app: &M) -> Result<server_agent::Layout, Box<dyn std::error::Error>> {
    let resources = app.path().resolve("server.cjs", BaseDirectory::Resource)?
        .parent().ok_or("resource dir")?.to_path_buf();
    let app_data_dir = app.path().app_data_dir()?;
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from).ok_or("HOME is not set")?;
    let layout = server_agent::Layout {
        resources,
        server_dir: app_data_dir.join("server"),
        data_dir: app_data_dir.join(".data"),
        log_dir: home.join("Library/Logs/Sinawi"),
        plist: home.join("Library/LaunchAgents").join(format!("{}.plist", server_agent::LABEL)),
        legacy_app_dir: app_data_dir.parent().ok_or("app data parent")?.join(server_agent::LEGACY_BUNDLE_ID),
        legacy_log_dir: home.join("Library/Logs/Agent Orchestra"),
        legacy_plist: home.join("Library/LaunchAgents").join(format!("{}.plist", server_agent::LEGACY_LABEL)),
    };
    Ok(layout)
}

/// The app window's key for the app server (server/app-key.ts). It comes over the server's unix socket
/// in the data folder, where the server lets it go only after this binary, run as the peer checker,
/// confirmed the connecting process is this signed app (peer_check.rs). This hands it only to the app's
/// own windows showing the app server (the main window, and the browser windows it moved out of
/// itself, which show the same page), never to a browser tab or another page.
#[tauri::command]
fn app_key(webview: tauri::Webview) -> Result<String, String> {
    use std::os::unix::net::UnixStream;
    let url = webview.url().map_err(|error| error.to_string())?;
    let local = url.scheme() == "http" && url.host_str() == Some("127.0.0.1");
    // A dev window shows the Vite page (any port); the installed one, the app server itself.
    let on_server = local && (cfg!(dev) || url.port_or_known_default() == Some(3001));
    if !native_browser::is_app_window(webview.label()) || !on_server { return Err("only the app window".into()); }
    let socket = key_socket(&webview)?;
    let mut stream = UnixStream::connect(&socket).map_err(|e| format!("{}: {e}", socket.display()))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let mut key = String::new();
    stream.read_to_string(&mut key).map_err(|e| e.to_string())?;
    let key = key.trim().to_string();
    if key.is_empty() { Err("the server refused".into()) } else { Ok(key) }
}

/// `<data>/run/app-key.sock` (server/app-key.ts appKeySocketPath): the installed server's data folder,
/// or in `npm run app:dev` the dev server's (SINAWI_DATA_DIR, else the repository's `.data`).
fn key_socket(webview: &tauri::Webview) -> Result<std::path::PathBuf, String> {
    let data = if cfg!(dev) {
        std::env::var_os("SINAWI_DATA_DIR").map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.data"))
    } else {
        server_layout(webview.app_handle()).map_err(|error| error.to_string())?.data_dir
    };
    Ok(data.join("run").join("app-key.sock"))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerVersionStatus {
    /// Version hash of the server bundled in this app (what the LaunchAgent should run).
    bundled: String,
    /// Version hash of the copy installed for the LaunchAgent (differs while a swap is deferred).
    installed: String,
}

/// Lets the UI compare the running server (`/api/health` `version`) with this app's bundled server,
/// e.g. right after an app update. None in dev, where no LaunchAgent is involved.
#[tauri::command]
fn server_version_status(app: tauri::AppHandle) -> Option<ServerVersionStatus> {
    if cfg!(dev) { return None; }
    let layout = server_layout(&app).ok()?;
    Some(ServerVersionStatus { bundled: server_agent::bundled_version(&layout), installed: server_agent::installed_version(&layout) })
}

fn start_production_runtime(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let layout = server_layout(app)?;
    if !production_server_is_ready() && port_is_in_use() {
        show_error_dialog(&format!("포트 3001을 다른 프로그램이 사용 중이라 Sinawi 서버를 시작할 수 없습니다.\n해당 프로그램을 종료한 뒤 앱을 다시 실행하세요.\n\n{LOG_HINT}"), false);
        std::process::exit(1);
    }
    // The server is owned by launchd, not by this app: quitting/replacing the app never stops it.
    server_agent::ensure(layout)?;

    let window = app.get_webview_window("main").ok_or("main window was not created")?;
    thread::spawn(move || {
        let started_at = Instant::now();
        let mut warned = false;
        loop {
            if production_server_is_ready() {
                let url = SERVER_URL.parse().expect("constant server URL must be valid");
                if let Err(error) = window.navigate(url) {
                    eprintln!("failed to navigate to Sinawi server: {error}");
                }
                // Watchdog: the server (launchd) can restart under the window, leaving it on a dead/error
                // page with no live socket, so ao-browser sees no window. Reload when no client is connected.
                let mut missing = 0;
                loop {
                    thread::sleep(Duration::from_secs(3));
                    match health_response() {
                        Some(body) if body.contains("\"windows\":0") => missing += 1,
                        _ => missing = 0,
                    }
                    if missing >= 3 {
                        missing = 0;
                        eprintln!("Sinawi window lost its server connection; reloading");
                        if let Ok(url) = SERVER_URL.parse() {
                            let _ = window.navigate(url);
                        }
                    }
                }
            }
            if !warned && started_at.elapsed() > STARTUP_TIMEOUT {
                warned = true;
                eprintln!("Sinawi server is not ready yet; still waiting (launchd keeps it alive)");
                let reason = if port_is_in_use() {
                    "포트 3001을 다른 프로그램이 사용 중이거나 서버가 정상 응답하지 않습니다."
                } else {
                    "서버가 시작되지 않았습니다 (node를 찾지 못했거나 서버가 즉시 종료됨)."
                };
                let message = format!("Sinawi 서버가 {}초 안에 준비되지 않았습니다.\n{reason}\n\n{LOG_HINT}", STARTUP_TIMEOUT.as_secs());
                // Dialog blocks only this watcher thread; if the server comes up later the window still loads.
                show_error_dialog(&message, true);
            }
            thread::sleep(Duration::from_millis(200));
        }
    });
    Ok(())
}

fn focused_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"))
}

/// Opens the native WebKit inspector for the focused window (⌥⌘I · 앱 검사기).
#[tauri::command]
fn open_devtools(app: tauri::AppHandle) {
    if let Some(window) = focused_window(&app) {
        window.open_devtools();
    }
}

fn main() {
    // The key socket's peer check (server/app-key.ts): answer and exit before anything else starts.
    if std::env::args().nth(1).as_deref() == Some(peer_check::FLAG) { std::process::exit(peer_check::run()); }
    if permissions::cli() { return; }
    // Pre-rename WebKit storage (the window's localStorage/IndexedDB) must move before any webview exists.
    if !cfg!(dev) {
        if let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) {
            let webkit = home.join("Library/WebKit");
            if let Some(note) = server_agent::move_legacy_dir(&webkit.join(server_agent::LEGACY_BUNDLE_ID), &webkit.join(IDENTIFIER), "webkit data") {
                eprintln!("{note}");
            }
        }
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_page_load(|webview, payload| {
            if native_browser::is_app_window(webview.label()) && payload.event() == PageLoadEvent::Started {
                native_browser::reset(webview);
            }
            let is_production_page = payload.url().scheme() == "http"
                && payload.url().host_str() == Some("127.0.0.1")
                && payload.url().port_or_known_default() == Some(3001);
            // Guard: the main window must never leave the app server (e.g. a back gesture walking the joint
            // session history past it to tauri://localhost). Once the server is up, put it back.
            if !cfg!(dev)
                && !is_production_page
                && webview.label() == "main"
                && payload.event() == PageLoadEvent::Finished
            {
                let webview = webview.clone();
                thread::spawn(move || {
                    if production_server_is_ready() {
                        if let Ok(url) = SERVER_URL.parse() {
                            let _ = webview.navigate(url);
                        }
                    }
                });
            }
            if !cfg!(dev)
                && is_production_page
                && payload.event() == PageLoadEvent::Finished
            {
                if let Err(error) = webview.window().show() {
                    eprintln!("failed to show Sinawi window: {error}");
                }
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                let app = window.app_handle();
                native_browser::window_closed(app, window.label());
                // Browser windows outside the main window cannot outlive it: nothing could bring it back.
                if window.label() == native_browser::MAIN_LABEL { browser_window::close_all(app); }
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_devtools,
            app_key,
            server_version_status,
            permissions::permission_status,
            permissions::request_permission,
            permissions::notify,
            computer::computer_exec,
            computer::computer_revoke,
            computer::computer_stop,
            native_browser::native_browser_supported,
            native_browser::native_browser_open,
            native_browser::native_browser_layout,
            native_browser::native_browser_close,
            native_browser::native_browser_history,
            native_browser::native_browser_emulate,
            native_browser::native_browser_devtools,
            native_browser::native_browser_call,
            native_browser::native_browser_poll,
            native_browser::native_browser_screenshot,
            native_browser::native_browser_dialog,
            native_browser::native_browser_events,
            native_browser::native_browser_downloads,
            native_browser::native_browser_input,
            browser_window::browser_window_open,
            browser_window::browser_window_close,
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            if let Some(menu) = app.menu() {
                // ⌘W must close the in-app browser tab, not the whole window.
                for item in menu.items()? {
                    if let Some(submenu) = item.as_submenu() {
                        for child in submenu.items()? {
                            if let Some(predefined) = child.as_predefined_menuitem() {
                                if predefined.text()? == "Close Window" {
                                    submenu.remove(predefined)?;
                                }
                            }
                        }
                        if submenu.text()? == "Window" {
                            submenu.append(&tauri::menu::MenuItem::with_id(
                                app,
                                "close-tab",
                                "브라우저 탭 닫기",
                                true,
                                Some("CmdOrCtrl+W"),
                            )?)?;
                        }
                    }
                }
                for item in menu.items()? {
                    if let Some(submenu) = item.as_submenu() {
                        if submenu.text()? == "View" {
                            submenu.append(&tauri::menu::MenuItem::with_id(
                                app,
                                "reload-page",
                                "새로고침",
                                true,
                                Some("CmdOrCtrl+R"),
                            )?)?;
                            break;
                        }
                    }
                }
                for item in menu.items()? {
                    if let Some(submenu) = item.as_submenu() {
                        if submenu.text()? == "Help" {
                            submenu.append(&tauri::menu::MenuItem::with_id(app, "open-onboarding", "설정 도우미 다시 열기", true, None::<&str>)?)?;
                        }
                    }
                }
                app.on_menu_event(|app, event| {
                    if event.id().as_ref() == "open-onboarding" {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.eval("window.__orchestraOpenOnboarding && window.__orchestraOpenOnboarding()");
                        }
                    }
                    // A native browser tab with keyboard focus counts as "focus in the browser panel".
                    let native_focus = || serde_json::to_string(&native_browser::focused_tab()).unwrap_or_else(|_| "null".into());
                    if event.id().as_ref() == "close-tab" {
                        if let Some(window) = focused_window(app) {
                            let _ = window.eval(format!("window.__orchestraNativeFocus = {}; window.__orchestraMenuCloseTab && window.__orchestraMenuCloseTab()", native_focus()));
                        }
                    }
                    if event.id().as_ref() == "reload-page" {
                        if let Some(window) = focused_window(app) {
                            // The page decides: reload the focused in-app browser tab, or the app.
                            if let Err(error) = window.eval(format!("window.__orchestraNativeFocus = {}; (window.__orchestraMenuReload || (() => location.reload()))()", native_focus())) {
                                eprintln!("failed to reload Sinawi: {error}");
                            }
                        }
                    }
                });
            }

            if cfg!(dev) {
                app.get_webview_window("main")
                    .ok_or("main window was not created")?
                    .show()?;
                return Ok(());
            }

            start_production_runtime(app)
        })
        .build(tauri::generate_context!())
        .expect("failed to build Sinawi");

    // Do not stop the server on exit: launchd keeps it (and running sessions) alive.
    app.run(|_app_handle, _event| {});
}


#[cfg(test)]
mod acl_tests {
    /// The UI is a remote origin to Tauri, so a command missing from build.rs or the capabilities
    /// fails at runtime with "not allowed by ACL" while dev mode (local origin) still works.
    #[test]
    fn every_registered_command_is_allowed() {
        let main = include_str!("main.rs");
        let start = main.find("generate_handler![").expect("handler list") + "generate_handler![".len();
        let list = &main[start..start + main[start..].find(']').unwrap()];
        let build = include_str!("../build.rs");
        let capabilities = [include_str!("../capabilities/default.json"), include_str!("../capabilities/dev.json")];
        for name in list.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
            let name = name.rsplit("::").next().unwrap();
            assert!(build.contains(&format!("\"{name}\"")), "{name} missing from build.rs COMMANDS");
            let permission = format!("\"allow-{}\"", name.replace('_', "-"));
            for capability in capabilities { assert!(capability.contains(&permission), "{permission} missing from a capability"); }
        }
    }
}
