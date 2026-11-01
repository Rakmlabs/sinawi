//! Accessibility tree (AXUIElement) with short-lived element refs (`a1`, `a2`, …).
#![allow(non_upper_case_globals)]

use super::geometry::Rect;
use core_foundation::{
    array::CFArray,
    base::{CFType, CFTypeRef, TCFType},
    boolean::CFBoolean,
    number::CFNumber,
    string::{CFString, CFStringRef},
};
use serde_json::{json, Value};
use std::{collections::HashMap, ffi::c_void, sync::Mutex};

type AXRef = CFTypeRef;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> AXRef;
    fn AXUIElementCreateSystemWide() -> AXRef;
    fn AXUIElementCopyAttributeValue(element: AXRef, attribute: CFStringRef, value: *mut CFTypeRef) -> i32;
    fn AXUIElementSetAttributeValue(element: AXRef, attribute: CFStringRef, value: CFTypeRef) -> i32;
    fn AXUIElementIsAttributeSettable(element: AXRef, attribute: CFStringRef, settable: *mut u8) -> i32;
    fn AXUIElementPerformAction(element: AXRef, action: CFStringRef) -> i32;
    fn AXUIElementGetPid(element: AXRef, pid: *mut i32) -> i32;
    fn AXUIElementSetMessagingTimeout(element: AXRef, seconds: f32) -> i32;
    fn AXValueGetValue(value: CFTypeRef, kind: u32, out: *mut c_void) -> bool;
}
#[link(name = "Carbon", kind = "framework")]
extern "C" { fn IsSecureEventInputEnabled() -> bool; }

/// A retained AXUIElement. CF objects are thread-safe to retain/release.
#[derive(Clone)]
pub struct Element(CFType);
unsafe impl Send for Element {}

impl Element {
    fn raw(&self) -> AXRef { self.0.as_CFTypeRef() }
    fn attr(&self, name: &str) -> Option<CFType> {
        let mut value: CFTypeRef = std::ptr::null();
        let key = CFString::new(name);
        let err = unsafe { AXUIElementCopyAttributeValue(self.raw(), key.as_concrete_TypeRef(), &mut value) };
        (err == 0 && !value.is_null()).then(|| unsafe { CFType::wrap_under_create_rule(value) })
    }
    fn string(&self, name: &str) -> Option<String> {
        let v = self.attr(name)?;
        if let Some(s) = v.downcast::<CFString>() { let s = s.to_string(); return (!s.is_empty()).then_some(s); }
        if let Some(n) = v.downcast::<CFNumber>() { return n.to_f64().map(|f| if f.fract() == 0.0 { format!("{}", f as i64) } else { format!("{f}") }); }
        if let Some(b) = v.downcast::<CFBoolean>() { return Some(bool::from(b).to_string()); }
        None
    }
    fn bool(&self, name: &str) -> Option<bool> { self.attr(name)?.downcast::<CFBoolean>().map(bool::from) }
    fn element(&self, name: &str) -> Option<Element> {
        let v = self.attr(name)?;
        (v.type_of() == unsafe { AXUIElementGetTypeID() }).then_some(Element(v))
    }
    fn children(&self) -> Vec<Element> {
        let Some(v) = self.attr("AXChildren") else { return vec![] };
        let Some(arr) = v.downcast::<CFArray>() else { return vec![] };
        let arr: CFArray<CFType> = unsafe { CFArray::wrap_under_get_rule(arr.as_concrete_TypeRef()) };
        arr.iter().map(|c| Element(c.clone())).collect()
    }
    pub fn pid(&self) -> i32 { let mut pid = 0; unsafe { AXUIElementGetPid(self.raw(), &mut pid) }; pid }
    pub fn role(&self) -> String { self.string("AXRole").unwrap_or_default() }
    pub fn subrole(&self) -> String { self.string("AXSubrole").unwrap_or_default() }
    pub fn is_secure(&self) -> bool { is_secure_role(&self.role(), &self.subrole()) }
    pub fn frame(&self) -> Option<Rect> {
        let (mut p, mut s) = ([0f64; 2], [0f64; 2]);
        let pos = self.attr("AXPosition")?; let size = self.attr("AXSize")?;
        let ok = unsafe { AXValueGetValue(pos.as_CFTypeRef(), 1, p.as_mut_ptr() as _) && AXValueGetValue(size.as_CFTypeRef(), 2, s.as_mut_ptr() as _) };
        ok.then_some(Rect { x: p[0], y: p[1], w: s[0], h: s[1] })
    }
    pub fn press(&self) -> Result<(), i32> {
        let action = CFString::new("AXPress");
        match unsafe { AXUIElementPerformAction(self.raw(), action.as_concrete_TypeRef()) } { 0 => Ok(()), e => Err(e) }
    }
    pub fn set_value(&self, text: &str) -> Result<(), String> {
        let attr = CFString::new("AXValue");
        let mut settable = 0u8;
        unsafe { AXUIElementIsAttributeSettable(self.raw(), attr.as_concrete_TypeRef(), &mut settable) };
        if settable == 0 { return Err(format!("이 요소({})는 값을 바꿀 수 없습니다. ax_click 후 type을 쓰세요.", self.role())); }
        let focused = CFString::new("AXFocused");
        unsafe { AXUIElementSetAttributeValue(self.raw(), focused.as_concrete_TypeRef(), CFBoolean::true_value().as_CFTypeRef()) };
        let value = CFString::new(text);
        match unsafe { AXUIElementSetAttributeValue(self.raw(), attr.as_concrete_TypeRef(), value.as_CFTypeRef()) } { 0 => Ok(()), e => Err(format!("값을 설정하지 못했습니다 (AX 오류 {e})")) }
    }
}

