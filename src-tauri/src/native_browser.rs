//! Native in-app browser: one WKWebView per browser tab, placed over the React browser panel.
//!
//! The views are plain WKWebViews created here (not Tauri webviews), so pages never get Tauri's IPC
//! bridge or any app command. Everything is driven from the app's main webview through the commands
//! below, and results come back as command return values (Rust → main webview), never through the page.
//!
//! The automation script runs in its own WebKit content world ("sinawi"): it shares the DOM with the
//! page but not JS globals, so a page cannot see or patch it. A small page-world bridge only reports
//! console/network activity and applies device emulation.
use serde::{Deserialize, Serialize};

/// Main webview label: the only caller allowed to drive native browser tabs.
pub const MAIN_LABEL: &str = "main";

/// Content world of the automation script.
pub const SCRIPT_WORLD: &str = "sinawi";

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A page dialog (alert/confirm/prompt): waiting for an answer, or the last one answered.
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DialogInfo {
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_text: Option<String>,
    /// Who asks: scheme://host[:port] of the frame that opened it.
    pub origin: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// "user", "agent" (answered or armed by ao-browser) or "closed" (tab went away).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArmedDialog {
    pub accept: bool,
    pub text: String,
}

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabState {
    pub exists: bool,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    /// JSON array of queued page events (location, picking, attachments, shortcuts…), when asked for.
    pub events: Option<String>,
    /// Dialog the page is blocked on (its JS does not run until it is answered).
    pub dialog: Option<DialogInfo>,
    pub last_dialog: Option<DialogInfo>,
    pub armed: Option<ArmedDialog>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInfo {
    pub id: String,
    pub tab: Option<String>,
    pub url: String,
    pub filename: Option<String>,
    pub path: Option<String>,
    /// "starting", "downloading", "done", "failed" or "canceled".
    pub state: String,
    pub received: i64,
    pub total: i64,
    pub error: Option<String>,
    pub started_at: u64,
    /// Executable or installer type: shown as "needs review" and never opened automatically.
    pub needs_review: bool,
}

/// Tab ids come from the React panel (random base36) or Rust (popups: "pop1"…); anything else is rejected.
pub fn valid_tab_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Only web pages: no file://, javascript:, data: or custom schemes.
pub fn allowed_url(raw: &str) -> bool {
    if raw == "about:blank" {
        return true;
    }
    match tauri::Url::parse(raw) {
        Ok(url) => (url.scheme() == "http" || url.scheme() == "https") && url.host_str().is_some_and(|host| !host.is_empty()),
        Err(_) => false,
    }
}

/// Frame for a view placed next to the main webview (same superview), from a CSS rect in main-webview
/// coordinates (top-left origin). `host` is the main webview frame in the superview.
pub fn sibling_frame(host: Rect, flipped: bool, css: Rect) -> Rect {
    let y = if flipped { host.y + css.y } else { host.y + host.height - css.y - css.height };
    Rect { x: host.x + css.x, y, width: css.width.max(0.0), height: css.height.max(0.0) }
}

/// Snapshot area clipped to the visible view. None when nothing is left (off-screen element).
pub fn clip_rect(rect: Rect, width: f64, height: f64) -> Option<Rect> {
    let left = rect.x.max(0.0);
    let top = rect.y.max(0.0);
    let right = (rect.x + rect.width).min(width);
    let bottom = (rect.y + rect.height).min(height);
    (right - left >= 1.0 && bottom - top >= 1.0).then_some(Rect { x: left, y: top, width: right - left, height: bottom - top })
}

pub fn clamp_zoom(zoom: f64) -> f64 {
    if !zoom.is_finite() || zoom <= 0.0 { 1.0 } else { zoom.clamp(0.1, 5.0) }
}

/// Longest full-page capture, in CSS px. Taller pages are cut (and reported as truncated).
pub const FULL_PAGE_MAX_HEIGHT: f64 = 16_000.0;

/// Area of a full-page capture (CSS px, from the page top) and whether it had to be cut.
pub fn full_page_rect(width: f64, height: f64, max_height: f64) -> Option<(Rect, bool)> {
    if !(width.is_finite() && height.is_finite()) || width < 1.0 || height < 1.0 { return None; }
    let cut = height > max_height;
    Some((Rect { x: 0.0, y: 0.0, width: width.round(), height: height.min(max_height).round() }, cut))
}

/// A response the view cannot show, or one the server marks as an attachment, becomes a download.
pub fn should_download(can_show_mime: bool, content_disposition: Option<&str>) -> bool {
    !can_show_mime || content_disposition.is_some_and(|value| value.trim_start().to_ascii_lowercase().starts_with("attachment"))
}

/// `com.apple.quarantine` value Gatekeeper understands: `flags;hex unix time;app name;uuid`.
pub fn quarantine_value(unix_secs: u64, uuid: &str) -> String {
    format!("0081;{:x};Sinawi;{}", unix_secs, uuid)
}

/// Executable or installer file types that need the user's attention before opening.
pub fn is_risky_download(filename: &str) -> bool {
    let lower = filename.to_ascii_lowercase();
    [".app", ".pkg", ".dmg", ".command", ".sh", ".mpkg", ".terminal", ".workflow"].iter().any(|ext| lower.ends_with(ext))
}

/// A file name that stays inside the download folder: no path parts, no hidden/empty names.
pub fn sanitize_filename(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last.chars().map(|c| if c.is_control() || c == ':' { '_' } else { c }).collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim();
    let mut out: String = trimmed.chars().take(180).collect();
    if out.is_empty() { out = "download".into(); }
    out
}

/// "report.pdf", then "report (1).pdf", "report (2).pdf"… — the first name `taken` does not know.
pub fn unique_filename(suggested: &str, taken: impl Fn(&str) -> bool) -> String {
    let name = sanitize_filename(suggested);
    if !taken(&name) { return name; }
    let (stem, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
        _ => (name.as_str(), ""),
    };
    for n in 1..10_000 {
        let candidate = format!("{stem} ({n}){ext}");
        if !taken(&candidate) { return candidate; }
    }
    format!("{stem} ({}){ext}", std::process::id())
}

/// Trusted key presses: macOS virtual key code and the characters AppKit sends for that key.
pub fn key_code(name: &str) -> Option<(u16, &'static str)> {
    Some(match name.to_ascii_lowercase().as_str() {
        "enter" | "return" => (36, "\r"),
        "tab" => (48, "\t"),
        "escape" | "esc" => (53, "\u{1b}"),
        "backspace" => (51, "\u{7f}"),
        "delete" => (117, "\u{f728}"),
        "arrowleft" => (123, "\u{f702}"),
        "arrowright" => (124, "\u{f703}"),
        "arrowdown" => (125, "\u{f701}"),
        "arrowup" => (126, "\u{f700}"),
        "home" => (115, "\u{f729}"),
        "end" => (119, "\u{f72b}"),
        "pageup" => (116, "\u{f72c}"),
        "pagedown" => (121, "\u{f72d}"),
        "space" | " " => (49, " "),
        _ => return None,
    })
}

/// JS body run with callAsyncJavaScript: returns the page's queued events as a JSON string.
pub const DRAIN_SCRIPT: &str = "return window.__aoNative ? JSON.stringify(window.__aoNative.drain()) : null;";

/// Error for calls into a page that is blocked on a dialog (its JS would never answer).
pub const DIALOG_BLOCKED: &str = "페이지에 대화상자가 열려 있어 실행할 수 없습니다. ao-browser dialog accept 또는 dismiss 로 먼저 답하세요.";

fn check_caller(webview: &tauri::Webview, tab: &str) -> Result<(), String> {
    if webview.label() != MAIN_LABEL {
        return Err("native browser commands are only available to the app window".into());
    }
    if !valid_tab_id(tab) {
        return Err("invalid tab id".into());
    }
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{clamp_zoom, clip_rect, key_code, is_risky_download, now_ms, quarantine_value, should_download, sibling_frame, unique_filename, ArmedDialog, DialogInfo, DownloadInfo, Rect, TabState, DIALOG_BLOCKED, DRAIN_SCRIPT, SCRIPT_WORLD};
    use base64::Engine;
    use block2::{DynBlock, RcBlock};
    use objc2::{define_class, msg_send, rc::Retained, runtime::{AnyObject, Bool, ProtocolObject}, sel, Message, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSEvent, NSEventModifierFlags, NSEventType, NSImage, NSOpenPanel, NSView, NSWindowOrderingMode};
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSError, NSHTTPURLResponse, NSNotFound, NSNumber, NSObject, NSObjectProtocol, NSPoint, NSProcessInfo, NSProgressReporting, NSRange, NSRect, NSSize, NSString, NSURLRequest, NSURLResponse, NSURL};
    use objc2_web_kit::{
        WKContentWorld, WKDownload, WKDownloadDelegate, WKFrameInfo, WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKNavigationResponse, WKNavigationResponsePolicy,
        WKOpenPanelParameters, WKSnapshotConfiguration, WKUIDelegate, WKUserScript, WKUserScriptInjectionTime, WKWebView, WKWebViewConfiguration, WKWebsiteDataStore, WKWindowFeatures,
    };
    use serde_json::{json, Value};
    use std::{cell::{Cell, RefCell}, collections::HashMap, time::Duration};
    use tauri::Webview;
    use tokio::sync::oneshot;

    enum Answer {
        Alert(RcBlock<dyn Fn()>),
        Confirm(RcBlock<dyn Fn(Bool)>),
        Prompt(RcBlock<dyn Fn(*mut NSString)>),
    }
    struct PendingDialog { info: DialogInfo, answer: Answer }

    struct Download { info: DownloadInfo, download: Retained<WKDownload> }

    thread_local! {
        /// Main-thread only: AppKit objects never leave the main thread.
        static TABS: RefCell<HashMap<String, Retained<WKWebView>>> = RefCell::new(HashMap::new());
        /// Tabs laid out behind the app's own webview: not on screen, but not hidden either, so
        /// WebKit keeps painting them and snapshots and real input work (an agent's tab the user
        /// is not looking at, or a workspace the user is not in).
        static BEHIND: RefCell<std::collections::HashSet<String>> = RefCell::new(std::collections::HashSet::new());
        static DELEGATE: RefCell<Option<Retained<Delegate>>> = const { RefCell::new(None) };
        static DIALOGS: RefCell<HashMap<String, PendingDialog>> = RefCell::new(HashMap::new());
        static ARMED: RefCell<HashMap<String, ArmedDialog>> = RefCell::new(HashMap::new());
        static LAST_DIALOG: RefCell<HashMap<String, DialogInfo>> = RefCell::new(HashMap::new());
        /// Host events for the panel (popup opened, popup closed, download started…), drained by tab.
        static EVENTS: RefCell<Vec<Value>> = const { RefCell::new(Vec::new()) };
        static DOWNLOADS: RefCell<Vec<Download>> = const { RefCell::new(Vec::new()) };
        static SEQ: Cell<u64> = const { Cell::new(0) };
    }

    fn next_seq() -> u64 { SEQ.with(|seq| { let next = seq.get() + 1; seq.set(next); next }) }

    fn push_event(event: Value) {
        EVENTS.with(|events| {
            let mut events = events.borrow_mut();
            events.push(event);
            if events.len() > 200 { events.remove(0); }
        });
    }

    fn ns_rect(rect: Rect) -> NSRect { NSRect::new(NSPoint::new(rect.x, rect.y), NSSize::new(rect.width, rect.height)) }
    fn rect_of(rect: NSRect) -> Rect { Rect { x: rect.origin.x, y: rect.origin.y, width: rect.size.width, height: rect.size.height } }

    fn tab_view(tab: &str) -> Option<Retained<WKWebView>> { TABS.with(|tabs| tabs.borrow().get(tab).cloned()) }

    /// Which tab a WebKit callback is about.
    fn tab_of(view: &WKWebView) -> Option<String> {
        TABS.with(|tabs| tabs.borrow().iter().find(|(_, item)| std::ptr::eq(&***item, view)).map(|(id, _)| id.clone()))
    }

    fn url_text(url: Option<Retained<NSURL>>) -> String {
        url.and_then(|url| url.absoluteString()).map(|text| text.to_string()).unwrap_or_default()
    }

    fn frame_origin(frame: &WKFrameInfo) -> String {
        unsafe {
            let origin = frame.securityOrigin();
            let (scheme, host, port) = (origin.protocol().to_string(), origin.host().to_string(), origin.port());
            if host.is_empty() { return url_text(frame.request().URL()); }
            if port > 0 { format!("{scheme}://{host}:{port}") } else { format!("{scheme}://{host}") }
        }
    }

    /// Runs `f` on the main thread with the app's main WKWebView, then awaits the reply it sends
    /// (possibly later, from a WebKit completion handler).
    async fn on_main<T: Send + 'static>(
        main: &Webview,
        timeout: Duration,
        f: impl FnOnce(MainThreadMarker, &WKWebView, Reply<T>) + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = oneshot::channel::<Result<T, String>>();
        main.with_webview(move |platform| {
            let Some(mtm) = MainThreadMarker::new() else { return };
            // SAFETY: on macOS `inner()` is the main webview's WKWebView, alive for this call.
            let host = unsafe { &*(platform.inner() as *const WKWebView) };
            f(mtm, host, Reply(Cell::new(Some(tx))));
        }).map_err(|error| error.to_string())?;
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("native browser did not answer".into()),
            Err(_) => Err(format!("native browser timed out after {}s", timeout.as_secs())),
        }
    }

    pub struct Reply<T>(Cell<Option<oneshot::Sender<Result<T, String>>>>);
    impl<T> Reply<T> {
        pub fn send(&self, value: Result<T, String>) { if let Some(tx) = self.0.take() { let _ = tx.send(value); } }
    }

    const QUICK: Duration = Duration::from_secs(5);

    // ---- WebKit delegate: dialogs, file chooser, popups, downloads ----

    define_class!(
        // SAFETY: NSObject has no subclassing requirements and Delegate does not implement Drop.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "SinawiNativeBrowserDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl WKUIDelegate for Delegate {
            #[unsafe(method(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:))]
            fn alert(&self, view: &WKWebView, message: &NSString, frame: &WKFrameInfo, handler: &DynBlock<dyn Fn()>) {
                open_dialog(view, "alert", message, None, frame, Answer::Alert(handler.copy()));
            }

            #[unsafe(method(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:))]
            fn confirm(&self, view: &WKWebView, message: &NSString, frame: &WKFrameInfo, handler: &DynBlock<dyn Fn(Bool)>) {
                open_dialog(view, "confirm", message, None, frame, Answer::Confirm(handler.copy()));
            }

            #[unsafe(method(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:))]
            fn prompt(&self, view: &WKWebView, message: &NSString, default_text: Option<&NSString>, frame: &WKFrameInfo, handler: &DynBlock<dyn Fn(*mut NSString)>) {
                open_dialog(view, "prompt", message, default_text.map(|text| text.to_string()), frame, Answer::Prompt(handler.copy()));
            }

            #[unsafe(method(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:))]
            fn open_panel(&self, view: &WKWebView, parameters: &WKOpenPanelParameters, _frame: &WKFrameInfo, handler: &DynBlock<dyn Fn(*mut NSArray<NSURL>)>) {
                let handler = handler.copy();
                let Some(window) = view.window() else { handler.call((std::ptr::null_mut(),)); return };
                let panel = NSOpenPanel::openPanel(self.mtm());
                panel.setCanChooseFiles(true);
                unsafe {
                    panel.setCanChooseDirectories(parameters.allowsDirectories());
                    panel.setAllowsMultipleSelection(parameters.allowsMultipleSelection());
                }
                let chosen = panel.clone();
                let done = RcBlock::new(move |response: isize| {
                    // NSModalResponseOK = 1
                    if response == 1 { handler.call((Retained::as_ptr(&chosen.URLs()) as *mut NSArray<NSURL>,)); } else { handler.call((std::ptr::null_mut(),)); }
                });
                panel.beginSheetModalForWindow_completionHandler(&window, &done);
            }

            #[unsafe(method_id(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
            fn create_popup(&self, opener: &WKWebView, configuration: &WKWebViewConfiguration, action: &WKNavigationAction, _features: &WKWindowFeatures) -> Option<Retained<WKWebView>> {
                create_popup(self.mtm(), opener, configuration, action)
            }

            #[unsafe(method(webViewDidClose:))]
            fn did_close(&self, view: &WKWebView) {
                let Some(id) = tab_of(view) else { return };
                remove_tab(&id);
                push_event(json!({ "type": "closed", "tab": id }));
            }
        }

        unsafe impl WKNavigationDelegate for Delegate {
            #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
            fn navigation_action(&self, _view: &WKWebView, action: &WKNavigationAction, handler: &DynBlock<dyn Fn(WKNavigationActionPolicy)>) {
                let download = unsafe { action.shouldPerformDownload() };
                handler.call((if download { WKNavigationActionPolicy::Download } else { WKNavigationActionPolicy::Allow },));
            }

            #[unsafe(method(webView:decidePolicyForNavigationResponse:decisionHandler:))]
            fn navigation_response(&self, _view: &WKWebView, response: &WKNavigationResponse, handler: &DynBlock<dyn Fn(WKNavigationResponsePolicy)>) {
                let (can_show, disposition) = unsafe {
                    let res = response.response();
                    let disposition = res.downcast_ref::<NSHTTPURLResponse>().and_then(|http| http.valueForHTTPHeaderField(&NSString::from_str("Content-Disposition"))).map(|v| v.to_string());
                    (response.canShowMIMEType(), disposition)
                };
                // Only the top document of a frame decides; a subframe attachment downloads too.
                handler.call((if should_download(can_show, disposition.as_deref()) { WKNavigationResponsePolicy::Download } else { WKNavigationResponsePolicy::Allow },));
            }

            #[unsafe(method(webView:navigationAction:didBecomeDownload:))]
            fn action_download(&self, view: &WKWebView, _action: &WKNavigationAction, download: &WKDownload) { self.track(view, download); }

            #[unsafe(method(webView:navigationResponse:didBecomeDownload:))]
            fn response_download(&self, view: &WKWebView, _response: &WKNavigationResponse, download: &WKDownload) { self.track(view, download); }
        }

        unsafe impl WKDownloadDelegate for Delegate {
            #[unsafe(method(download:decideDestinationUsingResponse:suggestedFilename:completionHandler:))]
            fn destination(&self, download: &WKDownload, response: &NSURLResponse, suggested: &NSString, handler: &DynBlock<dyn Fn(*mut NSURL)>) {
                let Some(dir) = std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join("Downloads")) else { handler.call((std::ptr::null_mut(),)); return };
                let _ = std::fs::create_dir_all(&dir);
                let reserved: Vec<String> = DOWNLOADS.with(|list| list.borrow().iter().filter_map(|item| item.info.filename.clone()).collect());
                let name = unique_filename(&suggested.to_string(), |candidate| dir.join(candidate).exists() || reserved.iter().any(|taken| taken == candidate));
                let path = dir.join(&name);
                let total = response.expectedContentLength();
                update_download(download, |info| {
                    info.filename = Some(name.clone());
                    info.path = Some(path.to_string_lossy().into_owned());
                    info.state = "downloading".into();
                    if total > 0 { info.total = total; }
                });
                let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
                handler.call((Retained::as_ptr(&url) as *mut NSURL,));
            }

            #[unsafe(method(downloadDidFinish:))]
            fn finished(&self, download: &WKDownload) {
                let received = download.progress().completedUnitCount();
                update_download(download, |info| {
                    if let Some(path) = &info.path { quarantine_file(path); }
                    info.needs_review = info.filename.as_deref().is_some_and(is_risky_download);
                    info.state = "done".into(); if received > 0 { info.received = received; if info.total <= 0 { info.total = received; } }
                });
            }

            #[unsafe(method(download:didFailWithError:resumeData:))]
            fn failed(&self, download: &WKDownload, error: &NSError, _resume: Option<&NSData>) {
                let message = error.localizedDescription().to_string();
                let canceled = error.code() == -999;
                update_download(download, |info| { info.state = if canceled { "canceled" } else { "failed" }.into(); info.error = Some(message.clone()); });
            }
        }
    );

    impl Delegate {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(());
            unsafe { msg_send![super(this), init] }
        }

        fn track(&self, view: &WKWebView, download: &WKDownload) {
            unsafe { download.setDelegate(Some(ProtocolObject::from_ref(self))); }
            let url = unsafe { download.originalRequest().map(|request| url_text(request.URL())).unwrap_or_default() };
            let id = format!("d{}", next_seq());
            let tab = tab_of(view);
            let info = DownloadInfo { id: id.clone(), tab: tab.clone(), url: url.clone(), filename: None, path: None, state: "starting".into(), received: 0, total: 0, error: None, started_at: now_ms(), needs_review: false };
            DOWNLOADS.with(|list| {
                let mut list = list.borrow_mut();
                list.push(Download { info, download: download.retain() });
                if list.len() > 50 { list.remove(0); }
            });
            push_event(json!({ "type": "download", "tab": tab, "id": id, "url": url }));
        }
    }

    /// Child view for window.open / target=_blank, created from WebKit's configuration so window.opener
    /// and the session are shared; the panel shows it as a new tab.
    fn create_popup(mtm: MainThreadMarker, opener: &WKWebView, configuration: &WKWebViewConfiguration, action: &WKNavigationAction) -> Option<Retained<WKWebView>> {
        let opener_id = tab_of(opener)?;
        let parent = unsafe { opener.superview() }?;
        let view = unsafe { WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), NSRect::ZERO, configuration) };
        unsafe {
            prepare(&view);
            view.setCustomUserAgent(opener.customUserAgent().as_deref());
            parent.addSubview(&view);
        }
        let id = format!("pop{}", next_seq());
        TABS.with(|tabs| tabs.borrow_mut().insert(id.clone(), view.clone()));
        let url = unsafe { url_text(action.request().URL()) };
        push_event(json!({ "type": "popup", "tab": id, "opener": opener_id, "url": url }));
        Some(view)
    }

    fn delegate(mtm: MainThreadMarker) -> Retained<Delegate> {
        DELEGATE.with(|cell| cell.borrow_mut().get_or_insert_with(|| Delegate::new(mtm)).clone())
    }

    /// Marks a finished download as quarantined (Gatekeeper checks it on first open).
    fn quarantine_file(path: &str) {
        let mut bytes = [0u8; 16];
        let uuid = match std::fs::File::open("/dev/urandom").and_then(|mut f| std::io::Read::read_exact(&mut f, &mut bytes)) {
            Ok(()) => {
                let h: String = bytes.iter().map(|b| format!("{:02X}", b)).collect();
                format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
            }
            Err(_) => format!("{:032X}", now_ms()),
        };
        let secs = now_ms() / 1000;
        let _ = std::process::Command::new("/usr/bin/xattr").args(["-w", "com.apple.quarantine", &quarantine_value(secs, &uuid), path]).status();
    }

    fn update_download(download: &WKDownload, f: impl FnOnce(&mut DownloadInfo)) {
        DOWNLOADS.with(|list| {
            if let Some(item) = list.borrow_mut().iter_mut().find(|item| std::ptr::eq(&*item.download, download)) { f(&mut item.info); }
        });
    }

    fn answer_dialog(pending: PendingDialog, accept: bool, text: Option<String>, by: &str) -> DialogInfo {
        let mut info = pending.info;
        let text = if info.kind == "prompt" && accept { Some(text.unwrap_or_else(|| info.default_text.clone().unwrap_or_default())) } else { None };
        match pending.answer {
            Answer::Alert(block) => block.call(()),
            Answer::Confirm(block) => block.call((Bool::new(accept),)),
            Answer::Prompt(block) => match &text {
                Some(value) => { let value = NSString::from_str(value); block.call((Retained::as_ptr(&value) as *mut NSString,)); }
                None => block.call((std::ptr::null_mut(),)),
            },
        }
        info.accepted = Some(accept || info.kind == "alert");
        info.text = text;
        info.by = Some(by.into());
        info
    }

    fn open_dialog(view: &WKWebView, kind: &str, message: &NSString, default_text: Option<String>, frame: &WKFrameInfo, answer: Answer) {
        let info = DialogInfo { kind: kind.into(), message: message.to_string(), default_text, origin: frame_origin(frame), ..Default::default() };
        let pending = PendingDialog { info, answer };
        let Some(tab) = tab_of(view) else { answer_dialog(pending, false, None, "closed"); return };
        // An agent armed the answer before the click that opens it.
        if let Some(armed) = ARMED.with(|armed| armed.borrow_mut().remove(&tab)) {
            let done = answer_dialog(pending, armed.accept, Some(armed.text).filter(|text| !text.is_empty()), "agent");
            LAST_DIALOG.with(|last| last.borrow_mut().insert(tab, done));
            return;
        }
        // A page cannot stack dialogs (its JS is blocked), but cancel any leftover so WebKit never hangs.
        if let Some(old) = DIALOGS.with(|dialogs| dialogs.borrow_mut().remove(&tab)) { answer_dialog(old, false, None, "closed"); }
        DIALOGS.with(|dialogs| dialogs.borrow_mut().insert(tab.clone(), pending));
        push_event(json!({ "type": "dialog", "tab": tab }));
    }

    fn dialog_pending(tab: &str) -> bool { DIALOGS.with(|dialogs| dialogs.borrow().contains_key(tab)) }

    /// Configures a new view: hidden until laid out, delegates, inspectable.
    unsafe fn prepare(view: &WKWebView) {
        let mtm = view.mtm();
        view.setHidden(true);
        view.setAllowsBackForwardNavigationGestures(true);
        if view.respondsToSelector(sel!(setInspectable:)) { view.setInspectable(true); }
        let delegate = delegate(mtm);
        view.setUIDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        view.setNavigationDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    }

    unsafe fn create(mtm: MainThreadMarker, script: &str, page_script: Option<&str>, user_agent: Option<&str>) -> Retained<WKWebView> {
        let config = WKWebViewConfiguration::new(mtm);
        config.setWebsiteDataStore(&WKWebsiteDataStore::defaultDataStore(mtm));
        let world = WKContentWorld::worldWithName(&NSString::from_str(SCRIPT_WORLD), mtm);
        let user_script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly_inContentWorld(
            WKUserScript::alloc(mtm),
            &NSString::from_str(script),
            WKUserScriptInjectionTime::AtDocumentStart,
            true,
            &world,
        );
        let controller = config.userContentController();
        controller.addUserScript(&user_script);
        if let Some(bridge) = page_script.filter(|source| !source.is_empty()) {
            let bridge = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(WKUserScript::alloc(mtm), &NSString::from_str(bridge), WKUserScriptInjectionTime::AtDocumentStart, true);
            controller.addUserScript(&bridge);
        }
        let preferences = config.preferences();
        // Popups need a user gesture (click); window.open from timers stays blocked.
        preferences.setJavaScriptCanOpenWindowsAutomatically(false);
        // Same private preference wry uses for its devtools: lets `_inspector` open Web Inspector.
        let _: () = msg_send![&*preferences, setValue: &*NSNumber::new_bool(true), forKey: &*NSString::from_str("developerExtrasEnabled")];
        let view = WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), NSRect::ZERO, &config);
        prepare(&view);
        if let Some(agent) = user_agent.filter(|agent| !agent.is_empty()) { view.setCustomUserAgent(Some(&NSString::from_str(agent))); }
        view
    }

    unsafe fn load(view: &WKWebView, url: &str) -> Result<(), String> {
        let Some(ns_url) = NSURL::URLWithString(&NSString::from_str(url)) else { return Err(format!("invalid url: {url}")) };
        view.loadRequest(&NSURLRequest::requestWithURL(&ns_url));
        Ok(())
    }

    /// Drops a tab's view and settles anything WebKit is waiting on for it.
    fn remove_tab(tab: &str) {
        if let Some(pending) = DIALOGS.with(|dialogs| dialogs.borrow_mut().remove(tab)) { answer_dialog(pending, false, None, "closed"); }
        ARMED.with(|armed| armed.borrow_mut().remove(tab));
        LAST_DIALOG.with(|last| last.borrow_mut().remove(tab));
        BEHIND.with(|behind| behind.borrow_mut().remove(tab));
        if let Some(view) = TABS.with(|tabs| tabs.borrow_mut().remove(tab)) {
            unsafe { view.stopLoading(); view.removeFromSuperview(); }
        }
    }

    pub async fn open(main: &Webview, tab: String, url: String, script: String, page_script: Option<String>, user_agent: Option<String>) -> Result<(), String> {
        on_main(main, QUICK, move |mtm, host, reply| unsafe {
            let view = match tab_view(&tab) {
                Some(view) => view,
                None => {
                    let Some(parent) = host.superview() else { reply.send(Err("main webview has no superview".into())); return };
                    let view = create(mtm, &script, page_script.as_deref(), user_agent.as_deref());
                    parent.addSubview(&view);
                    TABS.with(|tabs| tabs.borrow_mut().insert(tab.clone(), view.clone()));
                    view
                }
            };
            if let Some(pending) = DIALOGS.with(|dialogs| dialogs.borrow_mut().remove(&tab)) { answer_dialog(pending, false, None, "closed"); }
            reply.send(load(&view, &url));
        }).await
    }

    pub async fn layout(main: &Webview, tab: String, rect: Option<Rect>, visible: bool, zoom: f64, behind: bool) -> Result<bool, String> {
        on_main(main, QUICK, move |_mtm, host, reply| unsafe {
            let Some(view) = tab_view(&tab) else { reply.send(Ok(false)); return };
            match rect.filter(|_| visible) {
                Some(rect) => {
                    let Some(parent) = host.superview() else { reply.send(Err("main webview has no superview".into())); return };
                    let frame = sibling_frame(rect_of(host.frame()), parent.isFlipped(), rect);
                    view.setFrame(ns_rect(frame));
                    let zoom = clamp_zoom(zoom);
                    if (view.pageZoom() - zoom).abs() > 0.001 { view.setPageZoom(zoom); }
                    let was_behind = BEHIND.with(|set| set.borrow().contains(&tab));
                    if was_behind != behind {
                        // Re-adding an existing subview moves it in the sibling order.
                        parent.addSubview_positioned_relativeTo(&view, if behind { NSWindowOrderingMode::Below } else { NSWindowOrderingMode::Above }, Some(host));
                        BEHIND.with(|set| { let mut set = set.borrow_mut(); if behind { set.insert(tab.clone()); } else { set.remove(&tab); } });
                    }
                    view.setHidden(false);
                }
                None => view.setHidden(true),
            }
            reply.send(Ok(true));
        }).await
    }

    pub async fn close(main: &Webview, tab: String) -> Result<(), String> {
        on_main(main, QUICK, move |_mtm, _host, reply| {
            remove_tab(&tab);
            reply.send(Ok(()));
        }).await
    }

    pub async fn history(main: &Webview, tab: String, op: String) -> Result<bool, String> {
        on_main(main, QUICK, move |_mtm, _host, reply| unsafe {
            let Some(view) = tab_view(&tab) else { reply.send(Err("탭의 브라우저가 없습니다".into())); return };
            let done = match op.as_str() {
                "back" => view.canGoBack() && view.goBack().is_some(),
                "forward" => view.canGoForward() && view.goForward().is_some(),
                "reload" => { view.reload(); true }
                "stop" => { view.stopLoading(); true }
                "focus" => view.window().is_some_and(|window| window.makeFirstResponder(Some(&view))),
                _ => { reply.send(Err(format!("unknown history op: {op}"))); return }
            };
            reply.send(Ok(done));
        }).await
    }

    pub async fn emulate(main: &Webview, tab: String, user_agent: Option<String>) -> Result<bool, String> {
        on_main(main, QUICK, move |_mtm, _host, reply| unsafe {
            let Some(view) = tab_view(&tab) else { reply.send(Ok(false)); return };
            let next = user_agent.filter(|agent| !agent.is_empty());
            let current = view.customUserAgent().map(|agent| agent.to_string()).filter(|agent| !agent.is_empty());
            if current == next { reply.send(Ok(false)); return }
            view.setCustomUserAgent(next.as_deref().map(NSString::from_str).as_deref());
            reply.send(Ok(true));
        }).await
    }

    pub async fn devtools(main: &Webview, tab: String) -> Result<(), String> {
        on_main(main, QUICK, move |_mtm, _host, reply| unsafe {
            let Some(view) = tab_view(&tab) else { reply.send(Err("탭의 브라우저가 없습니다".into())); return };
            // Private API, the same call wry makes for `open_devtools`.
            let inspector: *mut AnyObject = msg_send![&*view, _inspector];
            if !inspector.is_null() { let _: () = msg_send![inspector, show]; }
            reply.send(Ok(()));
        }).await
    }

    fn js_value(value: *mut AnyObject) -> Option<String> {
        if value.is_null() { return None; }
        // SAFETY: WebKit hands a valid object for the duration of the completion handler.
        let value = unsafe { &*value };
        value.downcast_ref::<NSString>().map(|text| text.to_string())
    }

    fn js_error(error: *mut NSError) -> String {
        // SAFETY: non-null NSError from WebKit.
        let error = unsafe { &*error };
        let detail = error.userInfo().objectForKey(&*NSString::from_str("WKJavaScriptExceptionMessage")).and_then(|v| v.downcast::<NSString>().ok()).map(|text| text.to_string());
        format!("WKError {}: {}", error.code(), detail.unwrap_or_else(|| error.localizedDescription().to_string()))
    }

    /// Runs `body` as an async function in the automation script's world (never the page's).
    unsafe fn call_js(mtm: MainThreadMarker, view: &WKWebView, body: &str, done: impl Fn(Result<Option<String>, String>) + 'static) {
        let block = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
            if !error.is_null() { done(Err(js_error(error))); } else { done(Ok(js_value(value))); }
        });
        view.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
            &NSString::from_str(body),
            None,
            None,
            &WKContentWorld::worldWithName(&NSString::from_str(SCRIPT_WORLD), mtm),
            Some(&block),
        );
    }

    /// Runs `body` as an async JS function in the page and returns its (string) result.
    pub async fn call(main: &Webview, tab: String, body: String, timeout_ms: u64) -> Result<Option<String>, String> {
        let timeout = Duration::from_millis(timeout_ms.clamp(500, 65_000));
        on_main(main, timeout, move |mtm, _host, reply| unsafe {
            let Some(view) = tab_view(&tab) else { reply.send(Err("탭의 브라우저가 없습니다".into())); return };
            if dialog_pending(&tab) { reply.send(Err(DIALOG_BLOCKED.into())); return }
            call_js(mtm, &view, &body, move |result| reply.send(result));
        }).await
    }

    fn dialog_state(tab: &str, state: &mut TabState) {
        state.dialog = DIALOGS.with(|dialogs| dialogs.borrow().get(tab).map(|pending| pending.info.clone()));
        state.last_dialog = LAST_DIALOG.with(|last| last.borrow().get(tab).cloned());
        state.armed = ARMED.with(|armed| armed.borrow().get(tab).cloned());
    }

    pub async fn poll(main: &Webview, tab: String, drain: bool) -> Result<TabState, String> {
        on_main(main, QUICK, move |mtm, _host, reply| unsafe {
            let Some(view) = tab_view(&tab) else { reply.send(Ok(TabState::default())); return };
            let mut state = TabState {
                exists: true,
                url: url_text(view.URL()),
                title: view.title().map(|title| title.to_string()).unwrap_or_default(),
                loading: view.isLoading(),
                can_go_back: view.canGoBack(),
                can_go_forward: view.canGoForward(),
                ..Default::default()
            };
            dialog_state(&tab, &mut state);
            // A page blocked on a dialog cannot run the drain script.
            if !drain || state.dialog.is_some() { reply.send(Ok(state)); return }
            let slot = Cell::new(Some(state));
            call_js(mtm, &view, DRAIN_SCRIPT, move |result| {
                if let Some(mut state) = slot.take() {
                    state.events = result.ok().flatten();
                    reply.send(Ok(state));
                }
            });
        }).await
    }

    /// `op`: "status", "arm" (answer the next dialog), "answer" (the open one, by the user or agent), "clear".
    pub async fn dialog(main: &Webview, tab: String, op: String, accept: bool, text: Option<String>, by: String) -> Result<TabState, String> {
        on_main(main, QUICK, move |_mtm, _host, reply| {
            if tab_view(&tab).is_none() { reply.send(Err("탭의 브라우저가 없습니다".into())); return }
            match op.as_str() {
                "answer" => {
                    let Some(pending) = DIALOGS.with(|dialogs| dialogs.borrow_mut().remove(&tab)) else { reply.send(Err("열린 대화상자가 없습니다.".into())); return };
                    let by = if by == "user" { "user" } else { "agent" };
                    let done = answer_dialog(pending, accept, text, by);
                    LAST_DIALOG.with(|last| last.borrow_mut().insert(tab.clone(), done));
                }
                "arm" => { ARMED.with(|armed| armed.borrow_mut().insert(tab.clone(), ArmedDialog { accept, text: text.unwrap_or_default() })); }
                "clear" => { ARMED.with(|armed| armed.borrow_mut().remove(&tab)); }
                "status" => {}
                _ => { reply.send(Err(format!("unknown dialog op: {op}"))); return }
            }
            let mut state = TabState { exists: true, ..Default::default() };
            dialog_state(&tab, &mut state);
            reply.send(Ok(state));
        }).await
    }

    /// Host events (popups, closes, downloads, dialogs) for the given tabs, as a JSON array.
    pub async fn events(main: &Webview, tabs: Vec<String>) -> Result<String, String> {
        on_main(main, QUICK, move |_mtm, _host, reply| {
            let mine = |event: &Value| ["tab", "opener"].iter().any(|key| event.get(*key).and_then(Value::as_str).is_some_and(|id| tabs.iter().any(|tab| tab == id)));
            let taken: Vec<Value> = EVENTS.with(|events| {
                let mut events = events.borrow_mut();
                let (taken, kept): (Vec<Value>, Vec<Value>) = events.drain(..).partition(|event| mine(event));
                *events = kept;
                taken
            });
            reply.send(serde_json::to_string(&taken).map_err(|error| error.to_string()));
        }).await
    }

    pub async fn downloads(main: &Webview, cancel: Option<String>) -> Result<Vec<DownloadInfo>, String> {
        on_main(main, QUICK, move |_mtm, _host, reply| {
            let list = DOWNLOADS.with(|list| {
                list.borrow_mut().iter_mut().map(|item| {
                    if item.info.state == "downloading" || item.info.state == "starting" {
                        let progress = item.download.progress();
                        item.info.received = progress.completedUnitCount().max(item.info.received);
                        let total = progress.totalUnitCount();
                        if total > 0 { item.info.total = total; }
                        if cancel.as_deref() == Some(item.info.id.as_str()) { unsafe { item.download.cancel(None) }; }
                    }
                    item.info.clone()
                }).collect()
            });
            reply.send(Ok(list));
        }).await
    }

    fn png_base64(image: &NSImage) -> Result<String, String> {
        let tiff = image.TIFFRepresentation().ok_or("snapshot has no bitmap")?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("snapshot bitmap could not be decoded")?;
        let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }.ok_or("PNG encoding failed")?;
        Ok(base64::engine::general_purpose::STANDARD.encode(png.to_vec()))
    }

    /// Real pixels of the tab (viewport, or a CSS-px rect of it) as a PNG data URL.
    /// `full`: the rect may reach below the visible viewport (full-page capture from the page top).
    pub async fn screenshot(main: &Webview, tab: String, rect: Option<Rect>, full: bool) -> Result<String, String> {
        on_main(main, Duration::from_secs(25), move |mtm, _host, reply| unsafe {
            let Some(view) = tab_view(&tab) else { reply.send(Err("탭의 브라우저가 없습니다".into())); return };
            if view.isHidden() || view.window().is_none() { reply.send(Err("브라우저 화면이 보이지 않아 스크린샷을 찍을 수 없습니다. 브라우저 패널을 연 뒤 다시 시도하세요.".into())); return }
            if dialog_pending(&tab) { reply.send(Err(DIALOG_BLOCKED.into())); return }
            let config = WKSnapshotConfiguration::new(mtm);
            config.setAfterScreenUpdates(true);
            // WebKit paints only the visible tiles, so a full-page capture grows the view to the
            // document height for the snapshot (like a tall viewport) and restores it afterwards.
            let mut restore: Option<NSRect> = None;
            if let Some(rect) = rect {
                // CSS px → view points: page zoom scales CSS pixels.
                let zoom = view.pageZoom();
                let bounds = rect_of(NSView::bounds(&view));
                let scaled = Rect { x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom };
                let area = if full { Some(scaled) } else { clip_rect(scaled, bounds.width, bounds.height) };
                let Some(area) = area else { reply.send(Err("요소가 화면 밖에 있습니다. scroll 로 가져온 뒤 다시 찍으세요.".into())); return };
                config.setRect(ns_rect(area));
                // Keep very tall captures within a sane bitmap size (≈ 1x instead of 2x).
                if full && area.width * area.height > 8_000_000.0 { config.setSnapshotWidth(Some(&NSNumber::new_f64(area.width / 2.0))); }
                if full && area.y + area.height > bounds.height {
                    let original = NSView::frame(&view);
                    let extra = area.y + area.height - bounds.height;
                    let mut grown = original;
                    grown.size.height += extra;
                    if !view.superview().is_some_and(|parent| parent.isFlipped()) { grown.origin.y -= extra; }
                    view.setFrame(grown);
                    restore = Some(original);
                }
            }
            let target = view.clone();
            let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                if let Some(frame) = restore { target.setFrame(frame); }
                if !error.is_null() { reply.send(Err(js_error(error))); return }
                if image.is_null() { reply.send(Err("snapshot returned no image".into())); return }
                reply.send(png_base64(&*image).map(|png| format!("data:image/png;base64,{png}")));
            });
            view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &block);
        }).await
    }

    /// Real (isTrusted) input: mouse click at a CSS-px viewport point, text insertion, or a named key.
    pub async fn input(main: &Webview, tab: String, kind: String, x: f64, y: f64, text: Option<String>) -> Result<bool, String> {
        on_main(main, QUICK, move |_mtm, _host, reply| unsafe {
            let Some(view) = tab_view(&tab) else { reply.send(Err("탭의 브라우저가 없습니다".into())); return };
            let Some(window) = view.window() else { reply.send(Err("브라우저 화면이 창에 없습니다".into())); return };
            if view.isHidden() { reply.send(Err("브라우저 화면이 보이지 않습니다".into())); return }
            if dialog_pending(&tab) { reply.send(Err(DIALOG_BLOCKED.into())); return }
            let time = NSProcessInfo::processInfo().systemUptime();
            let number = window.windowNumber();
            let zoom = view.pageZoom();
            let bounds = NSView::bounds(&view);
            let local = NSPoint::new(x * zoom, if view.isFlipped() { y * zoom } else { bounds.size.height - y * zoom });
            let point = view.convertPoint_toView(local, None);
            match kind.as_str() {
                "click" => {
                    let event = |kind: NSEventType, count: isize| NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(kind, point, NSEventModifierFlags::empty(), time, number, None, 0, count, if count > 0 { 1.0 } else { 0.0 });
                    let (Some(moved), Some(down), Some(up)) = (event(NSEventType::MouseMoved, 0), event(NSEventType::LeftMouseDown, 1), event(NSEventType::LeftMouseUp, 1)) else { reply.send(Err("NSEvent를 만들지 못했습니다".into())); return };
                    view.mouseMoved(&moved);
                    view.mouseDown(&down);
                    view.mouseUp(&up);
                }
                "text" => {
                    let Some(text) = text.filter(|text| !text.is_empty()) else { reply.send(Err("입력할 글자가 없습니다".into())); return };
                    let previous = window.firstResponder();
                    window.makeFirstResponder(Some(&view));
                    let range = NSRange::new(NSNotFound as usize, 0);
                    let _: () = msg_send![&*view, insertText: &*NSString::from_str(&text), replacementRange: range];
                    if let Some(previous) = previous { window.makeFirstResponder(Some(&previous)); }
                }
                "key" => {
                    let name = text.unwrap_or_default();
                    let Some((code, chars)) = key_code(&name) else { reply.send(Err(format!("실제 키 입력을 지원하지 않는 키입니다: {name}"))); return };
                    let chars = NSString::from_str(chars);
                    let event = |kind: NSEventType| NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(kind, point, NSEventModifierFlags::empty(), time, number, None, &chars, &chars, false, code);
                    let (Some(down), Some(up)) = (event(NSEventType::KeyDown), event(NSEventType::KeyUp)) else { reply.send(Err("NSEvent를 만들지 못했습니다".into())); return };
                    let previous = window.firstResponder();
                    window.makeFirstResponder(Some(&view));
                    view.keyDown(&down);
                    view.keyUp(&up);
                    if let Some(previous) = previous { window.makeFirstResponder(Some(&previous)); }
                }
                _ => { reply.send(Err(format!("unknown input kind: {kind}"))); return }
            }
            reply.send(Ok(true));
        }).await
    }

    /// Drops every view (main thread).
    pub fn reset() {
        let ids: Vec<String> = TABS.with(|tabs| tabs.borrow().keys().cloned().collect());
        for id in ids { remove_tab(&id); }
        EVENTS.with(|events| events.borrow_mut().clear());
    }

    /// The native tab that has keyboard focus (menu ⌘W/⌘R should act on it). Main thread only.
    pub fn focused_tab() -> Option<String> {
        MainThreadMarker::new()?;
        TABS.with(|tabs| {
            tabs.borrow().iter().find_map(|(id, view)| {
                if view.isHidden() { return None; }
                let responder = view.window()?.firstResponder()?;
                let responder: Retained<NSView> = responder.downcast::<NSView>().ok()?;
                responder.isDescendantOf(view).then(|| id.clone())
            })
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    use super::{DownloadInfo, Rect, TabState};
    use tauri::Webview;
    const UNSUPPORTED: &str = "native browser is only available on macOS";
    pub async fn open(_: &Webview, _: String, _: String, _: String, _: Option<String>, _: Option<String>) -> Result<(), String> { Err(UNSUPPORTED.into()) }
    pub async fn layout(_: &Webview, _: String, _: Option<Rect>, _: bool, _: f64, _: bool) -> Result<bool, String> { Ok(false) }
    pub async fn close(_: &Webview, _: String) -> Result<(), String> { Ok(()) }
    pub async fn history(_: &Webview, _: String, _: String) -> Result<bool, String> { Err(UNSUPPORTED.into()) }
    pub async fn emulate(_: &Webview, _: String, _: Option<String>) -> Result<bool, String> { Ok(false) }
    pub async fn devtools(_: &Webview, _: String) -> Result<(), String> { Err(UNSUPPORTED.into()) }
    pub async fn call(_: &Webview, _: String, _: String, _: u64) -> Result<Option<String>, String> { Err(UNSUPPORTED.into()) }
    pub async fn poll(_: &Webview, _: String, _: bool) -> Result<TabState, String> { Ok(TabState::default()) }
    pub async fn dialog(_: &Webview, _: String, _: String, _: bool, _: Option<String>, _: String) -> Result<TabState, String> { Err(UNSUPPORTED.into()) }
    pub async fn events(_: &Webview, _: Vec<String>) -> Result<String, String> { Ok("[]".into()) }
    pub async fn downloads(_: &Webview, _: Option<String>) -> Result<Vec<DownloadInfo>, String> { Ok(Vec::new()) }
    pub async fn screenshot(_: &Webview, _: String, _: Option<Rect>, _: bool) -> Result<String, String> { Err(UNSUPPORTED.into()) }
    pub async fn input(_: &Webview, _: String, _: String, _: f64, _: f64, _: Option<String>) -> Result<bool, String> { Err(UNSUPPORTED.into()) }
    pub fn focused_tab() -> Option<String> { None }
}

pub use mac::focused_tab;

/// The main webview started loading a page (app reload): its React tabs are gone, so drop all native views.
pub fn reset(main: &tauri::Webview) {
    #[cfg(target_os = "macos")]
    let _ = main.with_webview(|_| mac::reset());
    #[cfg(not(target_os = "macos"))]
    let _ = main;
}

#[tauri::command]
pub fn native_browser_supported() -> bool { cfg!(target_os = "macos") }

#[tauri::command]
pub async fn native_browser_open(webview: tauri::Webview, tab: String, url: String, script: String, page_script: Option<String>, user_agent: Option<String>) -> Result<(), String> {
    check_caller(&webview, &tab)?;
    if !allowed_url(&url) { return Err(format!("http/https 주소만 열 수 있습니다: {url}")); }
    mac::open(&webview, tab, url, script, page_script, user_agent).await
}

/// Positions (or hides) a tab's view; `behind` keeps it laid out under the app's webview.
/// Returns false when the tab has no native view (anymore).
#[tauri::command]
pub async fn native_browser_layout(webview: tauri::Webview, tab: String, rect: Option<Rect>, visible: bool, zoom: Option<f64>, behind: Option<bool>) -> Result<bool, String> {
    check_caller(&webview, &tab)?;
    mac::layout(&webview, tab, rect, visible, zoom.unwrap_or(1.0), behind.unwrap_or(false)).await
}

#[tauri::command]
pub async fn native_browser_close(webview: tauri::Webview, tab: String) -> Result<(), String> {
    check_caller(&webview, &tab)?;
    mac::close(&webview, tab).await
}

#[tauri::command]
pub async fn native_browser_history(webview: tauri::Webview, tab: String, op: String) -> Result<bool, String> {
    check_caller(&webview, &tab)?;
    mac::history(&webview, tab, op).await
}

#[tauri::command]
pub async fn native_browser_emulate(webview: tauri::Webview, tab: String, user_agent: Option<String>) -> Result<bool, String> {
    check_caller(&webview, &tab)?;
    mac::emulate(&webview, tab, user_agent).await
}

#[tauri::command]
pub async fn native_browser_devtools(webview: tauri::Webview, tab: String) -> Result<(), String> {
    check_caller(&webview, &tab)?;
    mac::devtools(&webview, tab).await
}

#[tauri::command]
pub async fn native_browser_call(webview: tauri::Webview, tab: String, body: String, timeout_ms: Option<u64>) -> Result<Option<String>, String> {
    check_caller(&webview, &tab)?;
    mac::call(&webview, tab, body, timeout_ms.unwrap_or(10_000)).await
}

#[tauri::command]
pub async fn native_browser_poll(webview: tauri::Webview, tab: String, drain: Option<bool>) -> Result<TabState, String> {
    check_caller(&webview, &tab)?;
    mac::poll(&webview, tab, drain.unwrap_or(false)).await
}

#[tauri::command]
pub async fn native_browser_dialog(webview: tauri::Webview, tab: String, op: String, accept: Option<bool>, text: Option<String>, by: Option<String>) -> Result<TabState, String> {
    check_caller(&webview, &tab)?;
    mac::dialog(&webview, tab, op, accept.unwrap_or(true), text, by.unwrap_or_else(|| "agent".into())).await
}

#[tauri::command]
pub async fn native_browser_events(webview: tauri::Webview, tabs: Vec<String>) -> Result<String, String> {
    if webview.label() != MAIN_LABEL { return Err("native browser commands are only available to the app window".into()); }
    mac::events(&webview, tabs.into_iter().filter(|tab| valid_tab_id(tab)).collect()).await
}

#[tauri::command]
pub async fn native_browser_downloads(webview: tauri::Webview, cancel: Option<String>) -> Result<Vec<DownloadInfo>, String> {
    if webview.label() != MAIN_LABEL { return Err("native browser commands are only available to the app window".into()); }
    mac::downloads(&webview, cancel).await
}

#[tauri::command]
pub async fn native_browser_screenshot(webview: tauri::Webview, tab: String, rect: Option<Rect>, full: Option<bool>) -> Result<String, String> {
    check_caller(&webview, &tab)?;
    let full = full.unwrap_or(false);
    // Full page: `rect` is the document size from the top; cap the height.
    let rect = if full { Some(rect.and_then(|r| full_page_rect(r.width, r.height, FULL_PAGE_MAX_HEIGHT)).ok_or("페이지 크기를 알 수 없습니다")?.0) } else { rect };
    mac::screenshot(&webview, tab, rect, full).await
}

#[tauri::command]
pub async fn native_browser_input(webview: tauri::Webview, tab: String, kind: String, x: Option<f64>, y: Option<f64>, text: Option<String>) -> Result<bool, String> {
    check_caller(&webview, &tab)?;
    let (x, y) = (x.unwrap_or(0.0), y.unwrap_or(0.0));
    if !(x.is_finite() && y.is_finite()) { return Err("invalid point".into()); }
    mac::input(&webview, tab, kind, x, y, text).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quarantine_value_has_gatekeeper_format() {
        assert_eq!(quarantine_value(0x6543_2100, "AAAA-BBBB"), "0081;65432100;Sinawi;AAAA-BBBB");
        assert!(is_risky_download("Setup.PKG"));
        assert!(is_risky_download("run.command"));
        assert!(!is_risky_download("photo.png"));
    }

    #[test]
    fn tab_ids_are_plain_tokens() {
        assert!(valid_tab_id("k3j9x0ab"));
        assert!(valid_tab_id("tab_1-2"));
        assert!(valid_tab_id("pop12"));
        assert!(!valid_tab_id(""));
        assert!(!valid_tab_id("a\"); alert(1); (\""));
        assert!(!valid_tab_id(&"a".repeat(65)));
    }

    #[test]
    fn only_web_urls_load() {
        assert!(allowed_url("https://example.com/"));
        assert!(allowed_url("http://localhost:5173/app?x=1"));
        assert!(allowed_url("about:blank"));
        assert!(!allowed_url("file:///etc/passwd"));
        assert!(!allowed_url("javascript:alert(1)"));
        assert!(!allowed_url("tauri://localhost/"));
        assert!(!allowed_url("data:text/html,hi"));
        assert!(!allowed_url("not a url"));
    }

    #[test]
    fn sibling_frame_flips_y_for_unflipped_superviews() {
        let host = Rect { x: 0.0, y: 0.0, width: 1440.0, height: 900.0 };
        let css = Rect { x: 800.0, y: 100.0, width: 600.0, height: 700.0 };
        assert_eq!(sibling_frame(host, true, css), Rect { x: 800.0, y: 100.0, width: 600.0, height: 700.0 });
        assert_eq!(sibling_frame(host, false, css), Rect { x: 800.0, y: 100.0, width: 600.0, height: 700.0 });
        let low = Rect { x: 10.0, y: 0.0, width: 100.0, height: 200.0 };
        assert_eq!(sibling_frame(host, false, low).y, 700.0);
        let offset_host = Rect { x: 5.0, y: 20.0, width: 1000.0, height: 800.0 };
        assert_eq!(sibling_frame(offset_host, false, low), Rect { x: 15.0, y: 620.0, width: 100.0, height: 200.0 });
        assert_eq!(sibling_frame(offset_host, true, low), Rect { x: 15.0, y: 20.0, width: 100.0, height: 200.0 });
    }

    #[test]
    fn clip_rect_keeps_visible_part_only() {
        let r = Rect { x: -10.0, y: 50.0, width: 100.0, height: 1000.0 };
        assert_eq!(clip_rect(r, 800.0, 600.0), Some(Rect { x: 0.0, y: 50.0, width: 90.0, height: 550.0 }));
        assert_eq!(clip_rect(Rect { x: 900.0, y: 0.0, width: 10.0, height: 10.0 }, 800.0, 600.0), None);
        assert_eq!(clip_rect(Rect { x: 0.0, y: 0.0, width: 0.5, height: 10.0 }, 800.0, 600.0), None);
    }

    #[test]
    fn zoom_is_sane() {
        assert_eq!(clamp_zoom(f64::NAN), 1.0);
        assert_eq!(clamp_zoom(0.0), 1.0);
        assert_eq!(clamp_zoom(0.5), 0.5);
        assert_eq!(clamp_zoom(100.0), 5.0);
    }

    #[test]
    fn full_page_rect_is_capped() {
        assert_eq!(full_page_rect(800.4, 3000.0, FULL_PAGE_MAX_HEIGHT), Some((Rect { x: 0.0, y: 0.0, width: 800.0, height: 3000.0 }, false)));
        assert_eq!(full_page_rect(800.0, 50_000.0, 16_000.0), Some((Rect { x: 0.0, y: 0.0, width: 800.0, height: 16_000.0 }, true)));
        assert_eq!(full_page_rect(0.0, 100.0, 16_000.0), None);
        assert_eq!(full_page_rect(f64::NAN, 100.0, 16_000.0), None);
    }

    #[test]
    fn downloads_follow_mime_and_disposition() {
        assert!(should_download(false, None));
        assert!(should_download(true, Some("attachment; filename=\"a.csv\"")));
        assert!(should_download(true, Some("  Attachment")));
        assert!(!should_download(true, Some("inline")));
        assert!(!should_download(true, None));
    }

    #[test]
    fn download_names_stay_in_the_folder_and_never_overwrite() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("..\\x\\.hidden"), "hidden");
        assert_eq!(sanitize_filename(""), "download");
        assert_eq!(sanitize_filename("a:b\u{7}.txt"), "a_b_.txt");
        let taken = ["report.pdf", "report (1).pdf"];
        assert_eq!(unique_filename("report.pdf", |name| taken.contains(&name)), "report (2).pdf");
        assert_eq!(unique_filename("new.pdf", |name| taken.contains(&name)), "new.pdf");
        assert_eq!(unique_filename("README", |name| name == "README"), "README (1)");
        assert_eq!(unique_filename(".env", |_| false), "env");
    }

    #[test]
    fn trusted_keys_map_to_mac_key_codes() {
        assert_eq!(key_code("Enter"), Some((36, "\r")));
        assert_eq!(key_code("ArrowDown"), Some((125, "\u{f701}")));
        assert_eq!(key_code("Escape"), key_code("esc"));
        assert_eq!(key_code("F13"), None);
    }

    #[test]
    fn dialog_state_serializes_for_the_panel() {
        let info = DialogInfo { kind: "confirm".into(), message: "Sure?".into(), origin: "http://localhost:8000".into(), ..Default::default() };
        let state = TabState { exists: true, dialog: Some(info), ..Default::default() };
        let json = serde_json::to_value(&state).unwrap();
        assert_eq!(json["dialog"]["kind"], "confirm");
        assert_eq!(json["dialog"]["origin"], "http://localhost:8000");
        assert!(json["dialog"].get("accepted").is_none());
        assert!(json["lastDialog"].is_null());
    }
}
