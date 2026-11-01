//! Computer use: agents call `ao-computer` → server computer bridge → the app window relays the
//! command here (`computer_exec`). The native work runs in this process because Sinawi.app holds
//! the Screen Recording / Accessibility grants (CLIs spawned by the launchd server do not).
//!
//! Trust boundary. Agents run as the same macOS user, so they can rewrite the server and the
//! page the main window loads (http://127.0.0.1:3001); nothing that arrives through IPC is
//! trusted. The only boundary is the native approval alert below: a command for a key without a
//! grant blocks on an app-modal NSAlert that Rust shows itself, and only the user's click on it
//! creates a grant. There is no IPC command that grants anything; the webview can only run
//! commands (which then ask natively), revoke, or stop. The agent cannot drive that alert: CLIs
//! hold no Accessibility grant, and no computer action runs while it is open (they are serialised
//! behind `EXEC`, which the alert holds). The dialog's agent/workspace/session text comes from
//! the request and is shown as such.
//!
//! Further guards: a global stop (Esc held ~0.7s or ⌃⌥⌘.) revokes every grant at once, password
//! fields are never typed into, and Sinawi's own window is not clicked/typed into unless
//! explicitly targeted. Every command also checks that it came from the `main` webview.

pub mod geometry;
pub mod keys;
#[cfg(target_os = "macos")]
mod ax;
#[cfg(target_os = "macos")]
mod native;
#[cfg(target_os = "macos")]
mod sck;

use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Mutex, OnceLock},
    time::{Duration, Instant},
};

static STOPPED: AtomicBool = AtomicBool::new(false);
static ACTIVE: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicUsize = AtomicUsize::new(0);
static GRANTS: Mutex<Option<Grants>> = Mutex::new(None);
static SEEN: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
static EXEC: Mutex<()> = Mutex::new(());
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

const SESSION_GRANT: Duration = Duration::from_secs(8 * 60 * 60);
/// A denial suppresses new dialogs for the same key for a while (no dialog spam).
const DENY_COOLDOWN: Duration = Duration::from_secs(10 * 60);
const DIALOG_TIMEOUT: Duration = Duration::from_secs(120);
const INDICATOR: &str = "computer-indicator";
const MAIN_WINDOW: &str = "main";
/// The indicator's window title; ScreenCaptureKit display captures exclude it by (pid, title).
pub(crate) const INDICATOR_TITLE: &str = "Sinawi 컴퓨터 조작 중";
/// Error prefixes the server maps to its own messages.
const DENIED: &str = "[denied] ";
const APPROVAL_TIMEOUT: &str = "[approval-timeout] ";
/// NSAlert buttons, in order. The first one is the default (Return); Esc is mapped to it too.
pub(crate) const DIALOG_BUTTONS: [&str; 3] = ["거부", "이번만", "이 세션 동안"];

/// What the user chose in the native alert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Decision { Deny, Once, Session, Timeout }

/// NSModalResponse → decision. NSAlertFirstButtonReturn = 1000; abortModal (timeout) = -1001.
/// Anything unexpected is a denial.
pub(crate) fn decision_from_response(code: isize) -> Decision {
    match code { 1001 => Decision::Once, 1002 => Decision::Session, -1001 => Decision::Timeout, _ => Decision::Deny }
}

/// Display-only facts for the alert, relayed with each command (they come from the request).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RequestContext {
    pub agent: Option<String>,
    pub workspace: Option<String>,
    pub title: Option<String>,
    pub summary: Option<String>,
}

#[derive(Debug, Default)]
struct Grants { session: HashMap<String, Instant>, denied: HashMap<String, Instant> }

#[derive(Debug, PartialEq, Eq)]
enum Check { Granted, Denied, Ask }

/// Appends to ~/Library/Logs/Sinawi/computer.log (the server logs each action with its agent).
pub fn log(line: &str) {
    use std::io::Write;
    if cfg!(test) { return; }
    let Some(home) = std::env::var_os("HOME") else { return };
    let dir = std::path::Path::new(&home).join("Library/Logs/Sinawi");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("computer.log")) {
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "{secs} [app] {line}");
    }
}

