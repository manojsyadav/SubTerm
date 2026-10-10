//! Embedded RDP sessions.
//!
//! The RDP protocol work runs in a separate helper executable
//! (`src-tauri/rdp-helper`, its own crate and lockfile: IronRDP pins crypto crates
//! that cannot share a dependency graph with the SSH stack). This module starts
//! one helper per session, relays its screen updates to the front end over a raw
//! binary channel, and forwards input bytes the other way.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::{Channel, InvokeResponseBody};

use crate::DbState;

type EventChannel = Channel<InvokeResponseBody>;

struct RdpSession {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
}

#[derive(Default)]
pub struct RdpSessions(Mutex<HashMap<String, RdpSession>>);

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

const HELPER_NAME: &str = if cfg!(windows) { "subterm-rdp-helper.exe" } else { "subterm-rdp-helper" };

/// Where to look for the helper: next to the app first (installed/portable builds),
/// then the helper crate's own build output (development).
fn helper_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join(HELPER_NAME));
            out.push(dir.join("resources").join(HELPER_NAME));
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("rdp-helper").join("target");
    out.push(dev.join("release").join(HELPER_NAME));
    out.push(dev.join("debug").join(HELPER_NAME));
    out
}

fn find_helper() -> Result<PathBuf, String> {
    helper_candidates()
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| format!("The RDP component ({HELPER_NAME}) was not found next to SubTerm. Reinstall or rebuild SubTerm."))
}

/// `DOMAIN\user` or `user@domain` -> (user, domain). Plain names have no domain.
pub(crate) fn split_domain_user(name: &str) -> (String, Option<String>) {
    let name = name.trim();
    if let Some((d, u)) = name.split_once('\\') {
        if !d.is_empty() && !u.is_empty() {
            return (u.to_string(), Some(d.to_string()));
        }
    }
    (name.to_string(), None)
}

/// One `[kind u8][len u32 LE][payload]` frame from the helper; `None` at end of stream.
pub(crate) fn read_frame(r: &mut impl Read) -> std::io::Result<Option<(u8, Vec<u8>)>> {
    let mut head = [0u8; 5];
    match r.read_exact(&mut head) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes([head[1], head[2], head[3], head[4]]) as usize;
    // Guard against a corrupt length (largest legitimate frame is one 8K screen).
    if len > 160 * 1024 * 1024 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "oversized frame"));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    Ok(Some((head[0], payload)))
}

const KIND_ERROR: u8 = 3;
const KIND_CLOSED: u8 = 4;

fn send(ch: &EventChannel, kind: u8, payload: &[u8]) -> bool {
    let mut bytes = Vec::with_capacity(1 + payload.len());
    bytes.push(kind);
    bytes.extend_from_slice(payload);
    ch.send(InvokeResponseBody::Raw(bytes)).is_ok()
}

/// Start a session for saved server `id`. `password` is used for this connection only.
/// Events arrive on `on_event` as raw bytes: first byte = kind (1 connected, 2 update,
/// 3 error, 4 closed), rest = payload (see rdp-helper/src/wire.rs).
#[tauri::command]
pub async fn rdp_connect(
    state: tauri::State<'_, DbState>,
    sessions: tauri::State<'_, RdpSessions>,
    id: i32,
    password: String,
    width: u32,
    height: u32,
    on_event: EventChannel,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let _ = (state, sessions, id, password, width, height, on_event);
        return Err("Embedded RDP is not available on Android.".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        let (host, port, username) = {
            let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
            let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
            conn.query_row(
                "SELECT s.host, s.port, COALESCE(NULLIF(c.username, ''), s.username, '') \
                 FROM servers s LEFT JOIN credentials c ON c.id = s.credential_id WHERE s.id = ?1",
                [id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)),
            )
            .map_err(|e| format!("[DATABASE] SERVER_NOT_FOUND: {e}"))?
        };
        let port = u16::try_from(port).ok().filter(|p| *p > 0).unwrap_or(3389);
        let (user, domain) = split_domain_user(&username);
        if user.is_empty() {
            return Err("Enter a user name for this server first (Edit server > Username).".into());
        }

        let helper = find_helper()?;
        let mut cmd = Command::new(helper);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().map_err(|e| format!("Could not start the RDP component: {e}"))?;
        let mut stdin = child.stdin.take().ok_or("no helper stdin")?;
        let mut stdout = child.stdout.take().ok_or("no helper stdout")?;
        let mut stderr = child.stderr.take().ok_or("no helper stderr")?;

        let request = serde_json::json!({
            "host": host, "port": port, "username": user, "password": password,
            "domain": domain, "width": width, "height": height,
        });
        writeln!(stdin, "{request}").and_then(|_| stdin.flush()).map_err(|e| format!("RDP component did not accept the request: {e}"))?;

        let session_id = format!("rdp-{}-{}", id, NEXT_SESSION.fetch_add(1, Ordering::Relaxed));
        let child = Arc::new(Mutex::new(child));
        sessions.0.lock().map_err(|_| "[STATE] LOCK_FAILED")?.insert(
            session_id.clone(),
            RdpSession { stdin: Arc::new(Mutex::new(stdin)), child: Arc::clone(&child) },
        );

        // Keep the tail of stderr for the "helper died" message.
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        {
            let tail = Arc::clone(&stderr_tail);
            std::thread::spawn(move || {
                let mut buf = String::new();
                let _ = stderr.read_to_string(&mut buf);
                let start = buf.len().saturating_sub(600);
                if let Ok(mut t) = tail.lock() {
                    *t = buf[buf.char_indices().map(|(i, _)| i).find(|i| *i >= start).unwrap_or(buf.len())..].to_string();
                }
            });
        }

        std::thread::spawn(move || {
            let mut saw_closed = false;
            loop {
                match read_frame(&mut stdout) {
                    Ok(Some((kind, payload))) => {
                        if kind == KIND_CLOSED {
                            saw_closed = true;
                        }
                        if !send(&on_event, kind, &payload) {
                            break; // front end is gone
                        }
                        if saw_closed {
                            break;
                        }
                    }
                    Ok(None) | Err(_) => break,
                }
            }
            if !saw_closed {
                // The helper ended without a goodbye (crash). Say why, if we can.
                let _ = child.lock().map(|mut c| c.wait());
                std::thread::sleep(std::time::Duration::from_millis(50));
                let tail = stderr_tail.lock().map(|t| t.clone()).unwrap_or_default();
                let msg = if tail.trim().is_empty() { "The RDP component stopped unexpectedly.".to_string() } else { format!("The RDP component stopped unexpectedly: {}", tail.trim()) };
                send(&on_event, KIND_ERROR, msg.as_bytes());
                send(&on_event, KIND_CLOSED, b"");
            }
        });

        Ok(session_id)
    }
}

