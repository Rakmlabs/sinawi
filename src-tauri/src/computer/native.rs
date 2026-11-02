//! macOS native layer: capture (ScreenCaptureKit, Quartz fallback), window list, synthetic input and running apps.
//! Runs inside Sinawi.app so TCC attributes Screen Recording / Accessibility to the app.
#![allow(non_upper_case_globals, clippy::upper_case_acronyms)]

use super::geometry::{output_size, Rect};
use super::keys::{self, Combo, TypeUnit};
use core_foundation::{
    array::CFArray,
    base::{CFRelease, CFType, CFTypeRef, TCFType},
    dictionary::CFDictionary,
    number::CFNumber,
    string::{CFString, CFStringRef},
    url::CFURL,
};
use serde_json::{json, Value};
use std::{ffi::c_void, thread, time::Duration};

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct CGPoint { pub x: f64, pub y: f64 }
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct CGSize { pub width: f64, pub height: f64 }
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct CGRect { pub origin: CGPoint, pub size: CGSize }

impl From<Rect> for CGRect { fn from(r: Rect) -> Self { CGRect { origin: CGPoint { x: r.x, y: r.y }, size: CGSize { width: r.w, height: r.h } } } }
impl From<CGRect> for Rect { fn from(r: CGRect) -> Self { Rect { x: r.origin.x, y: r.origin.y, w: r.size.width, h: r.size.height } } }

type Ref = *mut c_void;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGMainDisplayID() -> u32;
    fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
    fn CGDisplayBounds(display: u32) -> CGRect;
    fn CGDisplayCopyDisplayMode(display: u32) -> Ref;
    fn CGDisplayModeGetPixelWidth(mode: Ref) -> usize;
    fn CGDisplayModeGetWidth(mode: Ref) -> usize;
    fn CGDisplayModeRelease(mode: Ref);
    fn CGWindowListCreateImage(rect: CGRect, list: u32, window: u32, image: u32) -> Ref;
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFTypeRef;
    fn CGImageGetWidth(image: Ref) -> usize;
    fn CGImageGetHeight(image: Ref) -> usize;
    fn CGImageRelease(image: Ref);
    fn CGColorSpaceCreateDeviceRGB() -> Ref;
    fn CGColorSpaceRelease(space: Ref);
    fn CGBitmapContextCreate(data: *mut c_void, w: usize, h: usize, bits: usize, row: usize, space: Ref, info: u32) -> Ref;
    fn CGBitmapContextCreateImage(ctx: Ref) -> Ref;
    fn CGContextDrawImage(ctx: Ref, rect: CGRect, image: Ref);
    fn CGContextSetInterpolationQuality(ctx: Ref, quality: i32);
    fn CGContextRelease(ctx: Ref);
    fn CGEventCreate(source: Ref) -> Ref;
    fn CGEventGetLocation(event: Ref) -> CGPoint;
    fn CGEventCreateMouseEvent(source: Ref, kind: u32, point: CGPoint, button: u32) -> Ref;
    fn CGEventCreateKeyboardEvent(source: Ref, key: u16, down: bool) -> Ref;
    fn CGEventKeyboardSetUnicodeString(event: Ref, len: usize, chars: *const u16);
    fn CGEventSetFlags(event: Ref, flags: u64);
    fn CGEventSetIntegerValueField(event: Ref, field: u32, value: i64);
    fn CGEventPost(tap: u32, event: Ref);
    fn CGEventCreateScrollWheelEvent(source: Ref, units: u32, count: u32, wheel1: i32, ...) -> Ref;
    fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
    fn CGEventSourceFlagsState(state: i32) -> u64;
    fn CGPreflightScreenCaptureAccess() -> bool;
}
#[link(name = "ImageIO", kind = "framework")]
extern "C" {
    fn CGImageDestinationCreateWithURL(url: CFTypeRef, kind: CFStringRef, count: usize, options: CFTypeRef) -> Ref;
    fn CGImageDestinationAddImage(dest: Ref, image: Ref, props: CFTypeRef);
    fn CGImageDestinationFinalize(dest: Ref) -> bool;
}
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" { fn AXIsProcessTrusted() -> bool; }

