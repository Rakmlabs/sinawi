//! The Node server runs as a per-user launchd LaunchAgent from a stable copy outside the .app,
//! so quitting or replacing the app never stops running sessions. Server code updates are
//! applied only while no session is running.
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub const LABEL: &str = "dev.sinawi.server";
/// Pre-rename ("Agent Orchestra") identifiers, used only to migrate an existing install.
pub const LEGACY_LABEL: &str = "kr.rakm.agentorchestra.server";
pub const LEGACY_BUNDLE_ID: &str = "kr.rakm.agentorchestra";
const ADDRESS: &str = "127.0.0.1:3001";

pub struct Layout {
    pub resources: PathBuf,
    pub server_dir: PathBuf,
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
    pub plist: PathBuf,
    /// ~/Library/Application Support/kr.rakm.agentorchestra (holds the old `.data`).
    pub legacy_app_dir: PathBuf,
    /// ~/Library/Logs/Agent Orchestra
    pub legacy_log_dir: PathBuf,
    /// ~/Library/LaunchAgents/kr.rakm.agentorchestra.server.plist
    pub legacy_plist: PathBuf,
}

fn uid() -> String {
    Command::new("/usr/bin/id").arg("-u").output().ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "501".into())
}
fn domain() -> String { format!("gui/{}", uid()) }
fn target() -> String { format!("{}/{LABEL}", domain()) }
fn legacy_target() -> String { format!("{}/{LEGACY_LABEL}", domain()) }

/// True for a health body from this server, or from a pre-rename server during an upgrade.
pub fn is_our_app(body: &str) -> bool {
    body.contains("\"app\":\"sinawi\"") || body.contains("\"app\":\"agent-orchestra\"")
}

/// Raw /api/health body, if our server answers.
pub fn health_body() -> Option<String> {
    let address = ADDRESS.to_socket_addrs().ok()?.next()?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(300)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    stream.write_all(format!("GET /api/health HTTP/1.1\r\nHost: {ADDRESS}\r\nConnection: close\r\n\r\n").as_bytes()).ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    let (headers, body) = response.split_once("\r\n\r\n")?;
    (headers.starts_with("HTTP/1.1 200") && is_our_app(body)).then(|| body.to_string())
}

fn running_sessions(body: &str) -> Option<u64> {
    let rest = body.split("\"running\":").nth(1)?;
    rest.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

fn hash_file(hasher: &mut DefaultHasher, path: &Path) {
    if let Ok(bytes) = fs::read(path) { bytes.hash(hasher); }
}

pub fn bundled_version(layout: &Layout) -> String {
    let mut hasher = DefaultHasher::new();
    env!("CARGO_PKG_VERSION").hash(&mut hasher);
    hash_file(&mut hasher, &layout.resources.join("server.cjs"));
    hash_file(&mut hasher, &layout.resources.join("dist/index.html"));
    format!("{:016x}", hasher.finish())
}

pub fn installed_version(layout: &Layout) -> String {
    fs::read_to_string(layout.server_dir.join("VERSION")).unwrap_or_default().trim().to_string()
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() { copy_dir(&entry.path(), &dest)?; } else { fs::copy(entry.path(), dest)?; }
    }
    Ok(())
}

/// Copy server.cjs, dist and node_modules into a staging dir next to the stable dir. The running
/// server is untouched, so a failed copy never affects it.
fn stage_files(layout: &Layout, version: &str) -> std::io::Result<PathBuf> {
    let staging = layout.server_dir.with_extension("staging");
    let _ = fs::remove_dir_all(&staging);
    let result = (|| {
        fs::create_dir_all(&staging)?;
        fs::copy(layout.resources.join("server.cjs"), staging.join("server.cjs"))?;
        copy_dir(&layout.resources.join("dist"), &staging.join("dist"))?;
        let modules = layout.resources.join("node_modules");
        if modules.is_dir() { copy_dir(&modules, &staging.join("node_modules"))?; }
        fs::write(staging.join("VERSION"), version)
    })();
    if result.is_err() { let _ = fs::remove_dir_all(&staging); }
    result.map(|_| staging)
}