extern "C" { fn AXUIElementGetTypeID() -> core_foundation::base::CFTypeID; }

pub fn is_secure_role(role: &str, subrole: &str) -> bool { role == "AXSecureTextField" || subrole == "AXSecureTextField" }

pub fn app_element(pid: i32) -> Element {
    let raw = unsafe { AXUIElementCreateApplication(pid) };
    unsafe { AXUIElementSetMessagingTimeout(raw, 1.0) };
    Element(unsafe { CFType::wrap_under_create_rule(raw) })
}

/// The element with keyboard focus anywhere on the system.
pub fn focused_element() -> Option<Element> {
    let sys = Element(unsafe { CFType::wrap_under_create_rule(AXUIElementCreateSystemWide()) });
    unsafe { AXUIElementSetMessagingTimeout(sys.raw(), 0.5) };
    sys.element("AXFocusedUIElement")
}

/// True when a password field has focus (AX role, or macOS secure keyboard input mode).
pub fn secure_input_active() -> bool {
    let secure_mode = unsafe { IsSecureEventInputEnabled() };
    secure_mode || focused_element().map(|e| e.is_secure()).unwrap_or(false)
}

static REFS: Mutex<Option<HashMap<String, Element>>> = Mutex::new(None);

pub fn lookup(reference: &str) -> Result<Element, String> {
    let guard = REFS.lock().map_err(|_| "ax ref 저장소 오류")?;
    guard.as_ref().and_then(|m| m.get(reference).cloned()).ok_or_else(|| format!("ref {reference}를 찾을 수 없습니다. 화면이 바뀌었으면 ao-computer ax를 다시 실행하세요."))
}