const LIST_ON_SCREEN: u32 = 1;
const LIST_INCLUDING_WINDOW: u32 = 8;
const LIST_EXCLUDE_DESKTOP: u32 = 16;
const IMAGE_IGNORE_FRAMING: u32 = 1;
const IMAGE_BEST_RESOLUTION: u32 = 8;
const HID_TAP: u32 = 0;
const HID_STATE: i32 = 1;
const MOUSE_CLICK_STATE: u32 = 1;

pub const SCREEN_PANE: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
pub const ACCESSIBILITY_PANE: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

pub fn screen_granted() -> bool { unsafe { CGPreflightScreenCaptureAccess() } }
pub fn accessibility_granted() -> bool { unsafe { AXIsProcessTrusted() } }

pub fn require_screen() -> Result<(), String> {
    if screen_granted() { return Ok(()); }
    crate::permissions::register_missing("screen");
    Err(format!("화면 기록 권한이 없습니다. 시스템 설정 › 개인정보 보호 및 보안 › 화면 및 시스템 오디오 기록에 Sinawi가 추가되어 있습니다. 켠 뒤 앱을 다시 여세요. ({SCREEN_PANE})"))
}
pub fn require_accessibility() -> Result<(), String> {
    if accessibility_granted() { return Ok(()); }
    crate::permissions::register_missing("accessibility");
    Err(format!("손쉬운 사용 권한이 없습니다. 시스템 설정 › 개인정보 보호 및 보안 › 손쉬운 사용에 Sinawi가 추가되어 있습니다. 켜세요. ({ACCESSIBILITY_PANE})"))
}

// ---------- displays ----------

#[derive(Debug, Clone, serde::Serialize)]
pub struct Display { pub index: usize, pub id: u32, pub main: bool, pub bounds: Rect, pub scale: f64 }

pub fn displays() -> Vec<Display> {
    let mut ids = [0u32; 16];
    let mut count = 0u32;
    if unsafe { CGGetActiveDisplayList(16, ids.as_mut_ptr(), &mut count) } != 0 { return vec![]; }
    let main = unsafe { CGMainDisplayID() };
    let mut list: Vec<Display> = ids[..count as usize].iter().map(|&id| {
        let bounds: Rect = unsafe { CGDisplayBounds(id) }.into();
        let scale = unsafe {
            let mode = CGDisplayCopyDisplayMode(id);
            if mode.is_null() { 1.0 } else {
                let (px, pt) = (CGDisplayModeGetPixelWidth(mode), CGDisplayModeGetWidth(mode));
                CGDisplayModeRelease(mode);
                if pt == 0 { 1.0 } else { px as f64 / pt as f64 }
            }
        };
        Display { index: 0, id, main: id == main, bounds, scale }
    }).collect();
    list.sort_by_key(|d| !d.main); // main display is always index 0
    for (i, d) in list.iter_mut().enumerate() { d.index = i; }
    list
}

// ---------- windows ----------

#[derive(Debug, Clone, serde::Serialize)]
pub struct WindowInfo { pub id: u32, pub pid: i32, pub app: String, pub title: String, pub bounds: Rect, pub layer: i64, pub on_screen: bool }

fn dict_string(d: &CFDictionary<CFString, CFType>, key: &str) -> Option<String> {
    d.find(&CFString::new(key)).and_then(|v| v.downcast::<CFString>()).map(|s| s.to_string())
}
fn dict_number(d: &CFDictionary<CFString, CFType>, key: &str) -> Option<f64> {
    d.find(&CFString::new(key)).and_then(|v| v.downcast::<CFNumber>()).and_then(|n| n.to_f64())
}

