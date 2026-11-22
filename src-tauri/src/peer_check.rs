//! Who is on the other end of the app window's key socket (server/app-key.ts).
//!
//! The server runs this binary as `sinawi --sinawi-check-peer` with the accepted connection as fd 3 and
//! hands the key over only on exit 0. The answer comes from the kernel and the code signature, not from
//! anything the peer controls:
//! - `LOCAL_PEERTOKEN` is the peer's audit token from the kernel, not something the peer says.
//! - The Security framework looks that process up by its token and checks its running code against
//!   this binary's own designated requirement: the same signed app (its identifier and signing team, or
//!   for an ad-hoc build its exact code hash). argv[0], the process name and the path it claims play no
//!   part, and a modified app binary fails its signature.
//!
//! Known gap (tested below, README "App window key"): a process can connect, keep a copy of the socket
//! in a second process, and then exec the real app binary. The token then names a process that really
//! is the app, the check passes, and the copy reads the key. Closing that needs the agents' processes
//! kept away from this socket (a sandbox), not a better check here.
use std::os::raw::{c_int, c_void};
use std::ptr;

use core_foundation::base::{CFRelease, TCFType};
use core_foundation::data::CFData;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};

pub const FLAG: &str = "--sinawi-check-peer";
const SOL_LOCAL: c_int = 0;
const LOCAL_PEERTOKEN: c_int = 0x006;

#[link(name = "Security", kind = "framework")]
extern "C" {
    static kSecGuestAttributeAudit: CFStringRef;
    fn SecCodeCopySelf(flags: u32, me: *mut *const c_void) -> i32;
    fn SecCodeCopyStaticCode(code: *const c_void, flags: u32, out: *mut *const c_void) -> i32;
    fn SecCodeCopyDesignatedRequirement(code: *const c_void, flags: u32, out: *mut *const c_void) -> i32;
    fn SecCodeCopyGuestWithAttributes(host: *const c_void, attributes: *const c_void, flags: u32, guest: *mut *const c_void) -> i32;
    fn SecCodeCheckValidity(code: *const c_void, flags: u32, requirement: *const c_void) -> i32;
}

extern "C" {
    fn getsockopt(fd: c_int, level: c_int, name: c_int, value: *mut c_void, len: *mut u32) -> c_int;
}

/// A Core Foundation object this code owns.
struct Owned(*const c_void);
impl Drop for Owned {
    fn drop(&mut self) { if !self.0.is_null() { unsafe { CFRelease(self.0) } } }
}

fn copy(call: impl FnOnce(*mut *const c_void) -> i32) -> Option<Owned> {
    let mut out: *const c_void = ptr::null();
    let status = call(&mut out);
    let owned = Owned(out);
    (status == 0 && !owned.0.is_null()).then_some(owned)
}

/// The audit token the kernel recorded for the peer of a connected unix socket.
fn peer_token(fd: c_int) -> Option<[u8; 32]> {
    let mut token = [0u8; 32];
    let mut len = token.len() as u32;
    let status = unsafe { getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, token.as_mut_ptr().cast(), &mut len) };
    (status == 0 && len as usize == token.len()).then_some(token)
}

/// Whether the process that connected on `fd` runs this same signed app.
pub fn peer_is_this_app(fd: c_int) -> bool {
    let Some(token) = peer_token(fd) else { return false };
    let Some(me) = copy(|out| unsafe { SecCodeCopySelf(0, out) }) else { return false };
    let Some(on_disk) = copy(|out| unsafe { SecCodeCopyStaticCode(me.0, 0, out) }) else { return false };
    let Some(requirement) = copy(|out| unsafe { SecCodeCopyDesignatedRequirement(on_disk.0, 0, out) }) else { return false };
    let key = unsafe { CFString::wrap_under_get_rule(kSecGuestAttributeAudit) };
    let attributes = CFDictionary::from_CFType_pairs(&[(key, CFData::from_buffer(&token))]);
    let Some(peer) = copy(|out| unsafe { SecCodeCopyGuestWithAttributes(ptr::null(), attributes.as_concrete_TypeRef().cast(), 0, out) }) else { return false };
    unsafe { SecCodeCheckValidity(peer.0, 0, requirement.0) == 0 }
}

/// `sinawi --sinawi-check-peer`: exit 0 only when fd 3's peer is this app.
pub fn run() -> i32 { if peer_is_this_app(3) { 0 } else { 1 } }

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::io::AsRawFd;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::process::{Command, Stdio};
    use std::time::Duration;

    fn socket_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("sk-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("s")
    }

    #[test]
    fn the_same_binary_passes() {
        let (ours, _theirs) = UnixStream::pair().unwrap();
        assert!(peer_is_this_app(ours.as_raw_fd()), "the peer is this very process");
    }

    /// The independent review's attack: another program started with argv[0] set to the app's path.
    #[test]
    fn a_program_posing_as_this_binary_fails() {
        let path = socket_path("argv0");
        let listener = UnixListener::bind(&path).unwrap();
        let exe = std::env::current_exe().unwrap();
        let mut child = Command::new("/bin/bash")
            .args(["-c", "exec -a \"$0\" /usr/bin/nc -U \"$1\"", &exe.to_string_lossy(), &path.to_string_lossy()])
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let (connection, _) = listener.accept().unwrap();
        let verdict = peer_is_this_app(connection.as_raw_fd());
        let _ = child.kill();
        let _ = child.wait();
        assert!(!verdict);
    }

    /// Kept alive by the exec test below: the process it execs into is this test binary.
    #[test]
    fn exec_target_waits() {
        if std::env::var_os("SINAWI_PEER_EXEC_TARGET").is_some() { std::thread::sleep(Duration::from_secs(4)); }
    }

    /// The other race the review named: connect first, then exec the real app binary. This is a known,
    /// documented gap: the process the token names really is the app by then. The test pins that down,
    /// so whoever closes the gap (or a macOS that changes it) flips this assertion on purpose.
    #[test]
    fn connecting_then_exec_ing_the_app_is_a_known_gap() {
        let path = socket_path("exec");
        let listener = UnixListener::bind(&path).unwrap();
        let exe = std::env::current_exe().unwrap();
        // perl: keep the socket across exec ($^F) and exec this binary, which stays alive in exec_target_waits.
        let script = r#"use Socket; $^F = 100; socket(S, PF_UNIX, SOCK_STREAM, 0) or die; connect(S, pack_sockaddr_un($ARGV[0])) or die; $ENV{SINAWI_PEER_EXEC_TARGET} = 1; exec { $ARGV[1] } $ARGV[1], "--exact", "peer_check::tests::exec_target_waits", "--test-threads=1";"#;
        let mut child = Command::new("/usr/bin/perl").args(["-e", script, &path.to_string_lossy(), &exe.to_string_lossy()])
            .stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let (connection, _) = listener.accept().unwrap();
        // Let the exec happen, then check while the exec'd app is still running.
        std::thread::sleep(Duration::from_millis(1500));
        let alive = child.try_wait().unwrap().is_none();
        let verdict = peer_is_this_app(connection.as_raw_fd());
        let _ = child.kill();
        let _ = child.wait();
        assert!(alive, "the exec'd process is still running during the check");
        assert!(verdict, "known gap: the exec'd app passes the check (README, App window key)");
    }
}
