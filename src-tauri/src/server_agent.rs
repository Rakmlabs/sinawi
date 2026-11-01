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

pub const LABEL: &str = "kr.rakm.agentorchestra.server";
const ADDRESS: &str = "127.0.0.1:3001";

pub struct Layout {
    pub resources: PathBuf,
    pub server_dir: PathBuf,
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
    pub plist: PathBuf,
}

fn uid() -> String {
    Command::new("/usr/bin/id").arg("-u").output().ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "501".into())
}
fn domain() -> String { format!("gui/{}", uid()) }
fn target() -> String { format!("{}/{LABEL}", domain()) }

/// Raw /api/health body, if our server answers.
pub fn health_body() -> Option<String> {
    let address = ADDRESS.to_socket_addrs().ok()?.next()?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(300)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    stream.write_all(format!("GET /api/health HTTP/1.1\r\nHost: {ADDRESS}\r\nConnection: close\r\n\r\n").as_bytes()).ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    let (headers, body) = response.split_once("\r\n\r\n")?;
    (headers.starts_with("HTTP/1.1 200") && body.contains("\"app\":\"agent-orchestra\"")).then(|| body.to_string())
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

fn installed_version(layout: &Layout) -> String {
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

/// Copy server.cjs, dist and node_modules into the stable dir (staged, then swapped).
fn install_files(layout: &Layout, version: &str) -> std::io::Result<()> {
    let staging = layout.server_dir.with_extension("staging");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)?;
    fs::copy(layout.resources.join("server.cjs"), staging.join("server.cjs"))?;
    copy_dir(&layout.resources.join("dist"), &staging.join("dist"))?;
    let modules = layout.resources.join("node_modules");
    if modules.is_dir() { copy_dir(&modules, &staging.join("node_modules"))?; }
    fs::write(staging.join("VERSION"), version)?;
    let old = layout.server_dir.with_extension("old");
    let _ = fs::remove_dir_all(&old);
    if layout.server_dir.exists() { fs::rename(&layout.server_dir, &old)?; }
    fs::rename(&staging, &layout.server_dir)?;
    let _ = fs::remove_dir_all(&old);
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
    fs::read_to_string(&layout.plist).map(|c| c.contains("/bin/zsh") || !c.contains("<key>PATH</key>")).unwrap_or(true)
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
    <key>AGENT_ORCHESTRA_PORT</key><string>3001</string>
    <key>AGENT_ORCHESTRA_STATIC_DIR</key><string>{dist}</string>
    <key>AGENT_ORCHESTRA_DATA_DIR</key><string>{data}</string>
    <key>AGENT_ORCHESTRA_SERVER_VERSION</key><string>{version}</string>
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

fn is_loaded() -> bool {
    Command::new("/bin/launchctl").args(["print", &target()]).output().map(|o| o.status.success()).unwrap_or(false)
}

fn bootstrap(layout: &Layout) {
    let _ = Command::new("/bin/launchctl").args(["bootstrap", &domain(), &layout.plist.to_string_lossy()]).status();
}

fn bootout() {
    let _ = Command::new("/bin/launchctl").args(["bootout", &target()]).status();
    for _ in 0..50 { if !is_loaded() { break; } thread::sleep(Duration::from_millis(100)); }
}

fn log(message: &str) {
    if let Some(home) = std::env::var_os("HOME") {
        let path = Path::new(&home).join("Library/Logs/Agent Orchestra/agent.log");
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) { let _ = writeln!(file, "{message}"); }
    }
}

/// Make sure the LaunchAgent exists and runs; schedule a deferred update when the bundle is newer.
pub fn ensure(layout: Layout) -> Result<(), String> {
    let version = bundled_version(&layout);
    if !is_loaded() {
        if installed_version(&layout) != version || !layout.server_dir.join("server.cjs").is_file() {
            install_files(&layout, &version).map_err(|e| format!("server install failed: {e}"))?;
        }
        write_plist(&layout, &installed_version(&layout)).map_err(|e| format!("plist write failed: {e}"))?;
        bootstrap(&layout);
        log(&format!("bootstrapped {LABEL} version {}", installed_version(&layout)));
        return Ok(());
    }
    if installed_version(&layout) == version && !plist_outdated(&layout) { return Ok(()); }
    // Newer server bundled: swap only while idle, so running sessions are never cut.
    thread::spawn(move || loop {
        match health_body().as_deref().and_then(running_sessions) {
            Some(0) => {
                bootout();
                let result = (if installed_version(&layout) == version { Ok(()) } else { install_files(&layout, &version) })
                    .and_then(|_| write_plist(&layout, &version));
                bootstrap(&layout);
                log(&format!("updated server to {version}: {result:?}"));
                return;
            }
            other => log(&format!("server update deferred (running sessions: {other:?})")),
        }
        thread::sleep(Duration::from_secs(20));
    });
    Ok(())
}
