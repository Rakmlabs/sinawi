//! Browser windows outside the main window: the user moves an in-app browser window out into its own
//! OS window (another monitor, another Space). The window shows the app's own page with the window's
//! id in the address (src/app/BrowserWindowApp.tsx), which renders the same browser panel; its native
//! tabs live in this window (native_browser.rs places a tab in the window of the webview that opened
//! it), and its agents' commands reach it over its own socket to the server.
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::native_browser::{valid_tab_id, window_label, MAIN_LABEL};

/// Address of a browser window's page: the main window's own origin (the app server, or Vite in
/// `npm run app:dev`) with the window and workspace ids.
pub fn window_url(main: &tauri::Url, id: &str, workspace: &str) -> tauri::Url {
    let mut url = main.clone();
    url.set_path("/");
    url.set_fragment(None);
    url.query_pairs_mut().clear().append_pair("browser-window", id).append_pair("workspace", workspace);
    url
}

/// Only a page on the local app server (or the dev server) gets a browser window.
pub fn is_app_page(url: &tauri::Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1")
}

/// Opens the browser window `id` of `workspace`, or brings it to the front when it is already open.
#[tauri::command]
pub async fn browser_window_open(app: tauri::AppHandle, webview: tauri::Webview, id: String, workspace: String, title: Option<String>) -> Result<(), String> {
    if webview.label() != MAIN_LABEL { return Err("only the app window opens browser windows".into()); }
    let label = window_label(&id).ok_or("invalid window id")?;
    if !valid_tab_id(&workspace) { return Err("invalid workspace id".into()); }
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.show();
        return window.set_focus().map_err(|error| error.to_string());
    }
    let main = webview.url().map_err(|error| error.to_string())?;
    if !is_app_page(&main) { return Err("the app window is not on its server yet".into()); }
    let title = title.map(|title| title.trim().to_string()).filter(|title| !title.is_empty() && title.len() <= 80).unwrap_or_else(|| "Sinawi Browser".into());
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(window_url(&main, &id, &workspace)))
        .title(title)
        .inner_size(1180.0, 820.0)
        .min_inner_size(480.0, 360.0)
        // Same as the main window (tauri.conf.json): HTML5 drag and drop stays with the page, and the
        // page keeps running behind other windows so agents still get answers.
        .disable_drag_drop_handler()
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Closes a browser window: asked by that window itself (back into the app, its last tab closed) or by the app window.
#[tauri::command]
pub async fn browser_window_close(app: tauri::AppHandle, webview: tauri::Webview, id: String) -> Result<(), String> {
    let label = window_label(&id).ok_or("invalid window id")?;
    if webview.label() != MAIN_LABEL && webview.label() != label { return Err("not this window".into()); }
    match app.get_webview_window(&label) {
        Some(window) => window.close().map_err(|error| error.to_string()),
        None => Ok(()),
    }
}

/// Closes every browser window (the main window is gone: without it they could not be reached or re-opened).
pub fn close_all<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    for (label, window) in app.webview_windows() {
        if label != MAIN_LABEL { let _ = window.close(); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_browser_window_loads_the_app_page_with_its_ids() {
        let main: tauri::Url = "http://127.0.0.1:3001/some/path?x=1#sinawi-app-key=secret".parse().unwrap();
        assert_eq!(window_url(&main, "w3k9x0ab", "personal").as_str(), "http://127.0.0.1:3001/?browser-window=w3k9x0ab&workspace=personal");
        let dev: tauri::Url = "http://127.0.0.1:5188/".parse().unwrap();
        assert_eq!(window_url(&dev, "w1", "ws_2").as_str(), "http://127.0.0.1:5188/?browser-window=w1&workspace=ws_2");
    }

    #[test]
    fn only_the_local_app_page_gets_a_window() {
        assert!(is_app_page(&"http://127.0.0.1:3001/".parse().unwrap()));
        assert!(!is_app_page(&"tauri://localhost/".parse().unwrap()));
        assert!(!is_app_page(&"https://example.com/".parse().unwrap()));
        assert!(!is_app_page(&"http://localhost.evil.test/".parse().unwrap()));
    }
}