/// Front-to-back list of windows. `on_screen_only` skips minimized/hidden ones.
pub fn windows(on_screen_only: bool) -> Vec<WindowInfo> {
    let option = if on_screen_only { LIST_ON_SCREEN | LIST_EXCLUDE_DESKTOP } else { LIST_EXCLUDE_DESKTOP };
    let raw = unsafe { CGWindowListCopyWindowInfo(option, 0) };
    if raw.is_null() { return vec![]; }
    let array: CFArray<CFType> = unsafe { CFArray::wrap_under_create_rule(raw as _) };
    let mut out = Vec::new();
    for item in array.iter() {
        let Some(dict) = item.downcast::<CFDictionary>() else { continue };
        let d: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_get_rule(dict.as_concrete_TypeRef()) };
        let bounds = d.find(&CFString::new("kCGWindowBounds")).and_then(|v| v.downcast::<CFDictionary>()).map(|b| {
            let b: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_get_rule(b.as_concrete_TypeRef()) };
            Rect { x: dict_number(&b, "X").unwrap_or(0.0), y: dict_number(&b, "Y").unwrap_or(0.0), w: dict_number(&b, "Width").unwrap_or(0.0), h: dict_number(&b, "Height").unwrap_or(0.0) }
        }).unwrap_or_default();
        if dict_number(&d, "kCGWindowAlpha").unwrap_or(1.0) <= 0.01 { continue; }
        out.push(WindowInfo {
            id: dict_number(&d, "kCGWindowNumber").unwrap_or(0.0) as u32,
            pid: dict_number(&d, "kCGWindowOwnerPID").unwrap_or(0.0) as i32,
            app: dict_string(&d, "kCGWindowOwnerName").unwrap_or_default(),
            title: dict_string(&d, "kCGWindowName").unwrap_or_default(),
            bounds,
            layer: dict_number(&d, "kCGWindowLayer").unwrap_or(0.0) as i64,
            on_screen: d.find(&CFString::new("kCGWindowIsOnscreen")).map(|v| v.downcast::<core_foundation::boolean::CFBoolean>().map(bool::from).unwrap_or(false)).unwrap_or(false),
        });
    }
    out
}

/// The topmost window under a point (layer ≥ 0, ignoring tiny/transparent ones).
pub fn window_at(x: f64, y: f64) -> Option<WindowInfo> {
    windows(true).into_iter().find(|w| w.bounds.w > 4.0 && w.bounds.h > 4.0 && w.bounds.contains(x, y))
}

// ---------- capture ----------

pub struct Shot { pub width: usize, pub height: usize, pub rect: Rect }

/// Captures `rect` (global points) or a single window, scales it and writes a PNG to `out`.
/// macOS 14+: ScreenCaptureKit (no "private window picker" prompt); older: CGWindowListCreateImage.
pub fn capture(rect: Option<Rect>, window: Option<u32>, out: &str, retina: bool, max_edge: Option<u32>) -> Result<Shot, String> {
    require_screen()?;
    if !super::sck::available() { return capture_legacy(rect, window, out, retina, max_edge); }
    let shown = displays();
    let scale_at = |r: Rect| {
        let bounds: Vec<Rect> = shown.iter().map(|d| d.bounds).collect();
        super::geometry::display_at(&bounds, r.x + r.w / 2.0, r.y + r.h / 2.0).map(|i| shown[i].scale).unwrap_or(2.0)
    };
    let (target, rect, scale) = match window {
        Some(id) => {
            let info = windows(false).into_iter().find(|w| w.id == id).ok_or_else(|| format!("창 {id}을 찾을 수 없습니다. ao-computer windows로 id를 확인하세요."))?;
            (super::sck::Target::Window(id), info.bounds, scale_at(info.bounds))
        }
        None => {
            let rect = rect.ok_or("캡처할 영역이 없습니다")?;
            let bounds: Vec<Rect> = shown.iter().map(|d| d.bounds).collect();
            let (index, clipped, local) = super::geometry::region_on_display(&bounds, rect).ok_or("영역이 어느 화면에도 없습니다")?;
            let d = &shown[index];
            let whole = clipped == d.bounds;
            (super::sck::Target::Display { id: d.id, source: (!whole).then_some(local) }, clipped, d.scale)
        }
    };
    let (w, h) = output_size((rect.w, rect.h), super::geometry::native_size((rect.w, rect.h), scale), retina, max_edge);
    let me = std::process::id() as i32;
    let image = super::sck::capture(&target, (w, h), &|pid, title| pid == me && title == super::INDICATOR_TITLE)?;
    let native = unsafe { (CGImageGetWidth(image), CGImageGetHeight(image)) };
    let result = unsafe { write_png(image, native, (w, h), out) };
    unsafe { CGImageRelease(image) };
    result.map(|_| Shot { width: w, height: h, rect })
}