fn previous_dir(layout: &Layout) -> PathBuf { layout.server_dir.with_extension("old") }

/// Swap a staged copy in. The previous copy is kept as `server.old` until the new server is
/// verified (`discard_previous`) or rolled back (`restore_previous`).
fn swap_in(layout: &Layout, staging: &Path) -> std::io::Result<()> {
    let old = previous_dir(layout);
    let _ = fs::remove_dir_all(&old);
    if layout.server_dir.exists() { fs::rename(&layout.server_dir, &old)?; }
    if let Err(error) = fs::rename(staging, &layout.server_dir) {
        if old.exists() { let _ = fs::rename(&old, &layout.server_dir); }
        return Err(error);
    }
    Ok(())
}

/// Put the previous copy back. Returns false when there is none (nothing was swapped).
fn restore_previous(layout: &Layout) -> bool {
    let old = previous_dir(layout);
    if !old.is_dir() { return false; }
    let failed = layout.server_dir.with_extension("failed");
    let _ = fs::remove_dir_all(&failed);
    if layout.server_dir.exists() && fs::rename(&layout.server_dir, &failed).is_err() { return false; }
    let restored = fs::rename(&old, &layout.server_dir).is_ok();
    let _ = fs::remove_dir_all(&failed);
    restored
}

fn discard_previous(layout: &Layout) { let _ = fs::remove_dir_all(previous_dir(layout)); }

/// Fresh install (no server running): stage, swap, drop the previous copy.
fn install_files(layout: &Layout, version: &str) -> std::io::Result<()> {
    let staging = stage_files(layout, version)?;
    swap_in(layout, &staging)?;
    discard_previous(layout);
    Ok(())
}

fn xml(text: &str) -> String { text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;") }

/// Resolve (node binary, PATH) once from the user's login shell, so launchd can start node directly
/// without a login shell on every (re)start. Falls back to common install locations.
fn resolve_node_env() -> (String, String) {
    let mut shell_out = String::new();
    if let Ok(mut child) = Command::new("/bin/zsh").args(["-lc", "printf '__AO_PATH__%s\\n__AO_NODE__%s\\n' \"$PATH\" \"$(command -v node)\""])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
    {
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if started.elapsed() < Duration::from_secs(8) => thread::sleep(Duration::from_millis(50)),
                _ => { let _ = child.kill(); break; }
            }
        }
        if let Some(mut out) = child.stdout.take() { let _ = out.read_to_string(&mut shell_out); }
        let _ = child.wait();
    }
    let field = |tag: &str| shell_out.lines().find_map(|l| l.strip_prefix(tag)).unwrap_or("").trim().to_string();
    let mut dirs: Vec<String> = field("__AO_PATH__").split(':').filter(|d| !d.is_empty()).map(String::from).collect();
    let home = std::env::var("HOME").unwrap_or_default();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(String::from)
        .into_iter().chain([format!("{home}/.local/bin"), format!("{home}/.bun/bin")])
    {
        if !dirs.contains(&extra) { dirs.push(extra); }
    }
    let path = dirs.join(":");
    let mut node = field("__AO_NODE__");
    if !Path::new(&node).is_file() {
        node = dirs.iter().map(|d| format!("{d}/node")).find(|c| Path::new(c).is_file()).unwrap_or_else(|| "/usr/local/bin/node".into());
    }
    (node, path)
}

/// True when the installed plist predates the direct-node launch (still goes through a login shell).
fn plist_outdated(layout: &Layout) -> bool {
    fs::read_to_string(&layout.plist).map(|c| c.contains("/bin/zsh") || !c.contains("<key>PATH</key>") || !c.contains("<key>SINAWI_PORT</key>")).unwrap_or(true)
}