fn with_grants<T>(f: impl FnOnce(&mut Grants) -> T) -> T {
    let mut guard = GRANTS.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(Grants::default))
}

/// Only the main window's webview may call computer commands (the indicator window must not).
fn require_main(label: &str) -> Result<(), String> {
    if label == MAIN_WINDOW { Ok(()) } else { Err("컴퓨터 조작 명령은 Sinawi 기본 창에서만 쓸 수 있습니다.".into()) }
}

/// Grant lookup, dropping expired entries. Pure over the map (unit-tested).
fn check(grants: &mut Grants, key: &str, now: Instant) -> Check {
    match grants.session.get(key) { Some(until) if *until > now => return Check::Granted, Some(_) => { grants.session.remove(key); } None => {} }
    match grants.denied.get(key) { Some(until) if *until > now => return Check::Denied, Some(_) => { grants.denied.remove(key); } None => {} }
    Check::Ask
}

/// Records the native alert's answer. Only `authorize` (fed by the NSAlert) calls this.
fn record(grants: &mut Grants, key: &str, decision: Decision, now: Instant) {
    match decision {
        Decision::Session => { grants.denied.remove(key); grants.session.insert(key.to_string(), now + SESSION_GRANT); }
        Decision::Deny => { grants.session.remove(key); grants.denied.insert(key.to_string(), now + DENY_COOLDOWN); }
        Decision::Once | Decision::Timeout => {}
    }
}

fn has_session_grant(now: Instant) -> bool { with_grants(|g| g.session.values().any(|until| *until > now)) }

/// One line of untrusted text for the alert: no control characters, bounded length.
fn clean(text: Option<&str>, max: usize) -> String {
    let flat: String = text.unwrap_or("").chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max { return flat; }
    format!("{}…", flat.chars().take(max).collect::<String>())
}

fn agent_label(agent: Option<&str>) -> String {
    match agent.map(str::trim).unwrap_or("") {
        "claude" => "Claude".into(),
        "codex" => "Codex".into(),
        "grok" => "Grok".into(),
        "" => "에이전트".into(),
        other => clean(Some(other), 24),
    }
}

/// Title and body of the native approval alert. Pure (unit-tested).
pub(crate) fn dialog_text(ctx: &RequestContext) -> (String, String) {
    let title = format!("{}이(가) 컴퓨터를 조작하려고 합니다", agent_label(ctx.agent.as_deref()));
    let dash = |s: String| if s.is_empty() { "-".to_string() } else { s };
    let body = format!(
        "작업 공간: {}\n세션: {}\n첫 동작: {}\n\n허용하면 화면을 보고 마우스·키보드로 다른 앱을 조작합니다. 비밀번호 칸에는 입력하지 않습니다. 언제든 Esc를 길게 누르거나 ⌃⌥⌘.로 멈출 수 있습니다.\n\n위 정보는 요청한 쪽이 보낸 내용입니다. 직접 시킨 작업이 아니면 거부하세요.",
        dash(clean(ctx.workspace.as_deref(), 80)),
        dash(clean(ctx.title.as_deref(), 120)),
        dash(clean(ctx.summary.as_deref(), 120)),
    );
    (title, body)
}

/// Decides whether `action` may run for `key`, asking the user natively when there is no grant.
/// `ask` is the NSAlert in the app and a stub in tests. Returns the fresh grant ("once" /
/// "session") when the user was just asked, so the UI can show it.
fn authorize(key: &str, action: &str, ctx: &RequestContext, ask: impl FnOnce(&RequestContext) -> Decision) -> Result<Option<&'static str>, String> {
    if action == "status" { return Ok(None); }
    if key.trim().is_empty() { return Err("요청에 세션 키가 없습니다.".into()); }
    match with_grants(|g| check(g, key, Instant::now())) {
        Check::Granted => return Ok(None),
        Check::Denied => return Err(format!("{DENIED}사용자가 이 세션의 컴퓨터 조작을 거부했습니다.")),
        Check::Ask => {}
    }
    let decision = ask(ctx);
    with_grants(|g| record(g, key, decision, Instant::now()));
    log(&format!("native approval {decision:?} for {key}"));
    match decision {
        Decision::Deny => Err(format!("{DENIED}사용자가 이 세션의 컴퓨터 조작을 거부했습니다.")),
        Decision::Timeout => Err(format!("{APPROVAL_TIMEOUT}사용자가 {}초 안에 답하지 않았습니다.", DIALOG_TIMEOUT.as_secs())),
        Decision::Once => { STOPPED.store(false, Ordering::SeqCst); Ok(Some("once")) }
        Decision::Session => { STOPPED.store(false, Ordering::SeqCst); Ok(Some("session")) }
    }
}

