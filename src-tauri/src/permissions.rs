//! macOS privacy permissions requested from the app process itself, so the app shows up in
//! System Settings › Privacy lists (macOS only lists an app after it asked).
use serde::Serialize;

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum State { Granted, Denied, Unknown }

#[derive(Serialize)]
pub struct Status { screen: State, accessibility: State, notifications: State }

#[cfg(target_os = "macos")]
mod mac {
    use super::State;
    use core_foundation::{base::TCFType, boolean::CFBoolean, dictionary::CFDictionary, string::CFString};
    use std::{ptr::NonNull, sync::mpsc, time::Duration};

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: core_foundation::dictionary::CFDictionaryRef) -> bool;
    }

    fn state(granted: bool) -> State { if granted { State::Granted } else { State::Denied } }
    pub fn screen() -> State { state(unsafe { CGPreflightScreenCaptureAccess() }) }
    /// Registers the app in the Screen Recording list (shows the system prompt the first time).
    pub fn request_screen() -> State {
        let asked = unsafe { CGRequestScreenCaptureAccess() };
        super::log(&format!("CGRequestScreenCaptureAccess -> {asked}"));
        if !asked { touch_screen_capture(); }
        screen()
    }

    #[link(name = "ScreenCaptureKit", kind = "framework")]
    extern "C" {}
    /// Newer macOS only preflights in CGRequestScreenCaptureAccess once it has asked before; actually
    /// enumerating shareable content forces tccd to record the app in the Screen Recording list.
    fn touch_screen_capture() {
        use objc2::{msg_send, runtime::{AnyClass, AnyObject}};
        use objc2_foundation::NSError;
        let Some(cls) = AnyClass::get(c"SCShareableContent") else { super::log("SCShareableContent missing"); return };
        let (tx, rx) = mpsc::channel::<String>();
        let block = block2::RcBlock::new(move |content: *mut AnyObject, err: *mut NSError| {
            let msg = if !err.is_null() { format!("SCShareableContent error: {}", unsafe { &*err }.localizedDescription()) } else { format!("SCShareableContent ok ({})", !content.is_null()) };
            let _ = tx.send(msg);
        });
        unsafe { let _: () = msg_send![cls, getShareableContentWithCompletionHandler: &*block]; }
        super::log(&rx.recv_timeout(Duration::from_secs(20)).unwrap_or_else(|_| "SCShareableContent timeout".into()));
    }
    pub fn accessibility() -> State { state(unsafe { AXIsProcessTrusted() }) }
    pub fn request_accessibility() -> State {
        let key = CFString::new("AXTrustedCheckOptionPrompt");
        let options = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), CFBoolean::true_value().as_CFType())]);
        state(unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) })
    }

    /// UNUserNotificationCenter aborts without a bundle; only use it from the installed .app.
    fn bundled() -> bool {
        std::env::current_exe().map(|p| p.to_string_lossy().contains(".app/Contents/MacOS/")).unwrap_or(false)
    }

    pub fn notifications() -> State {
        use objc2_user_notifications::{UNAuthorizationStatus, UNNotificationSettings, UNUserNotificationCenter};
        if !bundled() { return State::Unknown; }
        let (tx, rx) = mpsc::channel();
        let block = block2::RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            let status = unsafe { settings.as_ref() }.authorizationStatus();
            let _ = tx.send(if status == UNAuthorizationStatus::Authorized || status == UNAuthorizationStatus::Provisional { State::Granted }
                else if status == UNAuthorizationStatus::Denied { State::Denied } else { State::Unknown });
        });
        UNUserNotificationCenter::currentNotificationCenter().getNotificationSettingsWithCompletionHandler(&block);
        rx.recv_timeout(Duration::from_secs(5)).unwrap_or(State::Unknown)
    }
    pub fn request_notifications() -> State {
        use objc2::runtime::Bool;
        use objc2_foundation::NSError;
        use objc2_user_notifications::{UNAuthorizationOptions, UNUserNotificationCenter};
        if !bundled() { return State::Unknown; }
        let (tx, rx) = mpsc::channel();
        let block = block2::RcBlock::new(move |granted: Bool, _error: *mut NSError| { let _ = tx.send(state(granted.as_bool())); });
        UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge, &block);
        // The user may take a while to answer the prompt.
        rx.recv_timeout(Duration::from_secs(120)).unwrap_or_else(|_| notifications())
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    use super::State;
    pub fn screen() -> State { State::Unknown }
    pub fn request_screen() -> State { State::Unknown }
    pub fn accessibility() -> State { State::Unknown }
    pub fn request_accessibility() -> State { State::Unknown }
    pub fn notifications() -> State { State::Unknown }
    pub fn request_notifications() -> State { State::Unknown }
}

/// Async so the blocking waits never run on the main (UI) thread.
#[tauri::command]
pub async fn permission_status() -> Status {
    Status { screen: mac::screen(), accessibility: mac::accessibility(), notifications: mac::notifications() }
}

#[tauri::command]
pub async fn request_permission(kind: String) -> Result<State, String> {
    log(&format!("request_permission({kind}) pid={} exe={:?}", std::process::id(), std::env::current_exe().ok()));
    let result = match kind.as_str() {
        "screen" => Ok(mac::request_screen()),
        "accessibility" => Ok(mac::request_accessibility()),
        "notifications" => Ok(mac::request_notifications()),
        _ => Err(format!("unknown permission: {kind}")),
    };
    log(&format!("request_permission({kind}) -> {result:?}"));
    result
}

/// Appends to ~/Library/Logs/Sinawi/permissions.log (and stderr).
pub fn log(line: &str) {
    use std::io::Write;
    eprintln!("[permissions] {line}");
    let Some(home) = std::env::var_os("HOME") else { return };
    let dir = std::path::Path::new(&home).join("Library/Logs/Sinawi");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("permissions.log")) {
        let _ = writeln!(f, "{:?} {line}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
    }
}

/// `sinawi --request-permission <kind>`: same code path as the onboarding button, for debugging.
pub fn cli() -> bool {
    let args: Vec<String> = std::env::args().collect();
    let Some(i) = args.iter().position(|a| a == "--request-permission") else { return false };
    let kind = args.get(i + 1).cloned().unwrap_or_else(|| "screen".into());
    let _ = tauri::async_runtime::block_on(request_permission(kind));
    true
}