/// Forward already-encoded input events (see rdp-helper/src/wire.rs) to a session.
#[tauri::command]
pub async fn rdp_send_input(sessions: tauri::State<'_, RdpSessions>, session_id: String, data: Vec<u8>) -> Result<(), String> {
    let stdin = {
        let map = sessions.0.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
        Arc::clone(&map.get(&session_id).ok_or("RDP session not found")?.stdin)
    };
    let mut w = stdin.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    w.write_all(&data).and_then(|_| w.flush()).map_err(|e| format!("RDP session closed: {e}"))
}

/// End a session: ask the helper to log off, then make sure the process is gone.
#[tauri::command]
pub async fn rdp_disconnect(sessions: tauri::State<'_, RdpSessions>, session_id: String) -> Result<(), String> {
    let session = sessions.0.lock().map_err(|_| "[STATE] LOCK_FAILED")?.remove(&session_id);
    let Some(session) = session else { return Ok(()) };
    if let Ok(mut w) = session.stdin.lock() {
        let _ = w.write_all(&[5]);
        let _ = w.flush();
    }
    let child = session.child;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(2));
        if let Ok(mut c) = child.lock() {
            if c.try_wait().ok().flatten().is_none() {
                let _ = c.kill();
            }
            let _ = c.wait();
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_domain_and_user() {
        assert_eq!(split_domain_user("CORP\\alice"), ("alice".into(), Some("CORP".into())));
        assert_eq!(split_domain_user("  bob "), ("bob".into(), None));
        assert_eq!(split_domain_user("\\x"), ("\\x".into(), None));
        assert_eq!(split_domain_user("alice@corp.local"), ("alice@corp.local".into(), None));
    }

    #[test]
    fn reads_frames_and_stops_at_end() {
        let mut bytes = vec![3, 2, 0, 0, 0, b'h', b'i', 4, 0, 0, 0, 0];
        let mut r = &bytes[..];
        assert_eq!(read_frame(&mut r).unwrap(), Some((3, b"hi".to_vec())));
        assert_eq!(read_frame(&mut r).unwrap(), Some((4, Vec::new())));
        assert_eq!(read_frame(&mut r).unwrap(), None);
        bytes.truncate(7); // second frame cut mid-header
        let mut r = &bytes[..];
        read_frame(&mut r).unwrap();
        assert_eq!(read_frame(&mut r).unwrap(), None);
    }

    #[test]
    fn rejects_an_absurd_length() {
        let mut r = &[2u8, 0xFF, 0xFF, 0xFF, 0xFF][..];
        assert!(read_frame(&mut r).is_err());
    }

    #[test]
    fn helper_lookup_checks_next_to_the_app_first() {
        let c = helper_candidates();
        assert!(c.len() >= 3);
        assert!(c.iter().all(|p| p.file_name().map(|n| n == HELPER_NAME).unwrap_or(false)));
    }
}