const INTERESTING: &[&str] = &["AXButton", "AXTextField", "AXTextArea", "AXSecureTextField", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXMenuButton", "AXMenuItem", "AXMenuBarItem", "AXLink", "AXSlider", "AXTab", "AXTabGroup", "AXCell", "AXRow", "AXStaticText", "AXImage", "AXIncrementor", "AXDisclosureTriangle", "AXSearchField", "AXToolbar", "AXWindow", "AXSheet", "AXDialog", "AXList", "AXTable", "AXOutline", "AXWebArea", "AXHeading", "AXColorWell", "AXSegmentedControl"];

fn label(e: &Element, role: &str, secure: bool) -> String {
    let mut text = String::new();
    for key in ["AXTitle", "AXDescription", "AXPlaceholderValue", "AXHelp"] {
        if let Some(v) = e.string(key) { text = v; break; }
    }
    let value = if secure { None } else if role == "AXStaticText" && text.is_empty() { e.string("AXValue") } else { e.string("AXValue").filter(|v| v != &text) };
    let clip = |s: &str, n: usize| { let s = s.replace('\n', " "); if s.chars().count() > n { format!("{}…", s.chars().take(n).collect::<String>()) } else { s } };
    let mut out = String::new();
    if !text.is_empty() { out.push_str(&format!(" \"{}\"", clip(&text, 80))); }
    if let Some(v) = value { out.push_str(&format!(" = \"{}\"", clip(&v, 80))); }
    if secure { out.push_str(" [비밀번호 칸: 입력 금지]"); }
    out
}

/// Builds the tree text for an app (pid) and stores the refs. `window`: index into AXWindows.
pub fn tree(pid: i32, window: Option<usize>, max_depth: usize, max_nodes: usize) -> Result<Value, String> {
    let app = app_element(pid);
    let root = match window {
        Some(i) => {
            let wins = app.attr("AXWindows").and_then(|v| v.downcast::<CFArray>()).map(|a| unsafe { CFArray::<CFType>::wrap_under_get_rule(a.as_concrete_TypeRef()) });
            let wins = wins.ok_or("이 앱의 창 목록을 읽지 못했습니다")?;
            let w = wins.get(i as isize).ok_or_else(|| format!("창 {i}이 없습니다 (창 {}개)", wins.len()))?;
            Element(w.clone())
        }
        None => app.element("AXFocusedWindow").or_else(|| app.element("AXMainWindow")).unwrap_or_else(|| app.clone()),
    };
    let mut refs = HashMap::new();
    let mut lines = Vec::new();
    let mut truncated = false;
    let mut stack = vec![(root, 0usize)];
    // Menu bar too, when we are at the window level (menus are a common target).
    let menubar = app.element("AXMenuBar");
    while let Some((el, depth)) = stack.pop() {
        if refs.len() >= max_nodes { truncated = true; break; }
        let role = el.role();
        let subrole = el.subrole();
        let secure = is_secure_role(&role, &subrole);
        let show = INTERESTING.contains(&role.as_str()) || depth == 0;
        let mut next_depth = depth;
        if show {
            let id = format!("a{}", refs.len() + 1);
            let frame = el.frame().map(|r| format!(" ({:.0},{:.0} {:.0}×{:.0})", r.x, r.y, r.w, r.h)).unwrap_or_default();
            let disabled = if el.bool("AXEnabled") == Some(false) { " (비활성)" } else { "" };
            let focused = if el.bool("AXFocused") == Some(true) { " (포커스)" } else { "" };
            let sub = if subrole.is_empty() || subrole == "AXSecureTextField" { String::new() } else { format!(" {subrole}") };
            lines.push(format!("{}[{id}] {role}{sub}{}{frame}{disabled}{focused}", "  ".repeat(depth.min(20)), label(&el, &role, secure)));
            refs.insert(id, el.clone());
            next_depth = depth + 1;
        }
        if depth >= max_depth || secure { continue; }
        let kids = el.children();
        for kid in kids.into_iter().rev() { stack.push((kid, next_depth)); }
    }
    if let Some(bar) = menubar {
        if refs.len() < max_nodes {
            lines.push("[메뉴 막대]".into());
            for item in bar.children().into_iter().take(20) {
                let id = format!("a{}", refs.len() + 1);
                lines.push(format!("  [{id}] AXMenuBarItem{}", label(&item, "AXMenuBarItem", false)));
                refs.insert(id, item);
            }
        }
    }
    let count = refs.len();
    *REFS.lock().map_err(|_| "ax ref 저장소 오류")? = Some(refs);
    Ok(json!({ "tree": lines.join("\n"), "count": count, "truncated": truncated }))
}