/// Shows the native alert on the main thread and waits for the answer.
#[cfg(target_os = "macos")]
fn ask_user(app: &tauri::AppHandle, ctx: &RequestContext) -> Decision {
    let (title, body) = dialog_text(ctx);
    let (tx, rx) = std::sync::mpsc::channel();
    let posted = app.run_on_main_thread(move || {
        let previous = native::frontmost_pid().filter(|pid| *pid != std::process::id() as i32);
        let decision = decision_from_response(native::approval_alert(&title, &body, &DIALOG_BUTTONS, DIALOG_TIMEOUT));
        // Hand focus back to the app the agent was working in.
        if let (Some(pid), Decision::Once | Decision::Session) = (previous, decision) { native::activate_pid(pid); }
        let _ = tx.send(decision);
    });
    if posted.is_err() { return Decision::Deny; }
    rx.recv_timeout(DIALOG_TIMEOUT + Duration::from_secs(15)).unwrap_or(Decision::Timeout)
}

#[cfg(not(target_os = "macos"))]
fn ask_user(_app: &tauri::AppHandle, _ctx: &RequestContext) -> Decision { Decision::Deny }

/// Shows/hides the on-screen indicator and arms the stop hotkey from native state only (a
/// session grant exists or an action is running), never from what the webview says.
fn refresh_active() {
    let active = RUNNING.load(Ordering::SeqCst) > 0 || has_session_grant(Instant::now());
    let was = ACTIVE.swap(active, Ordering::SeqCst);
    if was != active { if let Some(app) = APP.get() { show_indicator(app, active); } }
}

fn stop_all(reason: &str) {
    STOPPED.store(true, Ordering::SeqCst);
    with_grants(|g| g.session.clear());
    log(&format!("STOP ({reason}): every grant revoked"));
    if let Some(app) = APP.get() {
        use tauri::Emitter;
        let _ = app.emit_to(MAIN_WINDOW, "computer-stop", json!({ "reason": reason }));
    }
    refresh_active();
}

/// Drops one session's grant (or all). It can only take permissions away.
#[tauri::command]
pub fn computer_revoke(webview: tauri::Webview, key: Option<String>) -> Result<(), String> {
    require_main(webview.label())?;
    with_grants(|g| match &key { Some(k) => { g.session.remove(k); } None => g.session.clear() });
    refresh_active();
    Ok(())
}

/// Global stop from the UI (banner button) — same effect as the hotkey.
#[tauri::command]
pub fn computer_stop(webview: tauri::Webview) -> Result<(), String> {
    require_main(webview.label())?;
    stop_all("ui");
    Ok(())
}