fn write_plist(layout: &Layout, version: &str) -> std::io::Result<()> {
    let (node, path_env) = resolve_node_env();
    fs::create_dir_all(&layout.log_dir)?;
    fs::create_dir_all(&layout.data_dir)?;
    if let Some(parent) = layout.plist.parent() { fs::create_dir_all(parent)?; }
    let s = |p: &Path| xml(&p.to_string_lossy());
    let log = s(&layout.log_dir.join("server.log"));
    let plist = format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{node}</string><string>{server}</string><string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>{path_env}</string>
    <key>HOME</key><string>{home}</string>
    <key>SINAWI_PORT</key><string>3001</string>
    <key>SINAWI_STATIC_DIR</key><string>{dist}</string>
    <key>SINAWI_DATA_DIR</key><string>{data}</string>
    <key>SINAWI_SERVER_VERSION</key><string>{version}</string>
  </dict>
  <key>WorkingDirectory</key><string>{cwd}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#,
        server = s(&layout.server_dir.join("server.cjs")), dist = s(&layout.server_dir.join("dist")),
        data = s(&layout.data_dir), cwd = s(&layout.server_dir), version = xml(version),
        node = xml(&node), path_env = xml(&path_env), home = xml(&std::env::var("HOME").unwrap_or_default()));
    fs::write(&layout.plist, plist)
}

fn loaded(target: &str) -> bool {
    Command::new("/bin/launchctl").args(["print", target]).output().map(|o| o.status.success()).unwrap_or(false)
}
fn is_loaded() -> bool { loaded(&target()) }

fn bootstrap(layout: &Layout) {
    let _ = Command::new("/bin/launchctl").args(["bootstrap", &domain(), &layout.plist.to_string_lossy()]).status();
}

fn bootout_target(target: &str) {
    let _ = Command::new("/bin/launchctl").args(["bootout", target]).status();
    for _ in 0..50 { if !loaded(target) { break; } thread::sleep(Duration::from_millis(100)); }
}
fn bootout() { bootout_target(&target()); }

fn log(message: &str) {
    if let Some(home) = std::env::var_os("HOME") {
        let dir = Path::new(&home).join("Library/Logs/Sinawi");
        let _ = fs::create_dir_all(&dir);
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(dir.join("agent.log")) { let _ = writeln!(file, "{message}"); }
    }
}

fn is_empty_dir(path: &Path) -> bool {
    fs::read_dir(path).map(|mut entries| entries.next().is_none()).unwrap_or(false)
}

/// Rename `from` to `to` when `to` is absent (or an empty dir). Never overwrites existing content.
pub fn move_legacy_dir(from: &Path, to: &Path, what: &str) -> Option<String> {
    if !from.is_dir() { return None; }
    if to.exists() && !is_empty_dir(to) {
        return Some(format!("migration: {what} left in place at {} ({} already exists)", from.display(), to.display()));
    }
    if to.exists() { let _ = fs::remove_dir(to); }
    if let Some(parent) = to.parent() { let _ = fs::create_dir_all(parent); }
    Some(match fs::rename(from, to) {
        Ok(()) => format!("migration: moved {what} {} -> {}", from.display(), to.display()),
        Err(error) => format!("migration: failed to move {what} {} -> {}: {error}", from.display(), to.display()),
    })
}

/// One-time upgrade from the pre-rename "Agent Orchestra" install: stop and remove its LaunchAgent,
/// then move its data and logs to the Sinawi locations. Idempotent; safe to call on every launch.
fn migrate_legacy(layout: &Layout) {
    let mut notes = Vec::new();
    if loaded(&legacy_target()) {
        bootout_target(&legacy_target());
        notes.push(format!("migration: booted out {LEGACY_LABEL}"));
    }
    if layout.legacy_plist.exists() {
        notes.push(match fs::remove_file(&layout.legacy_plist) {
            Ok(()) => format!("migration: removed {}", layout.legacy_plist.display()),
            Err(error) => format!("migration: failed to remove {}: {error}", layout.legacy_plist.display()),
        });
    }
    // Logs first: log() below creates the new log dir, which would block this move.
    notes.extend(move_legacy_dir(&layout.legacy_log_dir, &layout.log_dir, "logs"));
    let legacy_data = layout.legacy_app_dir.join(".data");
    if let Some(note) = move_legacy_dir(&legacy_data, &layout.data_dir, "data") {
        if !legacy_data.exists() {
            let _ = fs::write(layout.legacy_app_dir.join("MOVED_TO_SINAWI.txt"), format!("Data moved to {}\n", layout.data_dir.display()));
            // The old installed server copy is regenerated from the bundle; only user data mattered.
            let _ = fs::remove_dir_all(layout.legacy_app_dir.join("server"));
        }
        notes.push(note);
    }
    for note in notes { log(&note); }
}

