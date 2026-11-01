//! ScreenCaptureKit capture (macOS 14+: `SCScreenshotManager`). Replaces CGWindowListCreateImage,
//! which makes macOS 15/26 show a recurring "bypassing the system private window picker" prompt.
//!
//! The framework is loaded at runtime (the app still launches on older macOS, where `available()`
//! is false and `native::capture` falls back to the legacy Quartz path). Completion handlers run on
//! ScreenCaptureKit's own queue; callers are on a blocking worker thread, never the main thread.

use super::geometry::Rect;
use block2::RcBlock;
use objc2::{
    msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject},
};
use objc2_foundation::{NSRect, NSString};
use std::{
    ffi::{c_char, c_int, c_void},
    sync::{mpsc, OnceLock},
    time::Duration,
};

type Ref = *mut c_void;

extern "C" {
    fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
}
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGImageRetain(image: Ref) -> Ref;
}

const TIMEOUT: Duration = Duration::from_secs(8);
/// SCCaptureResolutionType.best
const RESOLUTION_BEST: isize = 1;

/// True when ScreenCaptureKit's screenshot API exists (macOS 14+).
pub fn available() -> bool {
    static OK: OnceLock<bool> = OnceLock::new();
    *OK.get_or_init(|| unsafe {
        dlopen(c"/System/Library/Frameworks/ScreenCaptureKit.framework/ScreenCaptureKit".as_ptr(), 1 /* RTLD_LAZY */);
        AnyClass::get(c"SCScreenshotManager").is_some() && AnyClass::get(c"SCShareableContent").is_some() && AnyClass::get(c"SCContentFilter").is_some()
    })
}

pub enum Target {
    /// A whole display, or `source` (display-local points) of it.
    Display { id: u32, source: Option<Rect> },
    Window(u32),
}

fn class(name: &std::ffi::CStr) -> Result<&'static AnyClass, String> {
    AnyClass::get(name).ok_or_else(|| format!("ScreenCaptureKit 클래스를 찾을 수 없습니다: {name:?}"))
}

unsafe fn describe(error: *mut AnyObject) -> String {
    if error.is_null() { return "알 수 없는 오류".into(); }
    let desc: *mut NSString = msg_send![error, localizedDescription];
    desc.as_ref().map(|s| s.to_string()).unwrap_or_else(|| "알 수 없는 오류".into())
}

unsafe fn items(array: *mut AnyObject) -> Vec<*mut AnyObject> {
    if array.is_null() { return vec![]; }
    let count: usize = msg_send![array, count];
    (0..count).map(|i| msg_send![array, objectAtIndex: i]).collect()
}

/// Raw pointers crossing from the completion queue back to the waiting thread.
struct Sent(usize);
unsafe impl Send for Sent {}

unsafe fn shareable() -> Result<Retained<AnyObject>, String> {
    let cls = class(c"SCShareableContent")?;
    let (tx, rx) = mpsc::channel::<Result<Sent, String>>();
    let block = RcBlock::new(move |content: *mut AnyObject, error: *mut AnyObject| {
        let result = match Retained::retain(content) {
            Some(c) => Ok(Sent(Retained::into_raw(c) as usize)),
            None => Err(describe(error)),
        };
        let _ = tx.send(result);
    });
    let _: () = msg_send![cls, getShareableContentExcludingDesktopWindows: true, onScreenWindowsOnly: false, completionHandler: &*block];
    match rx.recv_timeout(TIMEOUT) {
        Ok(Ok(Sent(ptr))) => Retained::from_raw(ptr as *mut AnyObject).ok_or_else(|| "화면 목록을 받지 못했습니다".into()),
        Ok(Err(e)) => Err(format!("화면 목록을 받지 못했습니다 (화면 기록 권한 확인): {e}")),
        Err(_) => Err("화면 목록 요청이 시간 초과되었습니다".into()),
    }
}

/// Captures `target` at `size` pixels. `exclude(pid, title)` picks windows to hide from display
/// captures (Sinawi's own indicator). Returns a +1 CGImageRef the caller releases.
pub fn capture(target: &Target, size: (usize, usize), exclude: &dyn Fn(i32, &str) -> bool) -> Result<Ref, String> {
    unsafe {
        let content = shareable()?;
        let windows = items(msg_send![&*content, windows]);
        let filter_cls = class(c"SCContentFilter")?;
        let alloc: Allocated<AnyObject> = msg_send![filter_cls, alloc];
        let config: Retained<AnyObject> = msg_send![class(c"SCStreamConfiguration")?, new];
        let filter: Retained<AnyObject> = match target {
            Target::Display { id, source } => {
                let display = items(msg_send![&*content, displays]).into_iter()
                    .find(|d| { let did: u32 = msg_send![*d, displayID]; did == *id })
                    .ok_or_else(|| format!("화면 {id}을 ScreenCaptureKit에서 찾지 못했습니다"))?;
                let excluded: Retained<AnyObject> = msg_send![class(c"NSMutableArray")?, array];
                for w in &windows {
                    let app: *mut AnyObject = msg_send![*w, owningApplication];
                    let pid: i32 = if app.is_null() { -1 } else { msg_send![app, processID] };
                    let title: *mut NSString = msg_send![*w, title];
                    let title = title.as_ref().map(|t| t.to_string()).unwrap_or_default();
                    if exclude(pid, &title) { let _: () = msg_send![&*excluded, addObject: *w]; }
                }
                if let Some(r) = source {
                    let _: () = msg_send![&*config, setSourceRect: NSRect::new(objc2_foundation::NSPoint::new(r.x, r.y), objc2_foundation::NSSize::new(r.w, r.h))];
                }
                msg_send![alloc, initWithDisplay: display, excludingWindows: &*excluded]
            }
            Target::Window(id) => {
                let window = windows.into_iter()
                    .find(|w| { let wid: u32 = msg_send![*w, windowID]; wid == *id })
                    .ok_or_else(|| format!("창 {id}을 ScreenCaptureKit에서 찾지 못했습니다 (최소화되었거나 닫힘)"))?;
                let _: () = msg_send![&*config, setIgnoreShadowsSingleWindow: true];
                msg_send![alloc, initWithDesktopIndependentWindow: window]
            }
        };
        let _: () = msg_send![&*config, setWidth: size.0];
        let _: () = msg_send![&*config, setHeight: size.1];
        let _: () = msg_send![&*config, setShowsCursor: false];
        let _: () = msg_send![&*config, setCaptureResolution: RESOLUTION_BEST];

        let (tx, rx) = mpsc::channel::<Result<Sent, String>>();
        let block = RcBlock::new(move |image: Ref, error: *mut AnyObject| {
            let result = if image.is_null() { Err(describe(error)) } else { Ok(Sent(CGImageRetain(image) as usize)) };
            let _ = tx.send(result);
        });
        let _: () = msg_send![class(c"SCScreenshotManager")?, captureImageWithFilter: &*filter, configuration: &*config, completionHandler: &*block];
        match rx.recv_timeout(TIMEOUT) {
            Ok(Ok(Sent(ptr))) => Ok(ptr as Ref),
            Ok(Err(e)) => Err(format!("화면을 캡처하지 못했습니다: {e}")),
            Err(_) => Err("화면 캡처가 시간 초과되었습니다".into()),
        }
    }
}