fn capture_legacy(rect: Option<Rect>, window: Option<u32>, out: &str, retina: bool, max_edge: Option<u32>) -> Result<Shot, String> {
    let (image, rect) = unsafe {
        match window {
            Some(id) => {
                let info = windows(false).into_iter().find(|w| w.id == id).ok_or_else(|| format!("창 {id}을 찾을 수 없습니다. ao-computer windows로 id를 확인하세요."))?;
                let null = CGRect { origin: CGPoint { x: f64::INFINITY, y: f64::INFINITY }, size: CGSize::default() };
                (CGWindowListCreateImage(null, LIST_INCLUDING_WINDOW, id, IMAGE_IGNORE_FRAMING | IMAGE_BEST_RESOLUTION), info.bounds)
            }
            None => {
                let rect = rect.ok_or("캡처할 영역이 없습니다")?;
                (CGWindowListCreateImage(rect.into(), LIST_ON_SCREEN, 0, IMAGE_BEST_RESOLUTION), rect)
            }
        }
    };
    if image.is_null() { return Err("화면을 캡처하지 못했습니다 (화면 기록 권한 또는 잠긴 화면).".into()); }
    let native = unsafe { (CGImageGetWidth(image), CGImageGetHeight(image)) };
    let (w, h) = output_size((rect.w, rect.h), native, retina, max_edge);
    let result = unsafe { write_png(image, native, (w, h), out) };
    unsafe { CGImageRelease(image) };
    result.map(|_| Shot { width: w, height: h, rect })
}

unsafe fn write_png(image: Ref, native: (usize, usize), size: (usize, usize), out: &str) -> Result<(), String> {
    let mut scaled: Ref = std::ptr::null_mut();
    if native != size {
        let space = CGColorSpaceCreateDeviceRGB();
        // kCGImageAlphaPremultipliedLast (1) | kCGBitmapByteOrder32Big (4 << 12)
        let ctx = CGBitmapContextCreate(std::ptr::null_mut(), size.0, size.1, 8, 0, space, 1 | (4 << 12));
        CGColorSpaceRelease(space);
        if ctx.is_null() { return Err("이미지 버퍼를 만들지 못했습니다".into()); }
        CGContextSetInterpolationQuality(ctx, 3);
        CGContextDrawImage(ctx, CGRect { origin: CGPoint::default(), size: CGSize { width: size.0 as f64, height: size.1 as f64 } }, image);
        scaled = CGBitmapContextCreateImage(ctx);
        CGContextRelease(ctx);
    }
    let source = if scaled.is_null() { image } else { scaled };
    let url = CFURL::from_path(out, false).ok_or("저장 경로가 올바르지 않습니다")?;
    let kind = CFString::new("public.png");
    let dest = CGImageDestinationCreateWithURL(url.as_CFTypeRef(), kind.as_concrete_TypeRef(), 1, std::ptr::null());
    let ok = if dest.is_null() { false } else {
        CGImageDestinationAddImage(dest, source, std::ptr::null());
        let ok = CGImageDestinationFinalize(dest);
        CFRelease(dest as CFTypeRef);
        ok
    };
    if !scaled.is_null() { CGImageRelease(scaled); }
    if ok { Ok(()) } else { Err(format!("PNG를 저장하지 못했습니다: {out}")) }
}

// ---------- input ----------

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Button { Left, Right }

unsafe fn post(event: Ref) { if !event.is_null() { CGEventPost(HID_TAP, event); CFRelease(event as CFTypeRef); } }

pub fn cursor() -> CGPoint {
    unsafe { let e = CGEventCreate(std::ptr::null_mut()); if e.is_null() { return CGPoint::default(); } let p = CGEventGetLocation(e); CFRelease(e as CFTypeRef); p }
}

pub fn move_to(p: CGPoint) { unsafe { post(CGEventCreateMouseEvent(std::ptr::null_mut(), 5, p, 0)); } }