/// Install the bundled server (when needed), write the plist and bootstrap the LaunchAgent.
fn install_and_start(layout: &Layout, version: &str) -> Result<(), String> {
    if installed_version(layout) != version || !layout.server_dir.join("server.cjs").is_file() {
        install_files(layout, version).map_err(|e| format!("server install failed: {e}"))?;
    }
    write_plist(layout, &installed_version(layout)).map_err(|e| format!("plist write failed: {e}"))?;
    bootstrap(layout);
    log(&format!("bootstrapped {LABEL} version {}", installed_version(layout)));
    Ok(())
}

/// Make sure the LaunchAgent exists and runs; schedule a deferred update when the bundle is newer.
pub fn ensure(layout: Layout) -> Result<(), String> {
    let version = bundled_version(&layout);
    if loaded(&legacy_target()) {
        // A pre-rename server still owns port 3001. If it has running sessions, keep using it
        // (its health is accepted) and switch over once it is idle, so no session is cut.
        if let Some(running) = health_body().as_deref().and_then(running_sessions).filter(|n| *n > 0) {
            log(&format!("migration deferred: {LEGACY_LABEL} has {running} running sessions"));
            thread::spawn(move || {
                while let Some(running) = health_body().as_deref().and_then(running_sessions).filter(|n| *n > 0) {
                    log(&format!("migration deferred (running sessions: {running})"));
                    thread::sleep(Duration::from_secs(20));
                }
                migrate_legacy(&layout);
                if let Err(error) = install_and_start(&layout, &version) { log(&error); }
            });
            return Ok(());
        }
    }
    migrate_legacy(&layout);
    if !is_loaded() { return install_and_start(&layout, &version); }
    if installed_version(&layout) == version && !plist_outdated(&layout) { return Ok(()); }
    // Newer server bundled: swap only while idle, so running sessions are never cut.
    thread::spawn(move || loop {
        match health_body().as_deref().and_then(running_sessions) {
            Some(0) => {
                if update_installed_server(&layout, &version) { return; }
            }
            other => log(&format!("server update deferred (running sessions: {other:?})")),
        }
        thread::sleep(Duration::from_secs(20));
    });
    Ok(())
}

/// True once our server answers with `version` (the plist's SINAWI_SERVER_VERSION).
fn wait_for_version(version: &str, timeout: Duration) -> bool {
    let started = Instant::now();
    let needle = format!("\"version\":\"{version}\"");
    while started.elapsed() < timeout {
        if health_body().is_some_and(|body| body.contains(&needle)) { return true; }
        thread::sleep(Duration::from_millis(500));
    }
    false
}