/// Runs one command. Without a grant for `key` this blocks on the native approval alert first.
/// Returns `{ value, grant }` (`grant` is "once"/"session" when the user was just asked).
#[tauri::command]
pub async fn computer_exec(app: tauri::AppHandle, webview: tauri::Webview, id: String, key: String, action: String, args: Value, context: Option<RequestContext>) -> Result<Value, String> {
    require_main(webview.label())?;
    let _ = APP.set(app.clone());
    ensure_watcher();
    {
        let mut seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
        if seen.contains(&id) { return Err("duplicate".into()); }
        seen.push_back(id.clone());
        if seen.len() > 256 { seen.pop_front(); }
    }
    let ctx = context.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        if action == "status" { return run(&action, &args).map(|value| json!({ "value": value, "grant": Value::Null })); }
        // Held across the alert too: nothing else runs (or clicks the alert) while the user decides.
        let _guard = EXEC.lock().unwrap_or_else(|e| e.into_inner());
        let grant = authorize(&key, &action, &ctx, |ctx| ask_user(&app, ctx))?;
        RUNNING.fetch_add(1, Ordering::SeqCst);
        refresh_active();
        let result = run(&action, &args);
        RUNNING.fetch_sub(1, Ordering::SeqCst);
        refresh_active();
        let summary = match &result { Ok(_) => "ok".to_string(), Err(e) => format!("error: {e}") };
        log(&format!("{action} key={key} -> {summary}"));
        result.map(|value| json!({ "value": value, "grant": grant }))
    }).await.map_err(|e| format!("실행 실패: {e}"))?
}

fn ensure_watcher() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) { return; }
    std::thread::spawn(|| {
        let mut esc_since: Option<Instant> = None;
        loop {
            std::thread::sleep(Duration::from_millis(40));
            // Session grants expire on their own; keep the indicator in step.
            if ACTIVE.load(Ordering::SeqCst) { refresh_active(); }
            if !ACTIVE.load(Ordering::SeqCst) || STOPPED.load(Ordering::SeqCst) { esc_since = None; continue; }
            #[cfg(target_os = "macos")]
            {
                let (esc, chord) = native::stop_keys();
                esc_since = if esc { esc_since.or(Some(Instant::now())) } else { None };
                if chord || esc_since.is_some_and(|t| t.elapsed() >= Duration::from_millis(700)) {
                    esc_since = None;
                    stop_all(if chord { "hotkey ⌃⌥⌘." } else { "Esc held" });
                }
            }
        }
    });
}

fn show_indicator(app: &tauri::AppHandle, visible: bool) {
    use tauri::Manager;
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let existing = app2.get_webview_window(INDICATOR);
        if !visible { if let Some(w) = existing { let _ = w.hide(); } return; }
        let window = match existing {
            Some(w) => w,
            None => {
                // No capability lists this label, and every computer_* command checks for `main`.
                let built = tauri::WebviewWindowBuilder::new(&app2, INDICATOR, tauri::WebviewUrl::App("computer-indicator.html".into()))
                    .title(INDICATOR_TITLE)
                    .inner_size(430.0, 34.0)
                    .resizable(false).decorations(false).always_on_top(true).skip_taskbar(true)
                    .focused(false).focusable(false).shadow(true).visible(false)
                    .visible_on_all_workspaces(true)
                    // Excluded from screen capture, so agents never see (or click) the overlay.
                    .content_protected(true)
                    .build();
                match built { Ok(w) => w, Err(e) => { log(&format!("indicator window failed: {e}")); return; } }
            }
        };
        if let Ok(Some(monitor)) = window.primary_monitor() {
            let scale = monitor.scale_factor();
            let size = monitor.size().to_logical::<f64>(scale);
            let pos = monitor.position().to_logical::<f64>(scale);
            let _ = window.set_position(tauri::LogicalPosition::new(pos.x + (size.width - 430.0) / 2.0, pos.y + 40.0));
        }
        let _ = window.set_ignore_cursor_events(true);
        let _ = window.show();
    });
}

// ---------- action dispatch ----------

#[cfg(not(target_os = "macos"))]
fn run(_action: &str, _args: &Value) -> Result<Value, String> { Err("컴퓨터 조작은 macOS에서만 지원합니다.".into()) }