pub fn click(p: CGPoint, button: Button, count: i64) {
    let (down, up, b) = match button { Button::Left => (1, 2, 0), Button::Right => (3, 4, 1) };
    move_to(p);
    thread::sleep(Duration::from_millis(30));
    for n in 1..=count {
        unsafe {
            let e = CGEventCreateMouseEvent(std::ptr::null_mut(), down, p, b);
            CGEventSetIntegerValueField(e, MOUSE_CLICK_STATE, n); post(e);
            let e = CGEventCreateMouseEvent(std::ptr::null_mut(), up, p, b);
            CGEventSetIntegerValueField(e, MOUSE_CLICK_STATE, n); post(e);
        }
        thread::sleep(Duration::from_millis(40));
    }
}

pub fn drag(from: CGPoint, to: CGPoint, steps: u32) {
    move_to(from);
    thread::sleep(Duration::from_millis(40));
    unsafe { post(CGEventCreateMouseEvent(std::ptr::null_mut(), 1, from, 0)); }
    thread::sleep(Duration::from_millis(60));
    let steps = steps.clamp(2, 120);
    for i in 1..=steps {
        let t = i as f64 / steps as f64;
        let p = CGPoint { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
        unsafe { post(CGEventCreateMouseEvent(std::ptr::null_mut(), 6, p, 0)); }
        thread::sleep(Duration::from_millis(12));
    }
    unsafe { post(CGEventCreateMouseEvent(std::ptr::null_mut(), 2, to, 0)); }
}

/// dx/dy in pixels; positive dy scrolls content up (like a wheel turned toward the user is negative).
pub fn scroll(dx: i32, dy: i32) {
    // Large deltas are split so apps that clamp a single wheel event still move the whole way.
    let chunks = ((dx.abs().max(dy.abs()) as f64) / 200.0).ceil().max(1.0) as i32;
    for _ in 0..chunks {
        unsafe { post(CGEventCreateScrollWheelEvent(std::ptr::null_mut(), 0, 2, dy / chunks, dx / chunks)); }
        thread::sleep(Duration::from_millis(16));
    }
}

pub fn key(combo: Combo) {
    unsafe {
        let down = CGEventCreateKeyboardEvent(std::ptr::null_mut(), combo.key, true);
        CGEventSetFlags(down, combo.flags); post(down);
        thread::sleep(Duration::from_millis(12));
        let up = CGEventCreateKeyboardEvent(std::ptr::null_mut(), combo.key, false);
        CGEventSetFlags(up, combo.flags); post(up);
    }
}

pub fn type_text(text: &str, stop: &dyn Fn() -> bool) -> Result<usize, String> {
    let mut typed = 0;
    for unit in keys::type_units(text) {
        if stop() { return Err(format!("사용자가 컴퓨터 조작을 중지했습니다 ({typed}자 입력 후)")); }
        match unit {
            TypeUnit::Key(code) => key(Combo { key: code, flags: 0 }),
            TypeUnit::Text(chars) => unsafe {
                let down = CGEventCreateKeyboardEvent(std::ptr::null_mut(), 0, true);
                CGEventSetFlags(down, 0);
                CGEventKeyboardSetUnicodeString(down, chars.len(), chars.as_ptr()); post(down);
                let up = CGEventCreateKeyboardEvent(std::ptr::null_mut(), 0, false);
                CGEventSetFlags(up, 0);
                CGEventKeyboardSetUnicodeString(up, chars.len(), chars.as_ptr()); post(up);
            },
        }
        typed += 1;
        thread::sleep(Duration::from_millis(6));
    }
    Ok(typed)
}

/// Global stop chord state: (Esc held, ⌃⌥⌘ + '.' pressed). Reads HID state; posts nothing.
pub fn stop_keys() -> (bool, bool) {
    unsafe {
        let esc = CGEventSourceKeyState(HID_STATE, keys::KEY_ESCAPE);
        let flags = CGEventSourceFlagsState(HID_STATE);
        let chord = flags & (keys::FLAG_CONTROL | keys::FLAG_OPTION | keys::FLAG_COMMAND) == (keys::FLAG_CONTROL | keys::FLAG_OPTION | keys::FLAG_COMMAND)
            && CGEventSourceKeyState(HID_STATE, keys::KEY_PERIOD);
        (esc, chord)
    }
}

// ---------- apps ----------

#[derive(Debug, Clone, serde::Serialize)]
pub struct AppInfo { pub name: String, pub pid: i32, pub bundle: Option<String>, pub active: bool, pub hidden: bool }

pub fn apps() -> Vec<AppInfo> {
    use objc2::{msg_send, runtime::{AnyClass, AnyObject}};
    use objc2_foundation::NSString;
    let Some(cls) = AnyClass::get(c"NSWorkspace") else { return vec![] };
    let mut out = Vec::new();
    unsafe {
        let ws: *mut AnyObject = msg_send![cls, sharedWorkspace];
        let list: *mut AnyObject = msg_send![ws, runningApplications];
        let count: usize = msg_send![list, count];
        for i in 0..count {
            let app: *mut AnyObject = msg_send![list, objectAtIndex: i];
            let policy: isize = msg_send![app, activationPolicy];
            if policy != 0 { continue; } // regular (Dock) apps only
            let name: *mut NSString = msg_send![app, localizedName];
            let bundle: *mut NSString = msg_send![app, bundleIdentifier];
            out.push(AppInfo {
                name: name.as_ref().map(|s| s.to_string()).unwrap_or_default(),
                pid: msg_send![app, processIdentifier],
                bundle: bundle.as_ref().map(|s| s.to_string()),
                active: msg_send![app, isActive],
                hidden: msg_send![app, isHidden],
            });
        }
    }
    out
}

pub fn frontmost_pid() -> Option<i32> { apps().into_iter().find(|a| a.active).map(|a| a.pid) }

/// Finds a running app by pid, bundle id or (case-insensitive) name.
pub fn find_app(query: &str) -> Option<AppInfo> {
    let q = query.trim();
    let list = apps();
    if let Ok(pid) = q.parse::<i32>() { if let Some(a) = list.iter().find(|a| a.pid == pid) { return Some(a.clone()); } }
    let lower = q.to_lowercase();
    list.iter().find(|a| a.bundle.as_deref().map(|b| b.eq_ignore_ascii_case(q)).unwrap_or(false))
        .or_else(|| list.iter().find(|a| a.name.to_lowercase() == lower))
        .or_else(|| list.iter().find(|a| a.name.to_lowercase().starts_with(&lower)))
        .cloned()
}

/// Brings an app to the front (launches it when it is not running).
pub fn activate(query: &str) -> Result<Value, String> {
    let q = query.trim();
    if q.is_empty() { return Err("활성화할 앱 이름이 필요합니다. 예: ao-computer activate TextEdit".into()); }
    let found = find_app(q);
    let mut cmd = std::process::Command::new("/usr/bin/open");
    match (&found, q.contains('.') && !q.contains(' ')) {
        (Some(AppInfo { bundle: Some(b), .. }), _) => { cmd.args(["-b", b]); }
        (None, true) => { cmd.args(["-b", q]); }
        _ => { cmd.args(["-a", found.as_ref().map(|a| a.name.as_str()).unwrap_or(q)]); }
    }
    let status = cmd.status().map_err(|e| format!("앱을 열지 못했습니다: {e}"))?;
    if !status.success() { return Err(format!("앱을 찾지 못했습니다: {q}. ao-computer apps로 이름을 확인하세요.")); }
    for _ in 0..20 {
        thread::sleep(Duration::from_millis(100));
        if let Some(app) = apps().into_iter().find(|a| a.active) {
            let matches = found.as_ref().map(|f| f.pid == app.pid).unwrap_or_else(|| app.name.to_lowercase().starts_with(&q.to_lowercase()) || app.bundle.as_deref() == Some(q));
            if matches { return Ok(json!({ "activated": app.name, "pid": app.pid, "bundle": app.bundle })); }
        }
    }
    let front = apps().into_iter().find(|a| a.active);
    Ok(json!({ "activated": q, "frontmost": front.map(|a| a.name), "note": "앱을 열었지만 맨 앞으로 오지 않았을 수 있습니다. screenshot으로 확인하세요." }))
}

/// Re-activates an app by pid (used to hand focus back after the approval dialog).
pub fn activate_pid(pid: i32) -> bool {
    use objc2::{msg_send, runtime::{AnyClass, AnyObject}};
    let Some(cls) = AnyClass::get(c"NSRunningApplication") else { return false };
    unsafe {
        let app: *mut AnyObject = msg_send![cls, runningApplicationWithProcessIdentifier: pid];
        if app.is_null() { return false; }
        // NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps
        msg_send![app, activateWithOptions: 3usize]
    }
}

/// App-modal approval alert. Must run on the main thread. Buttons are added in order, so the
/// first one is the default (Return); Esc is mapped to it as well, and `timeout` aborts the alert
/// (NSModalResponseAbort). Returns the NSModalResponse (1000 + button index).
pub fn approval_alert(title: &str, body: &str, buttons: &[&str], timeout: Duration) -> isize {
    use block2::RcBlock;
    use objc2::{msg_send, rc::Retained, runtime::{AnyClass, AnyObject, Bool}};
    use objc2_foundation::NSString;
    const DENY: isize = 1000;
    const KEY_DOWN_MASK: u64 = 1 << 10;
    const ESCAPE: u16 = 53;
    let (Some(alert_cls), Some(app_cls), Some(event_cls), Some(timer_cls), Some(loop_cls)) = (
        AnyClass::get(c"NSAlert"), AnyClass::get(c"NSApplication"), AnyClass::get(c"NSEvent"), AnyClass::get(c"NSTimer"), AnyClass::get(c"NSRunLoop"),
    ) else { return DENY };
    unsafe {
        let Some(alert): Option<Retained<AnyObject>> = msg_send![alert_cls, new] else { return DENY };
        let _: () = msg_send![&*alert, setAlertStyle: 2usize]; // NSAlertStyleCritical
        let _: () = msg_send![&*alert, setMessageText: &*NSString::from_str(title)];
        let _: () = msg_send![&*alert, setInformativeText: &*NSString::from_str(body)];
        let empty = NSString::from_str("");
        for label in buttons {
            let button: *mut AnyObject = msg_send![&*alert, addButtonWithTitle: &*NSString::from_str(label)];
            // No button answers to Return: the alert takes focus while the user may be typing in the
            // chat box, and a stray Return must not decide. Esc (monitor below) still denies.
            if !button.is_null() { let _: () = msg_send![button, setKeyEquivalent: &*empty]; }
        }
        let nsapp: *mut AnyObject = msg_send![app_cls, sharedApplication];
        let _: () = msg_send![nsapp, activateIgnoringOtherApps: Bool::YES];
        let on_key = RcBlock::new(move |event: *mut AnyObject| -> *mut AnyObject {
            if event.is_null() { return event; }
            let code: u16 = msg_send![event, keyCode];
            if code == ESCAPE { let _: () = msg_send![nsapp, stopModalWithCode: DENY]; return std::ptr::null_mut(); }
            event
        });
        let monitor: *mut AnyObject = msg_send![event_cls, addLocalMonitorForEventsMatchingMask: KEY_DOWN_MASK, handler: &*on_key];
        let on_timeout = RcBlock::new(move |_timer: *mut AnyObject| { let _: () = msg_send![nsapp, abortModal]; });
        let timer: *mut AnyObject = msg_send![timer_cls, timerWithTimeInterval: timeout.as_secs_f64(), repeats: Bool::NO, block: &*on_timeout];
        if !timer.is_null() {
            let run_loop: *mut AnyObject = msg_send![loop_cls, currentRunLoop];
            // kCFRunLoopCommonModes includes the modal panel mode runModal spins in.
            let _: () = msg_send![run_loop, addTimer: timer, forMode: &*NSString::from_str("kCFRunLoopCommonModes")];
        }
        let response: isize = msg_send![&*alert, runModal];
        if !timer.is_null() { let _: () = msg_send![timer, invalidate]; }
        if !monitor.is_null() { let _: () = msg_send![event_cls, removeMonitor: monitor]; }
        response
    }
}