/// Swap the installed server for the bundled one while idle. Returns false to retry later (a session
/// started while staging). On any failure the previous server is restored and restarted.
fn update_installed_server(layout: &Layout, version: &str) -> bool {
    let previous = installed_version(layout);
    // Stage while the old server still runs, so the downtime is only the rename + restart.
    let staged = if previous == version { None } else {
        match stage_files(layout, version) {
            Ok(dir) => Some(dir),
            Err(error) => {
                log(&format!("server update to {version} failed while staging, keeping {previous}: {error}"));
                return true;
            }
        }
    };
    if health_body().as_deref().and_then(running_sessions) != Some(0) {
        if let Some(dir) = &staged { let _ = fs::remove_dir_all(dir); }
        return false;
    }
    bootout();
    let result = match &staged { Some(dir) => swap_in(layout, dir), None => Ok(()) }
        .and_then(|_| write_plist(layout, version));
    bootstrap(layout);
    if result.is_ok() && wait_for_version(version, Duration::from_secs(45)) {
        discard_previous(layout);
        log(&format!("updated server {previous} -> {version}"));
        return true;
    }
    log(&format!("server update to {version} failed ({result:?}); rolling back to {previous}"));
    bootout();
    let restored = staged.is_some() && restore_previous(layout);
    let plist = write_plist(layout, &installed_version(layout));
    bootstrap(layout);
    log(&format!("rollback: restored files={restored}, plist={plist:?}, running version {}", installed_version(layout)));
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sinawi-migrate-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn moves_legacy_dir_when_target_is_absent_or_empty() {
        let root = temp("move");
        let (old, new) = (root.join("old/.data"), root.join("new/.data"));
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("sessions.json"), "[]").unwrap();
        assert!(move_legacy_dir(&old, &new, "data").unwrap().contains("moved"));
        assert_eq!(fs::read_to_string(new.join("sessions.json")).unwrap(), "[]");
        assert!(!old.exists());
        assert!(move_legacy_dir(&old, &new, "data").is_none());

        let (old2, empty) = (root.join("old2"), root.join("empty"));
        fs::create_dir_all(&old2).unwrap();
        fs::write(old2.join("a"), "1").unwrap();
        fs::create_dir_all(&empty).unwrap();
        assert!(move_legacy_dir(&old2, &empty, "logs").unwrap().contains("moved"));
        assert!(empty.join("a").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn never_overwrites_existing_target() {
        let root = temp("keep");
        let (old, new) = (root.join("old"), root.join("new"));
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(old.join("x"), "old").unwrap();
        fs::write(new.join("x"), "new").unwrap();
        assert!(move_legacy_dir(&old, &new, "data").unwrap().contains("left in place"));
        assert_eq!(fs::read_to_string(new.join("x")).unwrap(), "new");
        assert_eq!(fs::read_to_string(old.join("x")).unwrap(), "old");
        let _ = fs::remove_dir_all(&root);
    }

    fn layout_in(root: &Path) -> Layout {
        Layout {
            resources: root.join("resources"), server_dir: root.join("server"), data_dir: root.join(".data"),
            log_dir: root.join("logs"), plist: root.join("agent.plist"), legacy_app_dir: root.join("legacy"),
            legacy_log_dir: root.join("legacy-logs"), legacy_plist: root.join("legacy.plist"),
        }
    }

    fn write_resources(layout: &Layout, marker: &str) {
        fs::create_dir_all(layout.resources.join("dist")).unwrap();
        fs::write(layout.resources.join("server.cjs"), marker).unwrap();
        fs::write(layout.resources.join("dist/index.html"), marker).unwrap();
    }

    #[test]
    fn swap_keeps_previous_until_verified_and_rolls_back() {
        let root = temp("swap");
        let layout = layout_in(&root);
        write_resources(&layout, "v1");
        install_files(&layout, "one").unwrap();
        assert_eq!(installed_version(&layout), "one");
        assert!(!previous_dir(&layout).exists());

        write_resources(&layout, "v2");
        let staging = stage_files(&layout, "two").unwrap();
        assert_eq!(installed_version(&layout), "one", "staging must not touch the running copy");
        swap_in(&layout, &staging).unwrap();
        assert_eq!(installed_version(&layout), "two");
        assert!(restore_previous(&layout));
        assert_eq!(installed_version(&layout), "one");
        assert_eq!(fs::read_to_string(layout.server_dir.join("server.cjs")).unwrap(), "v1");
        assert!(!restore_previous(&layout), "nothing left to restore");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn failed_staging_leaves_installed_server_alone() {
        let root = temp("stage-fail");
        let layout = layout_in(&root);
        write_resources(&layout, "v1");
        install_files(&layout, "one").unwrap();
        fs::remove_file(layout.resources.join("server.cjs")).unwrap();
        assert!(stage_files(&layout, "two").is_err());
        assert!(!layout.server_dir.with_extension("staging").exists());
        assert_eq!(installed_version(&layout), "one");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn accepts_renamed_and_pre_rename_health() {
        assert!(is_our_app(r#"{"ok":true,"app":"sinawi"}"#));
        assert!(is_our_app(r#"{"ok":true,"app":"agent-orchestra"}"#));
        assert!(!is_our_app(r#"{"ok":true,"app":"other"}"#));
    }
}
