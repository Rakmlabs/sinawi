// The window loads the UI from http://127.0.0.1 (a remote origin to Tauri), and since tauri 2.12
// remote origins reach app commands only through an explicit ACL. Every command registered in
// main.rs must be listed here and allowed in capabilities/*.json.
const COMMANDS: &[&str] = &[
    "open_devtools",
    "server_version_status",
    "permission_status",
    "request_permission",
    "computer_exec",
    "computer_revoke",
    "computer_stop",
    "native_browser_supported",
    "native_browser_open",
    "native_browser_layout",
    "native_browser_close",
    "native_browser_history",
    "native_browser_emulate",
    "native_browser_devtools",
    "native_browser_call",
    "native_browser_poll",
    "native_browser_screenshot",
    "native_browser_dialog",
    "native_browser_events",
    "native_browser_downloads",
    "native_browser_input",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("tauri build");
}
