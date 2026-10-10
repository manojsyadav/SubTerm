//! RDP launcher: opens the operating system's own Remote Desktop client for a
//! saved server. No password is written to the generated file - the client asks
//! for it (or uses its own credential store).

use crate::DbState;

/// Strip anything that could end the current `.rdp` line or smuggle in another
/// setting (the file format is one `key:type:value` per line).
fn clean(value: &str) -> String {
    value.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string()
}

/// Contents of the `.rdp` connection file for `host:port` and an optional user
/// (`DOMAIN\user` is passed through as typed).
pub(crate) fn build_rdp_file(host: &str, port: u16, username: &str) -> String {
    let host = clean(host);
    let user = clean(username);
    let mut out = String::new();
    out.push_str(&format!("full address:s:{host}:{port}\r\n"));
    if !user.is_empty() {
        out.push_str(&format!("username:s:{user}\r\n"));
    }
    // Windowed, negotiate NLA, share the clipboard, ask for credentials rather than guess.
    out.push_str("screen mode id:i:1\r\n");
    out.push_str("authentication level:i:2\r\n");
    out.push_str("enablecredsspsupport:i:1\r\n");
    out.push_str("redirectclipboard:i:1\r\n");
    out.push_str("prompt for credentials:i:1\r\n");
    out
}

/// Remove generated files left over from earlier launches (best effort).
fn sweep_old_files(dir: &std::path::Path) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(60 * 60);
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !(name.starts_with("subterm-rdp-") && name.ends_with(".rdp")) {
            continue;
        }
        if entry.metadata().and_then(|m| m.modified()).map(|t| t < cutoff).unwrap_or(false) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[tauri::command]
pub async fn launch_rdp(state: tauri::State<'_, DbState>, id: i32) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = (state, id);
        return Err("RDP launching is not available on phones and tablets.".into());
    }
    #[cfg(desktop)]
    {
        let (host, port, username) = {
            let conn_guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
            let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
            conn.query_row(
                "SELECT s.host, s.port, \
                        COALESCE(NULLIF(c.username, ''), s.username, '') \
                 FROM servers s LEFT JOIN credentials c ON c.id = s.credential_id \
                 WHERE s.id = ?1",
                [id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)),
            )
            .map_err(|e| format!("[DATABASE] SERVER_NOT_FOUND: {e}"))?
        };
        let host = clean(&host);
        if host.is_empty() {
            return Err("This server has no host address.".into());
        }
        let port = u16::try_from(port).ok().filter(|p| *p > 0).unwrap_or(3389);

        let dir = std::env::temp_dir();
        sweep_old_files(&dir);
        let path = dir.join(format!("subterm-rdp-{}-{}.rdp", std::process::id(), id));
        std::fs::write(&path, build_rdp_file(&host, port, &username))
            .map_err(|e| format!("Could not write the connection file: {e}"))?;

        spawn_client(&path, &host, port, &username)
    }
}

#[cfg(target_os = "windows")]
fn spawn_client(path: &std::path::Path, _host: &str, _port: u16, _user: &str) -> Result<(), String> {
    std::process::Command::new("mstsc")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not start Remote Desktop (mstsc): {e}"))
}

#[cfg(target_os = "macos")]
fn spawn_client(path: &std::path::Path, _host: &str, _port: u16, _user: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open the connection file. Install Microsoft Remote Desktop: {e}"))
}

#[cfg(all(unix, not(target_os = "macos"), desktop))]
fn spawn_client(_path: &std::path::Path, host: &str, port: u16, user: &str) -> Result<(), String> {
    let mut cmd = std::process::Command::new("xfreerdp");
    cmd.arg(format!("/v:{host}:{port}")).arg("/cert:tofu").arg("+clipboard");
    let user = clean(user);
    if !user.is_empty() {
        cmd.arg(format!("/u:{user}"));
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not start xfreerdp (install FreeRDP to use RDP from Linux): {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_minimal_rdp_file() {
        let f = build_rdp_file("10.0.0.5", 3389, "CORP\\alice");
        assert!(f.starts_with("full address:s:10.0.0.5:3389\r\n"));
        assert!(f.contains("username:s:CORP\\alice\r\n"));
        assert!(f.contains("prompt for credentials:i:1"));
        assert!(!f.to_lowercase().contains("password"));
    }

    #[test]
    fn omits_username_when_empty() {
        assert!(!build_rdp_file("h", 3389, "  ").contains("username:"));
    }

    #[test]
    fn line_breaks_in_host_or_user_cannot_inject_settings() {
        let f = build_rdp_file("evil\r\nfull address:s:attacker", 3389, "bob\nredirectdrives:i:1");
        assert_eq!(f.lines().filter(|l| l.starts_with("full address")).count(), 1);
        assert!(!f.lines().any(|l| l.starts_with("redirectdrives")));
    }
}