#[cfg(target_os = "macos")]
fn run(action: &str, args: &Value) -> Result<Value, String> {
    use geometry::Rect;
    use native::{Button, CGPoint};
    let num = |k: &str| args.get(k).and_then(Value::as_f64);
    let text = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let allow_self = args.get("allowSelf").and_then(Value::as_bool).unwrap_or(false);
    let me = std::process::id() as i32;
    let point = |kx: &str, ky: &str| -> Result<CGPoint, String> {
        let (Some(x), Some(y)) = (num(kx), num(ky)) else { return Err("좌표(x y)가 필요합니다".into()) };
        let shown = native::displays();
        if geometry::display_at(&shown.iter().map(|d| d.bounds).collect::<Vec<_>>(), x, y).is_none() {
            return Err(format!("좌표 ({x:.0}, {y:.0})가 어느 화면에도 없습니다. 좌표는 화면 포인트입니다 (screenshot의 rect/scale 참고)."));
        }
        if let Some(w) = native::window_at(x, y) {
            if w.pid == me && w.layer == 0 && !allow_self {
                return Err("이 위치는 Sinawi 자신의 창입니다. 다른 앱을 조작하려면 그 앱을 activate 하세요 (Sinawi를 직접 누르려면 --self).".into());
            }
        }
        Ok(CGPoint { x, y })
    };
    let not_self_front = || -> Result<(), String> {
        if !allow_self && native::frontmost_pid() == Some(me) {
            return Err("지금 맨 앞 앱이 Sinawi입니다. 입력할 앱을 먼저 ao-computer activate <앱>으로 앞으로 가져오세요.".into());
        }
        Ok(())
    };
    let input = || native::require_accessibility();
    let stopped = || STOPPED.load(Ordering::SeqCst);
    let after = |p: CGPoint, extra: Value| { let mut v = json!({ "x": p.x, "y": p.y }); if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) { o.extend(e.clone()); } v };

    match action {
        "status" => {
            let front = native::apps().into_iter().find(|a| a.active);
            Ok(json!({
                "native": true,
                "screen": if native::screen_granted() { "granted" } else { "denied" },
                "accessibility": if native::accessibility_granted() { "granted" } else { "denied" },
                "panes": { "screen": native::SCREEN_PANE, "accessibility": native::ACCESSIBILITY_PANE },
                "stopped": stopped(),
                "displays": native::displays(),
                "frontmost": front.map(|a| a.name),
                "coordinates": "global screen points (top-left of main display = 0,0)",
            }))
        }
        "screenshot" => {
            let out = text("out");
            if !out.ends_with(".png") || !out.contains("sinawi-computer") { return Err("screenshot 저장 경로가 올바르지 않습니다".into()); }
            let retina = args.get("retina").and_then(Value::as_bool).unwrap_or(false);
            let max = num("max").map(|m| m as u32);
            let shown = native::displays();
            if shown.is_empty() { return Err("연결된 화면이 없습니다".into()); }
            let (rect, window, display) = if let Some(id) = num("window") {
                (None, Some(id as u32), None)
            } else if !text("app").is_empty() {
                let app = native::find_app(&text("app")).ok_or_else(|| format!("앱을 찾을 수 없습니다: {}", text("app")))?;
                let w = native::windows(true).into_iter().find(|w| w.pid == app.pid && w.layer == 0 && w.bounds.w > 40.0).ok_or_else(|| format!("{}의 화면에 보이는 창이 없습니다", app.name))?;
                (None, Some(w.id), None)
            } else if let Some(region) = args.get("region") {
                let r = Rect { x: region["x"].as_f64().unwrap_or(0.0), y: region["y"].as_f64().unwrap_or(0.0), w: region["w"].as_f64().unwrap_or(0.0), h: region["h"].as_f64().unwrap_or(0.0) };
                if r.w < 1.0 || r.h < 1.0 { return Err("영역 크기가 올바르지 않습니다".into()); }
                (Some(r), None, None)
            } else {
                let index = num("display").unwrap_or(0.0) as usize;
                let d = shown.get(index).ok_or_else(|| format!("화면 {index}이 없습니다 (화면 {}개)", shown.len()))?;
                (Some(d.bounds), None, Some(index))
            };
            let shot = native::capture(rect, window, &out, retina, max)?;
            let scale = shot.width as f64 / shot.rect.w.max(1.0);
            Ok(json!({ "path": out, "width": shot.width, "height": shot.height, "scale": scale, "rect": shot.rect, "display": display, "window": window,
                "displays": shown, "note": "클릭 좌표 = rect.x + 픽셀x / scale, rect.y + 픽셀y / scale (또는 --pixels)" }))
        }
        "click" | "double_click" | "right_click" => {
            input()?;
            let p = point("x", "y")?;
            let (button, count) = match action { "double_click" => (Button::Left, 2), "right_click" => (Button::Right, 1), _ => (Button::Left, 1) };
            native::click(p, button, count);
            Ok(after(p, json!({ "clicked": action })))
        }
        "move" => { input()?; let p = point("x", "y")?; native::move_to(p); Ok(after(p, json!({ "moved": true }))) }
        "drag" => {
            input()?;
            let from = point("x", "y")?; let to = point("x2", "y2")?;
            native::drag(from, to, num("steps").unwrap_or(24.0) as u32);
            Ok(json!({ "dragged": { "from": [from.x, from.y], "to": [to.x, to.y] } }))
        }
        "scroll" => {
            input()?;
            if let (Some(_), Some(_)) = (num("x"), num("y")) { let p = point("x", "y")?; native::move_to(p); std::thread::sleep(Duration::from_millis(30)); }
            let amount = num("amount").unwrap_or(300.0).clamp(1.0, 5000.0) as i32;
            let (dx, dy) = match text("direction").as_str() { "up" => (0, amount), "left" => (amount, 0), "right" => (-amount, 0), _ => (0, -amount) };
            native::scroll(dx, dy);
            Ok(json!({ "scrolled": text("direction"), "amount": amount }))
        }
        "type" => {
            input()?;
            not_self_front()?;
            if ax::secure_input_active() { return Err("포커스된 칸이 비밀번호(보안 입력) 칸이라 입력을 거부했습니다. 비밀번호는 사용자가 직접 입력해야 합니다.".into()); }
            let typed = native::type_text(&text("text"), &stopped)?;
            Ok(json!({ "typed": typed }))
        }
        "key" => {
            input()?;
            not_self_front()?;
            let combo = keys::parse_combo(&text("key"))?;
            if ax::secure_input_active() && !keys::allowed_in_secure_field(&combo) { return Err("비밀번호 칸에 포커스가 있어 키 입력을 거부했습니다 (Tab/Esc만 허용).".into()); }
            let repeat = num("repeat").unwrap_or(1.0).clamp(1.0, 50.0) as u32;
            for _ in 0..repeat { if stopped() { break; } native::key(combo); std::thread::sleep(Duration::from_millis(30)); }
            Ok(json!({ "pressed": text("key"), "repeat": repeat }))
        }
        "cursor" => { let p = native::cursor(); Ok(json!({ "x": p.x, "y": p.y })) }
        "apps" => Ok(json!({ "apps": native::apps() })),
        "windows" => {
            native::require_screen()?;
            let filter = text("app");
            let pid = if filter.is_empty() { None } else { Some(native::find_app(&filter).ok_or_else(|| format!("앱을 찾을 수 없습니다: {filter}"))?.pid) };
            let all = args.get("all").and_then(Value::as_bool).unwrap_or(false);
            let list: Vec<_> = native::windows(!all).into_iter().filter(|w| (all || w.layer == 0) && pid.is_none_or(|p| w.pid == p)).collect();
            Ok(json!({ "windows": list }))
        }
        "activate" => native::activate(&text("app")),
        "ax" => {
            input()?;
            let app = if text("app").is_empty() { native::apps().into_iter().find(|a| a.active).ok_or("맨 앞 앱을 찾지 못했습니다")? } else { native::find_app(&text("app")).ok_or_else(|| format!("앱을 찾을 수 없습니다: {}", text("app")))? };
            let mut tree = ax::tree(app.pid, num("window").map(|w| w as usize), num("depth").unwrap_or(30.0) as usize, num("max").unwrap_or(400.0) as usize)?;
            if let Some(o) = tree.as_object_mut() { o.insert("app".into(), json!(app.name)); o.insert("pid".into(), json!(app.pid)); }
            Ok(tree)
        }
        "ax_click" => {
            input()?;
            let el = ax::lookup(&text("ref"))?;
            if el.pid() == me && !allow_self { return Err("Sinawi 자신의 요소입니다. 직접 누르려면 --self.".into()); }
            match el.press() {
                Ok(()) => Ok(json!({ "pressed": text("ref"), "role": el.role(), "via": "AXPress" })),
                Err(code) => {
                    let frame = el.frame().ok_or_else(|| format!("누를 수 없는 요소입니다 (AX 오류 {code}, 위치 없음)"))?;
                    let p = CGPoint { x: frame.x + frame.w / 2.0, y: frame.y + frame.h / 2.0 };
                    native::click(p, Button::Left, 1);
                    Ok(after(p, json!({ "pressed": text("ref"), "role": el.role(), "via": "click" })))
                }
            }
        }
        "ax_set_value" => {
            input()?;
            let el = ax::lookup(&text("ref"))?;
            if el.is_secure() { return Err("비밀번호(보안 입력) 칸에는 값을 넣지 않습니다. 사용자가 직접 입력해야 합니다.".into()); }
            if el.pid() == me && !allow_self { return Err("Sinawi 자신의 요소입니다. 직접 바꾸려면 --self.".into()); }
            el.set_value(&text("text"))?;
            Ok(json!({ "set": text("ref"), "role": el.role() }))
        }
        "wait" => { std::thread::sleep(Duration::from_millis(num("ms").unwrap_or(500.0).clamp(0.0, 30_000.0) as u64)); Ok(json!({ "waited": num("ms").unwrap_or(500.0) })) }
        other => Err(format!("알 수 없는 컴퓨터 명령: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grants_come_only_from_recorded_decisions_and_expire() {
        let mut g = Grants::default();
        let now = Instant::now();
        assert_eq!(check(&mut g, "s1", now), Check::Ask);
        record(&mut g, "s1", Decision::Once, now);
        assert_eq!(check(&mut g, "s1", now), Check::Ask, "once never leaves a grant behind");
        record(&mut g, "s2", Decision::Session, now);
        assert_eq!(check(&mut g, "s2", now), Check::Granted);
        assert_eq!(check(&mut g, "s2", now + SESSION_GRANT + Duration::from_secs(1)), Check::Ask, "session grants expire");
        record(&mut g, "s3", Decision::Session, now);
        record(&mut g, "s3", Decision::Deny, now);
        assert_eq!(check(&mut g, "s3", now), Check::Denied, "a denial replaces the grant and sticks");
        assert_eq!(check(&mut g, "s3", now + DENY_COOLDOWN + Duration::from_secs(1)), Check::Ask, "and then expires");
        record(&mut g, "s4", Decision::Timeout, now);
        assert_eq!(check(&mut g, "s4", now), Check::Ask, "no answer is no grant");
    }

    #[test]
    fn alert_responses_map_to_decisions_and_default_to_deny() {
        assert_eq!(DIALOG_BUTTONS[0], "거부", "the default (Return/Esc) button denies");
        assert_eq!(decision_from_response(1000), Decision::Deny);
        assert_eq!(decision_from_response(1001), Decision::Once);
        assert_eq!(decision_from_response(1002), Decision::Session);
        assert_eq!(decision_from_response(-1001), Decision::Timeout);
        assert_eq!(decision_from_response(-1000), Decision::Deny);
        assert_eq!(decision_from_response(42), Decision::Deny);
    }

    #[test]
    fn only_the_main_webview_may_call() {
        assert!(require_main("main").is_ok());
        assert!(require_main("computer-indicator").is_err());
        assert!(require_main("").is_err());
    }

    #[test]
    fn dialog_text_shows_request_facts_cleaned() {
        let ctx = RequestContext { agent: Some("codex".into()), workspace: Some("개인".into()), title: Some("메모\n정리\u{7}".into()), summary: Some("x".repeat(500)) };
        let (title, body) = dialog_text(&ctx);
        assert_eq!(title, "Codex이(가) 컴퓨터를 조작하려고 합니다");
        assert!(body.contains("작업 공간: 개인"));
        assert!(body.contains("세션: 메모 정리"), "control characters are flattened: {body}");
        assert!(body.contains(&format!("첫 동작: {}…", "x".repeat(120))));
        assert!(body.contains("요청한 쪽이 보낸 내용"));
        let (unknown, empty) = dialog_text(&RequestContext::default());
        assert!(unknown.starts_with("에이전트"));
        assert!(empty.contains("세션: -"));
    }

    #[test]
    fn authorize_asks_natively_and_only_the_answer_grants() {
        let ctx = RequestContext::default();
        assert_eq!(authorize("k-status", "status", &ctx, |_| panic!("status never asks")), Ok(None));
        assert!(authorize("", "click", &ctx, |_| Decision::Session).is_err());
        assert!(authorize("k-deny", "click", &ctx, |_| Decision::Deny).unwrap_err().starts_with(DENIED));
        assert!(authorize("k-deny", "click", &ctx, |_| panic!("a denial does not ask again")).unwrap_err().starts_with(DENIED));
        assert!(authorize("k-late", "click", &ctx, |_| Decision::Timeout).unwrap_err().starts_with(APPROVAL_TIMEOUT));
        assert_eq!(authorize("k-once", "click", &ctx, |_| Decision::Once), Ok(Some("once")));
        let mut asked = false;
        assert_eq!(authorize("k-once", "click", &ctx, |_| { asked = true; Decision::Deny }).map(|_| ()).is_err(), true);
        assert!(asked, "once covers a single action");
        assert_eq!(authorize("k-session", "click", &ctx, |_| Decision::Session), Ok(Some("session")));
        assert_eq!(authorize("k-session", "type", &ctx, |_| panic!("session grant is remembered")), Ok(None));
        STOPPED.store(true, Ordering::SeqCst);
        with_grants(|g| g.session.clear());
        assert_eq!(authorize("k-session", "click", &ctx, |_| Decision::Session), Ok(Some("session")), "after a stop the user is asked again");
        assert!(!STOPPED.load(Ordering::SeqCst), "a fresh approval re-arms");
    }
    /// Native smoke test (needs a logged-in GUI session; TCC is attributed to the calling terminal).
    /// `SINAWI_CU_SMOKE_DIR=/some/sinawi-computer cargo test native_smoke -- --ignored --nocapture`
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn native_smoke() {
        let dir = std::env::var("SINAWI_CU_SMOKE_DIR").unwrap_or_else(|_| std::env::temp_dir().join("sinawi-computer").to_string_lossy().into());
        std::fs::create_dir_all(&dir).unwrap();
        let status = run("status", &json!({})).unwrap();
        println!("status: {status}");
        println!("apps: {}", run("apps", &json!({})).unwrap());
        println!("cursor: {}", run("cursor", &json!({})).unwrap());
        if status["screen"] == "granted" {
            let out = format!("{dir}/smoke-display.png");
            println!("screencapturekit: {}", sck::available());
            println!("screenshot: {}", run("screenshot", &json!({ "out": out, "max": 1280 })).unwrap());
            println!("region: {}", run("screenshot", &json!({ "out": format!("{dir}/smoke-region.png"), "region": { "x": 0, "y": 0, "w": 400, "h": 300 } })).unwrap());
            let front = native::windows(true).into_iter().find(|w| w.layer == 0 && w.bounds.w > 100.0);
            if let Some(w) = front {
                println!("window {} ({}): {}", w.id, w.app, run("screenshot", &json!({ "out": format!("{dir}/smoke-window.png"), "window": w.id })).unwrap());
            }
            println!("windows: {}", run("windows", &json!({})).unwrap()["windows"].as_array().map(|a| a.len()).unwrap_or(0));
        } else {
            println!("screen recording not granted to this process: {}", run("screenshot", &json!({ "out": format!("{dir}/x.png") })).unwrap_err());
        }
        if status["accessibility"] == "granted" {
            let ax = run("ax", &json!({ "max": 40 })).unwrap();
            println!("ax ({} nodes):\n{}", ax["count"], ax["tree"].as_str().unwrap_or(""));
            println!("secure input active: {}", ax::secure_input_active());
        } else {
            println!("accessibility not granted: {}", run("click", &json!({ "x": 1, "y": 1 })).unwrap_err());
        }
    }
}
