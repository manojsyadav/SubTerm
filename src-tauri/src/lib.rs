// windows_subsystem is bin-only; the matching attribute lives in main.rs.

use zeroize::Zeroizing;
use rand::Rng;
use rusqlite::Connection;
use std::sync::Mutex as StdMutex;
use std::path::PathBuf;
use tauri::Manager;
mod ssh_manager;
mod tunnel;
mod monitor;
mod cloud;
mod cloud_config;
mod about;
mod mirror;
mod docker;
mod hlc;
mod identity;
mod vault;
mod commands;
pub use commands::tunnels::start_tunnel_specs_on;
pub(crate) use commands::sync::{decrypt_entity, encrypt_entity, SyncRecord, SyncReport};
use ssh_manager::SshState;
use monitor::{MonitorMap, SharedSettings};
use mirror::MirrorMap;
use vault::*;

pub struct DbState {
    pub conn: std::sync::Arc<StdMutex<Option<Connection>>>,
    /// `Zeroizing` wipes the 32-byte AES-256-GCM key on drop. Without
    /// this, the master key lives on in the heap allocator until the
    /// slot is reused — long enough to land in a crash dump or swap
    /// file. The mutex slot itself is overwritten with None on profile
    /// close which triggers the Zeroize Drop.
    pub master_key: StdMutex<Option<Zeroizing<[u8; 32]>>>,
    pub salt: StdMutex<Option<[u8; SALT_LEN]>>,
    pub db_path: StdMutex<Option<PathBuf>>,
    /// Name of the profile the user picked on the launch screen. Drives the
    /// path of `db_path` (under `<app_data>/profiles/<name>.submarine`) and is
    /// cleared by `close_profile` so the app returns to the picker.
    pub active_profile: StdMutex<Option<String>>,
    /// This profile's Hybrid Logical Clock, shared into the SQLite `hlc_now()`
    /// custom function so every row mutation auto-stamps `updated_at`. `Some`
    /// while a profile is open; `None` on the picker. Held behind an Arc so the
    /// same clock instance backs both the SQL function and any Rust-side sync
    /// code (the merge engine's `observe`).
    pub hlc: StdMutex<Option<std::sync::Arc<hlc::Hlc>>>,
    /// Unified master password cached in memory during an active app session.
    /// Enables seamless 0-prompt profile/workspace switching. Wiped on lock or sign out.
    pub session_password: StdMutex<Option<Zeroizing<String>>>,
}

// ---------------------------------------------------------------------------
// Profile path helpers
// ---------------------------------------------------------------------------

/// Where all profile files live. Created on first use. Each profile is an
/// independently encrypted `.submarine` file — no shared salt, no shared key.
pub(crate) fn profiles_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app.path().app_data_dir()
        .map_err(|e| format!("[SYSTEM] APP_DATA_DIR_NOT_FOUND: {}", e))?;
    let dir = data_dir.join("profiles");
    // Migration: If the legacy com.submarine.app directory exists, copy any missing profiles
    // so saved servers, credentials, and SSH keys are preserved seamlessly across app renames.
    if let Some(parent) = data_dir.parent() {
        let legacy_dir = parent.join("com.submarine.app").join("profiles");
        if legacy_dir.is_dir() {
            let _ = std::fs::create_dir_all(&dir);
            if let Ok(entries) = std::fs::read_dir(&legacy_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                        if ext == "submarine" || ext == "subterm" {
                            let dest = dir.join(entry.file_name());
                            if !dest.exists() {
                                let _ = std::fs::copy(&path, &dest);
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(dir)
}

/// Compute the on-disk path for a named profile. Caller has already
/// validated the name with `validate_profile_name`. Supports both modern
/// `.subterm` and legacy `.submarine` profiles seamlessly.
pub(crate) fn profile_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = profiles_dir(app)?;
    let subterm_path = dir.join(format!("{}.subterm", name));
    if subterm_path.exists() {
        return Ok(subterm_path);
    }
    let submarine_path = dir.join(format!("{}.submarine", name));
    if submarine_path.exists() {
        return Ok(submarine_path);
    }
    Ok(subterm_path)
}

/// Reject names that would let a user escape the profiles dir or collide
/// with reserved filenames on Windows. Keep the charset narrow on purpose
/// so a profile name is always a safe filename component on every OS.
pub(crate) fn validate_profile_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("Profile name cannot be empty".into());
    }
    if n.len() > 32 {
        return Err("Profile name too long (max 32 chars)".into());
    }
    if !n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Profile name may only contain letters, numbers, '-' and '_'".into());
    }
    // Windows reserved device names — also weird on macOS/Linux as filename roots.
    let upper = n.to_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"];
    // `last_byte` is safe here because we already enforced ASCII-only at
    // the charset check above — but we still use `?`/`.map(...)` rather
    // than `.unwrap()` so a future relaxation can never silently panic.
    let last_ascii_digit = upper.as_bytes().last().is_some_and(|b| b.is_ascii_digit());
    if reserved.contains(&upper.as_str())
        || (upper.starts_with("COM") && upper.len() == 4 && last_ascii_digit)
        || (upper.starts_with("LPT") && upper.len() == 4 && last_ascii_digit)
    {
        return Err(format!("'{}' is a reserved name on Windows", n));
    }
    Ok(())
}

pub use commands::servers::QuickAuth;


/// Drive keyboard-interactive (RFC 4256) authentication — the method behind
/// most SSH "verification code" / 2FA / OTP setups. The server sends a
/// sequence of `InfoRequest`s (each a set of prompts like "Verification
/// code:"); we relay every prompt to the UI via `kbi-prompt-{session_id}`,
/// wait for the user's answers on a per-nonce oneshot, and send them back.
///
/// Return contract:
///   * `Some(Ok(true))`  — authenticated.
///   * `Some(Ok(false))` — the user answered but the server rejected, OR the
///                         user cancelled / timed out.
///   * `Some(Err(e))`    — transport error talking to the server.
///   * `None`            — the server never actually prompted us (it doesn't
///                         offer keyboard-interactive). The caller keeps its
///                         original, more meaningful auth result instead of
///                         masking it with a generic interactive failure.
///
/// Generic over the handler so both the primary connection (`ClientHandler`)
/// and a ProxyJump intermediate hop can reuse it.
async fn run_keyboard_interactive<H: russh::client::Handler>(
    session: &mut russh::client::Handle<H>,
    user: &str,
    app: &tauri::AppHandle,
    session_id: &str,
    nonce: &str,
    kbi_txs: &std::sync::Arc<
        tokio::sync::Mutex<
            std::collections::HashMap<String, tokio::sync::oneshot::Sender<Option<Vec<String>>>>,
        >,
    >,
) -> Option<Result<bool, russh::Error>> {
    use russh::client::KeyboardInteractiveAuthResponse;
    use tauri::Emitter;

    let log = |msg: &str, ty: &str| {
        println!("[LOG-{}] {}", session_id, msg);
        let _ = app.emit(
            &format!("session-log-{}", session_id),
            serde_json::json!({"msg": msg, "type": ty}),
        );
    };

    log("Attempting Keyboard-Interactive (verification code) authentication...", "info");

    let mut resp = match session
        .authenticate_keyboard_interactive_start(user.to_string(), None)
        .await
    {
        Ok(r) => r,
        Err(e) => return Some(Err(e)),
    };

    // Guards against masking the primary error: only report a definitive
    // result once the server has actually asked us something.
    let mut asked_anything = false;

    loop {
        match resp {
            KeyboardInteractiveAuthResponse::Success => return Some(Ok(true)),
            KeyboardInteractiveAuthResponse::Failure => {
                if !asked_anything {
                    // Server declined the method outright — not really offered.
                    return None;
                }
                log("Verification code rejected by server.", "error");
                return Some(Ok(false));
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                // A banner-only InfoRequest (zero prompts) needs an empty
                // response set to advance — nothing to ask the user.
                if prompts.is_empty() {
                    resp = match session
                        .authenticate_keyboard_interactive_respond(Vec::new())
                        .await
                    {
                        Ok(r) => r,
                        Err(e) => return Some(Err(e)),
                    };
                    continue;
                }
                asked_anything = true;

                // Fresh oneshot each round — a server may issue several
                // sequential InfoRequests within one auth exchange.
                let (tx, rx) = tokio::sync::oneshot::channel::<Option<Vec<String>>>();
                kbi_txs.lock().await.insert(nonce.to_string(), tx);

                let prompt_payload: Vec<serde_json::Value> = prompts
                    .iter()
                    .map(|p| serde_json::json!({ "prompt": p.prompt, "echo": p.echo }))
                    .collect();
                let _ = app.emit(
                    &format!("kbi-prompt-{}", session_id),
                    serde_json::json!({
                        "nonce": nonce,
                        "name": name,
                        "instructions": instructions,
                        "prompts": prompt_payload,
                    }),
                );

                // 120s: 2FA codes often mean reaching for a phone / authenticator.
                let answers = match tokio::time::timeout(
                    std::time::Duration::from_secs(120),
                    rx,
                )
                .await
                {
                    Ok(Ok(Some(a))) => a,
                    _ => {
                        // Timed out, cancelled, or the channel was dropped.
                        kbi_txs.lock().await.remove(nonce);
                        let _ = app.emit(
                            &format!("kbi-prompt-dismiss-{}", session_id),
                            serde_json::json!({}),
                        );
                        log("Verification prompt cancelled or timed out.", "error");
                        return Some(Ok(false));
                    }
                };
                let _ = app.emit(
                    &format!("kbi-prompt-dismiss-{}", session_id),
                    serde_json::json!({}),
                );

                // The protocol requires exactly one response per prompt.
                // Pad/truncate so a UI/prompt-count mismatch can never desync
                // the SSH auth state machine.
                let mut answers = answers;
                answers.resize(prompts.len(), String::new());

                resp = match session
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                {
                    Ok(r) => r,
                    Err(e) => return Some(Err(e)),
                };
            }
        }
    }
}

/// OS-level TCP keepalive on an SSH transport socket. Complements the SSH
/// protocol keepalive (`keepalive_interval` below): russh 0.40 has no
/// `keepalive_max`, so an unanswered protocol keepalive never tears the
/// connection down — but with TCP keepalive the kernel itself probes an idle
/// peer (30s idle, then every 10s) and errors the socket when the peer is
/// truly gone, which russh's run loop surfaces as `is_closed()`. That gives
/// dead-link detection during long-idle periods without any SSH traffic, and
/// keeps NAT/firewall mappings warm on flaky consumer networks. Best-effort:
/// failure to set it is never a reason to abort a connect. (`with_retries`
/// is deliberately not used — socket2 doesn't support it on Windows.)
fn apply_tcp_keepalive(stream: &tokio::net::TcpStream) {
    use socket2::{SockRef, TcpKeepalive};
    let ka = TcpKeepalive::new()
        .with_time(std::time::Duration::from_secs(30))
        .with_interval(std::time::Duration::from_secs(10));
    let _ = SockRef::from(stream).set_tcp_keepalive(&ka);
}

pub static SSH_KEEPALIVE_SECS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(20);


/// The russh client config shared by the primary connection and any ProxyJump
/// hop, so both negotiate an identical algorithm set. Extracted verbatim from
/// the inline block `initiate_connection` used to carry.
fn build_ssh_client_config() -> russh::client::Config {
    use tokio::time::Duration;
    let mut config = russh::client::Config::default();
    // Dynamic SSH keepalive interval. The shorter interval matters because most
    // consumer routers drop idle NAT mappings around the 2-minute mark, and
    // many corporate firewalls are stricter still. russh 0.40 has no
    // `keepalive_max` knob, so the watcher loop relies on `is_closed()` to
    // surface drops within a couple of seconds.
    let ka_secs = SSH_KEEPALIVE_SECS.load(std::sync::atomic::Ordering::Relaxed);
    config.keepalive_interval = if ka_secs == 0 { None } else { Some(Duration::from_secs(ka_secs)) };
    // Bigger receive window + max-allowed packet size: lets SFTP/tunnel
    // streams keep the BDP full on high-latency links.
    config.window_size = 8 * 1024 * 1024;
    config.maximum_packet_size = 65535;
    // Widen the negotiation set to match OpenSSH — but only in builds that
    // include the OpenSSL backend (release CI via `full-ssh-algos`). See the
    // long rationale that used to sit inline: legacy DH groups, the full RSA
    // host-key family, and HMAC-SHA1 MAC variants for older/embedded servers.
    #[cfg(feature = "full-ssh-algos")]
    {
        config.preferred = russh::Preferred {
            kex: &[
                russh::kex::CURVE25519,
                russh::kex::CURVE25519_PRE_RFC_8731,
                russh::kex::DH_G14_SHA256,
                russh::kex::DH_G14_SHA1,
                russh::kex::DH_G1_SHA1,
                russh::kex::EXTENSION_SUPPORT_AS_CLIENT,
                russh::kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
            ],
            key: &[
                russh_keys::key::ED25519,
                russh_keys::key::ECDSA_SHA2_NISTP256,
                russh_keys::key::RSA_SHA2_512,
                russh_keys::key::RSA_SHA2_256,
                russh_keys::key::SSH_RSA,
            ],
            cipher: &[
                russh::cipher::CHACHA20_POLY1305,
                russh::cipher::AES_256_GCM,
                russh::cipher::AES_256_CTR,
                russh::cipher::AES_192_CTR,
                russh::cipher::AES_128_CTR,
            ],
            mac: &[
                russh::mac::HMAC_SHA512_ETM,
                russh::mac::HMAC_SHA256_ETM,
                russh::mac::HMAC_SHA512,
                russh::mac::HMAC_SHA256,
                russh::mac::HMAC_SHA1_ETM,
                russh::mac::HMAC_SHA1,
            ],
            compression: &["zlib@openssh.com", "zlib", "none"],
        };
    }
    config
}

/// Minimal auth/identity resolver for a ProxyJump bastion. Mirrors the
/// vault-vs-custom / credential-join / key-loading rules of the main connect
/// path but returns only what a jump hop needs (host, port, user, password,
/// optional key). Deliberately kept separate from `initiate_connection`'s
/// inline resolver so the primary connection path is byte-for-byte untouched.
/// It never reads `jump_host_id`, which makes ProxyJump strictly single-hop —
/// there is no way for it to recurse.
///
/// Runs fully synchronously (no `.await`) so the non-`Send` rusqlite
/// `Connection` never has to be held across a suspension point.
fn resolve_jump_auth(
    conn: &rusqlite::Connection,
    server_id: i32,
) -> Result<
    Option<(String, i32, String, Option<String>, Option<(String, Option<String>)>)>,
    String,
> {
    let mut stmt = conn
        .prepare(
            "
            SELECT s.host, s.port,
                   s.username as s_user, c.username as c_user,
                   s.password as s_pass, c.password as c_pass,
                   s.key_id   as s_key,  c.key_id   as c_key,
                   s.auth_type, c.auth_type as cred_auth_type
            FROM servers s
            LEFT JOIN credentials c ON s.credential_id = c.id
            WHERE s.id=?1
        ",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([server_id]).map_err(|e| e.to_string())?;
    let row = match rows.next().map_err(|e| e.to_string())? {
        Some(r) => r,
        None => return Ok(None),
    };
    let host: String = row.get::<_, String>(0).map_err(|e| format!("[DB] jump host: {}", e))?;
    let port: i32 = row.get::<_, i32>(1).map_err(|e| format!("[DB] jump port: {}", e))?;
    let s_user: Option<String> = row.get::<_, Option<String>>(2).unwrap_or_default();
    let c_user: Option<String> = row.get::<_, Option<String>>(3).unwrap_or_default();
    let s_pass: Option<String> = row.get::<_, Option<String>>(4).unwrap_or_default();
    let c_pass: Option<String> = row.get::<_, Option<String>>(5).unwrap_or_default();
    let s_key: Option<i32> = row.get::<_, Option<i32>>(6).unwrap_or_default();
    let c_key: Option<i32> = row.get::<_, Option<i32>>(7).unwrap_or_default();
    let server_auth_type: String = row
        .get::<_, Option<String>>(8)
        .unwrap_or_default()
        .unwrap_or_else(|| "vault".to_string());
    let cred_auth_type: Option<String> = row.get::<_, Option<String>>(9).unwrap_or_default();

    let (username, password, key_id) = if server_auth_type == "vault" {
        (c_user.unwrap_or_default(), c_pass, c_key)
    } else {
        (s_user.unwrap_or_default(), s_pass, s_key)
    };
    let effective_key_id = if server_auth_type == "vault" {
        if cred_auth_type.as_deref() == Some("key") { key_id } else { None }
    } else if server_auth_type == "custom_key" {
        key_id
    } else {
        None
    };
    let key_data = if let Some(kid) = effective_key_id {
        let mut key_stmt = conn
            .prepare("SELECT private_key, passphrase FROM ssh_keys WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        let mut key_rows = key_stmt.query([kid]).map_err(|e| e.to_string())?;
        if let Some(key_row) = key_rows.next().map_err(|e| e.to_string())? {
            let private_key: String = key_row.get::<_, String>(0).map_err(|e| e.to_string())?;
            let passphrase: Option<String> = key_row.get::<_, Option<String>>(1).map_err(|e| e.to_string())?;
            Some((private_key, passphrase))
        } else {
            None
        }
    } else {
        None
    };

    Ok(Some((host, port, username, password, key_data)))
}

/// Establish + authenticate an SSH connection to a ProxyJump intermediate
/// ("bastion") host and return its live `Handle`. The caller opens a
/// `direct-tcpip` channel over this handle to reach the real target, then keeps
/// the handle alive for the target session's lifetime (see
/// `SshState::jump_connections`).
///
/// The bastion is reached by a DIRECT TCP connection — its own proxy config, if
/// any, is not honored (bastions are normally directly reachable). Its host key
/// is verified through the SAME frontend prompt as the target (events emitted
/// under the target's `session_id`, keyed by a distinct nonce), and it supports
/// the full key → password → keyboard-interactive auth ladder.
async fn connect_jump_host(
    app: &tauri::AppHandle,
    db: &std::sync::Arc<std::sync::Mutex<Option<rusqlite::Connection>>>,
    fp_txs: &std::sync::Arc<
        tokio::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<bool>>>,
    >,
    kbi_txs: &std::sync::Arc<
        tokio::sync::Mutex<
            std::collections::HashMap<String, tokio::sync::oneshot::Sender<Option<Vec<String>>>>,
        >,
    >,
    session_id: &str,
    jump_server_id: i32,
) -> Result<russh::client::Handle<ssh_manager::ClientHandler>, String> {
    use tokio::time::Duration;
    use tauri::Emitter;

    let log = |msg: &str, ty: &str| {
        println!("[LOG-{}] [jump] {}", session_id, msg);
        let _ = app.emit(
            &format!("session-log-{}", session_id),
            serde_json::json!({"msg": msg, "type": ty}),
        );
    };

    // 1. Resolve the bastion's config synchronously and drop the DB guard
    //    before any await (rusqlite Connection is not Send).
    let (host, port, user, password, key_data) = {
        let guard = db.lock().map_err(|_| "[STATE] LOCK_FAILED".to_string())?;
        let conn = guard
            .as_ref()
            .ok_or_else(|| "[STATE] DATABASE_NOT_INITIALIZED".to_string())?;
        match resolve_jump_auth(conn, jump_server_id)? {
            Some(v) => v,
            None => return Err("jump host not found".into()),
        }
    };
    let effective_user = if user.trim().is_empty() {
        "root".to_string()
    } else {
        user.trim().to_string()
    };

    // 2. Direct TCP to the bastion.
    log(&format!("Connecting to jump host {}:{}...", host, port), "info");
    let tcp = match tokio::time::timeout(
        Duration::from_secs(10),
        tokio::net::TcpStream::connect((host.as_str(), port as u16)),
    )
    .await
    {
        Ok(Ok(s)) => {
            let _ = s.set_nodelay(true);
            apply_tcp_keepalive(&s);
            s
        }
        Ok(Err(e)) => return Err(humanize_network_err(&e.to_string(), &host, port, "Jump host connection")),
        Err(_) => return Err(format!("jump host {}:{} did not respond within 10 seconds", host, port)),
    };

    // 3. Host-key round-trip: own nonce, shared fp_txs map + frontend session.
    let (fp_tx, fp_rx) = tokio::sync::oneshot::channel();
    let jump_nonce: String = {
        let mut bytes = [0u8; 16];
        rand::thread_rng().fill(&mut bytes);
        hex::encode(bytes)
    };
    fp_txs.lock().await.insert(jump_nonce.clone(), fp_tx);
    let fp_outcome = std::sync::Arc::new(std::sync::atomic::AtomicI8::new(-1));

    let handler = ssh_manager::ClientHandler {
        app: app.clone(),
        session_id: session_id.to_string(),
        connect_nonce: jump_nonce.clone(),
        server_host: host.clone(),
        server_port: port as u16,
        db: std::sync::Arc::clone(db),
        fp_rx: Some(fp_rx),
        forwarded_targets: std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        fp_outcome,
    };

    // 4. Handshake.
    let config = std::sync::Arc::new(build_ssh_client_config());
    log("Jump host: SSH handshake...", "info");
    let connect_res = tokio::time::timeout(
        Duration::from_secs(15),
        russh::client::connect_stream(config, tcp, handler),
    )
    .await;
    // The host-key prompt (if any) is resolved by now — drop the sender.
    fp_txs.lock().await.remove(&jump_nonce);

    let mut session = match connect_res {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(format!("jump host handshake failed: {}", e)),
        Err(_) => return Err("jump host handshake timed out".into()),
    };

    // 5. Auth ladder: key → password → keyboard-interactive.
    let mut auth_res = if let Some((private_key, passphrase)) = key_data {
        log("Jump host: private key authentication...", "info");
        let normalized_key = private_key.replace("\r\n", "\n");
        match russh_keys::decode_secret_key(&normalized_key, passphrase.as_deref()) {
            Ok(keypair) => session.authenticate_publickey(&effective_user, std::sync::Arc::new(keypair)).await,
            Err(e) => Err(russh::Error::from(std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))),
        }
    } else if let Some(pass) = password {
        log("Jump host: password authentication...", "info");
        session.authenticate_password(&effective_user, pass).await
    } else {
        Ok(false)
    };

    if !matches!(auth_res, Ok(true)) {
        if let Some(kbi_res) =
            run_keyboard_interactive(&mut session, &effective_user, app, session_id, &jump_nonce, kbi_txs).await
        {
            auth_res = kbi_res;
        }
    }
    // Belt-and-suspenders: no dangling interactive sender for this hop.
    kbi_txs.lock().await.remove(&jump_nonce);

    match auth_res {
        Ok(true) => {
            log("Jump host authenticated.", "success");
            Ok(session)
        }
        Ok(false) => Err("jump host authentication failed".into()),
        Err(e) => Err(format!("jump host auth error: {}", e)),
    }
}

/// Fully tear down ONE connection map-entry by its exact key. Used to reap the
/// dedicated `::sftp` / `::fwd` secondary connections the separate-sessions
/// feature spins up, so disconnecting or reconnecting the PRIMARY never orphans
/// them (a leaked secondary would hold a live TCP + SSH session forever). Safe
/// to call on a key that doesn't exist — every step is then a no-op. Bumps the
/// key's generation so the secondary's own health watcher observes the change on
/// its next tick and bows out WITHOUT emitting a `session-disconnected-{key}`.
async fn teardown_connection_key(state: &SshState, mirrors: &MirrorMap, key: &str) {
    // Bump the generation FIRST — before removing the connection — so a connect
    // worker for this key that's still handshaking observes the newer value at
    // its "still wanted?" registration guard and bails instead of registering a
    // zombie. (Worker holds the generation lock across its check+insert, and we
    // bump-then-remove here, so the two orderings can't leave a stray entry.)
    {
        let mut g = state.session_generation.lock().await;
        let next = g.get(key).copied().unwrap_or(0).wrapping_add(1);
        g.insert(key.to_string(), next);
    }
    // Stop forwarders first so their listener sockets release before the SSH
    // handle drops — same ordering rationale as disconnect_session.
    tunnel::stop_all_for_session(&state.tunnels, key).await;
    state.forwarded_targets.lock().await.remove(key);
    state.session_tunnel_specs.lock().await.remove(key);
    mirror::stop_all_for_session(mirrors, key).await;
    state.sftp_sessions.lock().await.remove(key);
    // The base session's cached SFTP subsystem may be riding this dedicated
    // `::sftp` transport — drop it so the next file op re-opens on whatever
    // transport remains instead of erroring on a closed channel.
    if let Some(base) = key.strip_suffix("::sftp") {
        state.sftp_sessions.lock().await.remove(base);
    }
    state.connections.lock().await.remove(key);
    state.jump_connections.lock().await.remove(key);
    // Wipe temp files the secondary's SFTP downloads / drags left behind.
    let td = session_sftp_dir(key);
    if td.exists() {
        let _ = std::fs::remove_dir_all(&td);
    }
    let dd = session_drag_dir(key);
    if dd.exists() {
        let _ = std::fs::remove_dir_all(&dd);
    }
}

#[tauri::command]
async fn initiate_connection(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    db_state: tauri::State<'_, DbState>,
    mirrors: tauri::State<'_, MirrorMap>,
    session_id: String,
    server_id: i32,
    custom_password: Option<String>,
    quick_auth: Option<QuickAuth>,
    // Separate-sessions feature (default OFF). `session_role` marks whether this
    // is the primary terminal connection ("primary", the default) or a dedicated
    // secondary connection carved off for SFTP ("sftp") or port-forwarding
    // ("forward"). `separate_sessions` is only meaningful on the PRIMARY call: it
    // tells the primary to NOT auto-start the saved tunnels itself, because the
    // dedicated "forward" connection (opened by the frontend right after) will.
    // See the connection topology notes near the auth block below.
    session_role: Option<String>,
    separate_sessions: Option<bool>,
) -> Result<(), String> {
    use tauri::Emitter;
    use tokio::time::Duration;
    use russh::client;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    // Connection role + topology flags. Kept as plain locals so the whole
    // function (worker included) can branch on them without re-parsing.
    let role: String = session_role
        .as_deref()
        .map(str::to_string)
        .unwrap_or_else(|| "primary".to_string());
    let is_secondary = role != "primary";
    let separate = separate_sessions.unwrap_or(false);
    // Only the PRIMARY drives interactive keyboard-interactive (2FA) auth. A
    // secondary connection that hit a 2FA challenge would emit a `kbi-prompt`
    // the UI isn't wired to answer for the suffixed session id, so it would just
    // hang. Instead we let the secondary fail its auth and the frontend falls
    // back to routing SFTP / forwarding over the primary connection.
    let allow_kbi = !is_secondary;
    // Which connection auto-starts this server's saved tunnels inline:
    //   - primary + shared mode    → yes (unchanged legacy behaviour)
    //   - primary + separate mode  → no  (the "forward" connection takes over)
    //   - "forward" secondary      → never inline; it runs the MIGRATION block
    //     instead (stop anything running under the base tag, then restart the
    //     full replay list on itself, still tagged under the base session id)
    //   - "sftp" secondary         → no
    let start_tunnels_inline = role == "primary" && !separate;

    println!("[BACKEND] initiate_connection invoked for session_id: {} (role: {}, separate: {}), server_id: {}", session_id, role, separate, server_id);

    // Reconnect path: if a previous session under this id is still registered,
    // tear it down before starting the fresh handshake. Without this, the
    // duplicate-detection early-return below would silently drop every
    // reconnect attempt and the UI would just sit on "connecting…" forever.
    // Tunnels + forwarded_targets get the same treatment further down via the
    // stop_all_for_session call, so we don't duplicate that here.
    {
        let mut conns = state.connections.lock().await;
        if conns.remove(&session_id).is_some() {
            println!("[BACKEND] Tearing down stale session for reconnect: {}", session_id);
        }
    }
    // Drop any ProxyJump bastion handle from a prior attempt — dropping it
    // closes the old jump connection so the reconnect opens a fresh one.
    state.jump_connections.lock().await.remove(&session_id);
    state.sftp_sessions.lock().await.remove(&session_id);
    state.session_passwords.lock().await.remove(&session_id);
    // Terminal IDs are `${session_id}-term-N` (see SessionView.tsx), so we
    // sweep every PTY task tied to the old handle. Match by the exact
    // `${session_id}-term-` prefix so id `session-1` doesn't sweep the
    // terminals of `session-10`, `session-11`, ... — a `contains`-based
    // match here silently tore down unrelated live sessions once server
    // IDs (which are SQLite autoincrement ints) crossed 10.
    let term_prefix = format!("{}-term-", session_id);
    state.terminal_txs.lock().await.retain(|k, _| !k.starts_with(&term_prefix));
    state.resize_txs.lock().await.retain(|k, _| !k.starts_with(&term_prefix));
    // Bump the generation so any watcher task still alive from the prior
    // attempt sees a newer value next tick and bails silently instead of
    // racing the new connect to emit `session-disconnected-{id}`.
    let connect_generation: u64 = {
        let mut g = state.session_generation.lock().await;
        let next = g.get(&session_id).copied().unwrap_or(0).wrapping_add(1);
        g.insert(session_id.clone(), next);
        next
    };

    println!("[BACKEND] No duplicates found. Registering oneshot channel and spawning connection worker...");
    let (fp_tx, fp_rx) = tokio::sync::oneshot::channel();
    // Random per-connect nonce — keys the fp_txs map so a stale `accept`
    // for one attempt (frontend bug, malicious IPC call, retry race)
    // cannot satisfy the prompt of a fresh connection. Hex over 16 bytes
    // = 128 bits of entropy, plenty for a single-use guard.
    let connect_nonce: String = {
        let mut bytes = [0u8; 16];
        rand::thread_rng().fill(&mut bytes);
        hex::encode(bytes)
    };
    // NB: the fp_txs insert is deliberately deferred until AFTER the DB
    // resolution below. The resolution block has several `?` early-returns; if
    // we inserted here, any of them would return before the worker (which owns
    // the FpCleanupGuard) is spawned, orphaning the sender in the map forever.

    let session_id_clone = session_id.clone();
    let state_connections = Arc::clone(&state.connections);
    let state_sftp_sessions = Arc::clone(&state.sftp_sessions);
    let state_tunnels = Arc::clone(&state.tunnels);
    let state_session_tunnel_specs = Arc::clone(&state.session_tunnel_specs);
    let state_session_generation = Arc::clone(&state.session_generation);
    let state_session_passwords = Arc::clone(&state.session_passwords);
    let fp_txs_clone = Arc::clone(&state.fp_txs);
    let kbi_txs_clone = Arc::clone(&state.kbi_txs);
    let state_jump_connections = Arc::clone(&state.jump_connections);
    // Second Arc into the DB for the ProxyJump hop — the handler below moves
    // the primary `db_conn_shared`, and the spawned worker needs its own owned
    // handle to resolve the bastion's credentials.
    let db_for_jump = Arc::clone(&db_state.conn);
    let db_conn_shared = Arc::clone(&db_state.conn);

    // Reconnect path: tear down any stale listeners + R-tunnel registrations
    // bound to this session_id. Without this, the old TCP listener stays bound
    // to the local port, the new start_tunnel below hits a bind conflict, and
    // every existing tunnel silently routes traffic into a dead SSH handle.
    // First-connect is a no-op (no entries to remove).
    tunnel::stop_all_for_session(&state.tunnels, &session_id).await;
    state.forwarded_targets.lock().await.remove(&session_id);
    // Same story for mirrors — a reconnect must not inherit a mirror worker
    // that still holds an Arc<SftpSession> pointing at the DEAD handle from
    // the previous attempt. Without this the reconnected session appears
    // fine but the mirror keeps writing upload-fail logs against the old
    // socket forever, and manual Stop is the only way to clear it.
    mirror::stop_all_for_session(&mirrors, &session_id).await;

    // Separate-sessions: a PRIMARY (re)connect must reap any stale dedicated
    // `::sftp` / `::fwd` connections from a previous attempt, so the frontend can
    // re-open fresh ones after this success. Gated to the primary so a secondary
    // connect doesn't try to sweep its own (non-existent) grandchildren. Skipped
    // entirely for keys that already carry a `::` suffix (i.e. this IS a
    // secondary), and a plain no-op on first connect / shared mode.
    if !is_secondary {
        teardown_connection_key(state.inner(), mirrors.inner(), &format!("{}::sftp", session_id)).await;
        teardown_connection_key(state.inner(), mirrors.inner(), &format!("{}::fwd", session_id)).await;
    } else {
        // Dedicated-transport reconnect (manual button / auto-retry) OVER a
        // still-live old handle: the base-tagged tunnels ride this transport and
        // the base SFTP cache points at it, so release them before the new
        // handshake. Otherwise, if the fresh attempt fails, the old tunnels keep
        // running on a connection nobody watches (zombie) and file ops hit a
        // dead subsystem. Mirrors disconnect_session's dedicated-transport hooks.
        if let Some(base) = session_id.strip_suffix("::fwd") {
            tunnel::stop_all_for_session(&state.tunnels, base).await;
        }
        if let Some(base) = session_id.strip_suffix("::sftp") {
            state.sftp_sessions.lock().await.remove(base);
        }
    }

    // Per-session map for R-tunnel target lookups. Created here so the same
    // Arc can be handed to both the ClientHandler (consulted on incoming
    // forwarded-tcpip channels) and to tunnel::start_tunnel (which writes the
    // mapping when a remote tunnel is set up).
    let session_forwarded_targets: tunnel::ForwardedTargets =
        Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
    state.forwarded_targets.lock().await.insert(
        session_id.clone(),
        Arc::clone(&session_forwarded_targets),
    );

    // Quick connect bypasses the DB lookup entirely — we fabricate the
    // same tuple shape from the inline values so all downstream code
    // (auth, tunnel-start, handler setup) doesn't need to branch.
    let db_res = if let Some(q) = quick_auth.as_ref() {
        let key_data = q.private_key
            .clone()
            .filter(|s| !s.trim().is_empty())
            .map(|pk| (pk, q.passphrase.clone()));
        let auth_type = if key_data.is_some() { "custom_key" } else { "custom_pass" };
        Some((
            q.host.clone(),
            q.port,
            q.username.clone(),
            q.password.clone(),
            key_data,
            "none".to_string(),         // proxy_type — no proxy in quick mode
            None,                       // proxy_host
            None,                       // proxy_port
            auth_type.to_string(),      // server_auth_type
            None,                       // cred_auth_type (unused for custom_*)
            None,                       // db_key_id (debug-log only)
            None,                       // effective_key_id (auth code branches on key_data, not this)
            "[]".to_string(),           // tunnels_json — no auto-start tunnels
            None,                       // jump_host_id — quick connect never bounces through a bastion
        ))
    } else {
    // Fetch DB record inside a nested block to drop non-Send Rows/Statement before any await
    {
        let conn_guard = db_state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
        let conn = conn_guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
        
        // Pull both server-side and credential-side identity fields separately
        // and resolve in Rust. The previous COALESCE was order-of-precedence
        // magic that hid the actual rule from anyone reading the SQL — now the
        // rule is "vault mode → credential fields; custom_* mode → node fields"
        // and nothing else can mix the two.
        let mut stmt = conn.prepare("
            SELECT s.host, s.port,
                   s.username as s_user, c.username as c_user,
                   s.password as s_pass, c.password as c_pass,
                   s.key_id   as s_key,  c.key_id   as c_key,
                   s.proxy_type, s.proxy_host, s.proxy_port,
                   s.auth_type, c.auth_type as cred_auth_type, s.tunnels,
                   s.jump_host_id
            FROM servers s
            LEFT JOIN credentials c ON s.credential_id = c.id
            WHERE s.id=?1
        ").map_err(|e| e.to_string())?;

        let mut rows = stmt.query([server_id]).map_err(|e| e.to_string())?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            // host/port are NOT NULL in the schema, but propagating
            // errors instead of `.unwrap()` means a manual DB edit or a
            // future schema relaxation can never silently panic the
            // spawned connection worker — the user gets a clean error.
            let host: String = row.get::<_, String>(0).map_err(|e| format!("[DB] host: {}", e))?;
            let port: i32 = row.get::<_, i32>(1).map_err(|e| format!("[DB] port: {}", e))?;
            let s_user: Option<String> = row.get::<_, Option<String>>(2).unwrap_or_default();
            let c_user: Option<String> = row.get::<_, Option<String>>(3).unwrap_or_default();
            let s_pass: Option<String> = row.get::<_, Option<String>>(4).unwrap_or_default();
            let c_pass: Option<String> = row.get::<_, Option<String>>(5).unwrap_or_default();
            let s_key:  Option<i32>    = row.get::<_, Option<i32>>(6).unwrap_or_default();
            let c_key:  Option<i32>    = row.get::<_, Option<i32>>(7).unwrap_or_default();
            let proxy_type: String = row.get::<_, Option<String>>(8).unwrap_or_default().unwrap_or_else(|| "none".to_string());
            let proxy_host: Option<String> = row.get::<_, Option<String>>(9).unwrap_or_default();
            let proxy_port: Option<i32> = row.get::<_, Option<i32>>(10).unwrap_or_default();
            let server_auth_type: String = row.get::<_, Option<String>>(11).unwrap_or_default().unwrap_or_else(|| "vault".to_string());
            let cred_auth_type: Option<String> = row.get::<_, Option<String>>(12).unwrap_or_default();
            let tunnels_json: String = row.get::<_, Option<String>>(13).unwrap_or_default().unwrap_or_else(|| "[]".to_string());
            let jump_host_id: Option<i32> = row.get::<_, Option<i32>>(14).unwrap_or_default();

            // Single source of truth per auth_type — no field mixing.
            // - vault: identity comes ENTIRELY from the credential row. Any
            //   stale username/password/key on the node row is ignored.
            // - custom_pass / custom_key: identity comes ENTIRELY from the
            //   node row.
            let (username, password, key_id) = if server_auth_type == "vault" {
                (c_user.unwrap_or_default(), c_pass, c_key)
            } else {
                (s_user.unwrap_or_default(), s_pass, s_key)
            };

            // Whether to actually load a key file:
            // - vault: only if the chosen credential is itself key-typed
            // - custom_key: yes, use the node's selected key
            // - custom_pass: no
            let effective_key_id = if server_auth_type == "vault" {
                if cred_auth_type.as_deref() == Some("key") { key_id } else { None }
            } else if server_auth_type == "custom_key" {
                key_id
            } else {
                None
            };

            // Fetch key details if a key is needed
            let key_data = if let Some(kid) = effective_key_id {
                let mut key_stmt = conn.prepare("SELECT private_key, passphrase FROM ssh_keys WHERE id = ?1").map_err(|e| e.to_string())?;
                let mut key_rows = key_stmt.query([kid]).map_err(|e| e.to_string())?;
                if let Some(key_row) = key_rows.next().map_err(|e| e.to_string())? {
                    let private_key: String = key_row.get::<_, String>(0).map_err(|e| e.to_string())?;
                    let passphrase: Option<String> = key_row.get::<_, Option<String>>(1).map_err(|e| e.to_string())?;
                    Some((private_key, passphrase))
                } else {
                    None
                }
            } else {
                None
            };

            Some((host, port, username, password, key_data, proxy_type, proxy_host, proxy_port, server_auth_type, cred_auth_type, key_id, effective_key_id, tunnels_json, jump_host_id))
        } else {
            None
        }
    }
    };

    let (host, port, user, password, key_data, proxy_type, proxy_host, proxy_port, server_auth_type, cred_auth_type, db_key_id, effective_key_id, tunnels_json, jump_host_id) = match db_res {
        Some(val) => val,
        None => {
            return Err("Server not found".into());
        }
    };

    // DB resolution succeeded — now register the fingerprint sender. From here
    // on the worker is always spawned, so its FpCleanupGuard guarantees this
    // entry is removed even on the failure paths.
    state.fp_txs.lock().await.insert(connect_nonce.clone(), fp_tx);

    // Shared between the handler and the connect driver so we can tell host-
    // key timeouts apart from real auth errors on the failure path. See
    // ClientHandler::fp_outcome for the meaning of the values.
    let fp_outcome = std::sync::Arc::new(std::sync::atomic::AtomicI8::new(-1));
    let fp_outcome_for_driver = std::sync::Arc::clone(&fp_outcome);

    let handler = ssh_manager::ClientHandler {
        app: app.clone(),
        session_id: session_id.clone(),
        connect_nonce: connect_nonce.clone(),
        server_host: host.clone(),
        server_port: port as u16,
        db: db_conn_shared,
        fp_rx: Some(fp_rx),
        forwarded_targets: Arc::clone(&session_forwarded_targets),
        fp_outcome: std::sync::Arc::clone(&fp_outcome),
    };

    let cleanup_nonce = connect_nonce.clone();
    // Own an Arc into MirrorMap so the outer spawn (which requires 'static)
    // doesn't try to borrow the caller's `mirrors: State<'_, MirrorMap>`.
    // The Arc is 'static; the State reference is not.
    let mirrors_owned: MirrorMap = mirrors.inner().clone();

    tauri::async_runtime::spawn(async move {
        println!("[BACKEND WORKER] Started connection worker thread for session: {}", session_id_clone);

        struct FpCleanupGuard {
            fp_txs: Arc<Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
            kbi_txs: Arc<Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<Option<Vec<String>>>>>>,
            nonce: String,
        }
        impl Drop for FpCleanupGuard {
            fn drop(&mut self) {
                let fp_txs = Arc::clone(&self.fp_txs);
                let kbi_txs = Arc::clone(&self.kbi_txs);
                let nonce = self.nonce.clone();
                tauri::async_runtime::spawn(async move {
                    fp_txs.lock().await.remove(&nonce);
                    // Worker died mid keyboard-interactive prompt — drop any
                    // dangling sender so a late frontend response is a no-op.
                    kbi_txs.lock().await.remove(&nonce);
                });
            }
        }
        let _guard = FpCleanupGuard {
            fp_txs: Arc::clone(&fp_txs_clone),
            kbi_txs: Arc::clone(&kbi_txs_clone),
            nonce: cleanup_nonce.clone(),
        };

        let emit_log = |msg: &str, log_type: &str| {
            println!("[LOG-{}] {}", session_id_clone, msg);
            let _ = app.emit(&format!("session-log-{}", session_id_clone), serde_json::json!({"msg": msg, "type": log_type}));
        };

        let cleanup = || async {
            // Already handled by Drop Guard, but keeping for immediate eviction if needed
            fp_txs_clone.lock().await.remove(&cleanup_nonce);
        };

        emit_log("Initializing SSH connection process...", "info");
        let effective_user = if user.trim().is_empty() {
            emit_log("Username is empty. Defaulting to 'root'.", "info");
            "root".to_string()
        } else {
            user.trim().to_string()
        };
        emit_log(&format!("Server Details -> Host: {}, Port: {}, User: {}", host, port, effective_user), "info");
        emit_log(&format!("[DEBUG] Server Auth Method: {}", server_auth_type), "info");
        if server_auth_type == "vault" {
            emit_log(&format!("[DEBUG] Vault Identity Auth Type: {:?}", cred_auth_type), "info");
        }
        emit_log(&format!("[DEBUG] SQLite DB key_id: {:?}", db_key_id), "info");
        emit_log(&format!("[DEBUG] effective_key_id determined: {:?}", effective_key_id), "info");
        if let Some((ref priv_key, ref passphrase)) = key_data {
            emit_log(&format!("[DEBUG] SSH Key loaded from DB. Private Key length: {} chars, Has Passphrase: {}", priv_key.len(), passphrase.is_some()), "info");
            if priv_key.trim().is_empty() {
                emit_log("[DEBUG] WARNING: SSH Key content is EMPTY!", "error");
            } else {
                let first_line = priv_key.lines().next().unwrap_or("");
                emit_log(&format!("[DEBUG] SSH Key Header: {}", first_line), "info");
            }
        } else {
            emit_log("[DEBUG] No SSH Key was loaded from database for this session.", "info");
        }

        // Set up generic stream based on proxy configuration
        trait AsyncStream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static {}
        impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static> AsyncStream for T {}

        struct StreamWrapper(Box<dyn AsyncStream>);
        impl tokio::io::AsyncRead for StreamWrapper {
            fn poll_read(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &mut tokio::io::ReadBuf<'_>) -> std::task::Poll<std::io::Result<()>> {
                std::pin::Pin::new(&mut *self.0).poll_read(cx, buf)
            }
        }
        impl tokio::io::AsyncWrite for StreamWrapper {
            fn poll_write(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &[u8]) -> std::task::Poll<std::io::Result<usize>> {
                std::pin::Pin::new(&mut *self.0).poll_write(cx, buf)
            }
            fn poll_flush(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
                std::pin::Pin::new(&mut *self.0).poll_flush(cx)
            }
            fn poll_shutdown(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
                std::pin::Pin::new(&mut *self.0).poll_shutdown(cx)
            }
        }

        // ProxyJump takes precedence over a direct / proxied transport. When a
        // bastion is configured we connect+auth to it first, then open a
        // `direct-tcpip` channel to the REAL target over that connection and
        // use the channel as the transport for the primary handshake — exactly
        // what `ssh -J bastion target` does. The bastion's own Handle is parked
        // in `jump_handle_holder` so it lives through the target handshake; on
        // success it moves into `state_jump_connections` for the session's life.
        let mut jump_handle_holder: Option<russh::client::Handle<ssh_manager::ClientHandler>> = None;
        let stream_res: Result<Box<dyn AsyncStream>, String> = if let Some(jid) = jump_host_id {
            emit_log(&format!("ProxyJump: routing through jump host (server id {})...", jid), "info");
            match connect_jump_host(&app, &db_for_jump, &fp_txs_clone, &kbi_txs_clone, &session_id_clone, jid).await {
                Ok(jump_handle) => {
                    // Originator address is cosmetic (logged by the bastion); the
                    // pair below is what OpenSSH sends for a -J hop.
                    match jump_handle
                        .channel_open_direct_tcpip(host.clone(), port as u32, "127.0.0.1", 0)
                        .await
                    {
                        Ok(channel) => {
                            emit_log(&format!("ProxyJump: opened tunnel to {}:{} through the jump host.", host, port), "success");
                            let boxed: Box<dyn AsyncStream> = Box::new(channel.into_stream());
                            jump_handle_holder = Some(jump_handle);
                            Ok(boxed)
                        }
                        Err(e) => Err(format!(
                            "ProxyJump: could not open a channel to {}:{} through the jump host: {}",
                            host, port, e
                        )),
                    }
                }
                Err(e) => Err(format!("ProxyJump: {}", e)),
            }
        } else {
        match proxy_type.as_str() {
            "socks5" => {
                let p_host = match proxy_host.as_ref().filter(|h| !h.is_empty()) {
                    Some(h) => h,
                    None => {
                        let err_msg = "SOCKS5 Proxy Host is empty";
                        emit_log(&format!("Error: {}", err_msg), "error");
                        cleanup().await;
                        let _ = app.emit(&format!("connection-failed-{}", session_id_clone), serde_json::json!({"reason": err_msg}));
                        return;
                    }
                };
                let p_port = proxy_port.unwrap_or(1080) as u16;
                emit_log(&format!("Connecting via SOCKS5 Proxy {}:{}...", p_host, p_port), "info");
                
                let proxy_addr = format!("{}:{}", p_host, p_port);
                match tokio::time::timeout(
                    Duration::from_secs(10),
                    tokio_socks::tcp::Socks5Stream::connect(proxy_addr.as_str(), (host.as_str(), port as u16))
                ).await {
                    Ok(Ok(stream)) => {
                        emit_log("SOCKS5 Proxy tunnel established successfully.", "success");
                        // Socks5Stream derefs to the inner TcpStream, so the
                        // kernel keepalive applies to the real proxy socket.
                        apply_tcp_keepalive(&stream);
                        Ok(Box::new(stream))
                    }
                    Ok(Err(e)) => {
                        Err(humanize_network_err(&e.to_string(), &host, port, "SOCKS5 proxy"))
                    }
                    Err(_) => {
                        Err(format!("SOCKS5 proxy {}:{} did not respond in time", p_host, p_port))
                    }
                }
            }
            "http" => {
                let p_host = match proxy_host.as_ref().filter(|h| !h.is_empty()) {
                    Some(h) => h,
                    None => {
                        let err_msg = "HTTP Proxy Host is empty";
                        emit_log(&format!("Error: {}", err_msg), "error");
                        cleanup().await;
                        let _ = app.emit(&format!("connection-failed-{}", session_id_clone), serde_json::json!({"reason": err_msg}));
                        return;
                    }
                };
                let p_port = proxy_port.unwrap_or(8080) as u16;
                emit_log(&format!("Connecting via HTTP Proxy {}:{}...", p_host, p_port), "info");

                let proxy_addr = format!("{}:{}", p_host, p_port);
                match tokio::time::timeout(
                    Duration::from_secs(10),
                    tokio::net::TcpStream::connect(proxy_addr)
                ).await {
                    Ok(Ok(mut tcp_stream)) => {
                        // Disable Nagle: SSH is heavily interactive (keystrokes,
                        // small control packets) and batching adds noticeable
                        // round-trip latency. Ignore failures — set_nodelay is
                        // best-effort; some platforms / virtual NICs reject it.
                        let _ = tcp_stream.set_nodelay(true);
                        apply_tcp_keepalive(&tcp_stream);
                        emit_log(&format!("Requesting HTTP CONNECT tunnel to {}:{}...", host, port), "info");
                        match tokio::time::timeout(
                            Duration::from_secs(10),
                            async_http_proxy::http_connect_tokio(&mut tcp_stream, &host, port as u16)
                        ).await {
                            Ok(Ok(_)) => {
                                emit_log("HTTP Proxy tunnel established successfully.", "success");
                                Ok(Box::new(tcp_stream))
                            }
                            Ok(Err(e)) => {
                                Err(humanize_network_err(&e.to_string(), &host, port, "HTTP CONNECT tunnel"))
                            }
                            Err(_) => {
                                Err(format!("HTTP CONNECT tunnel to {}:{} timed out", host, port))
                            }
                        }
                    }
                    Ok(Err(e)) => {
                        Err(humanize_network_err(&e.to_string(), p_host, p_port as i32, "HTTP proxy"))
                    }
                    Err(_) => {
                        Err(format!("HTTP proxy {}:{} did not respond in time", p_host, p_port))
                    }
                }
            }
            _ => {
                emit_log(&format!("Connecting directly to {}:{}...", host, port), "info");
                match tokio::time::timeout(
                    Duration::from_secs(10),
                    tokio::net::TcpStream::connect((host.as_str(), port as u16))
                ).await {
                    Ok(Ok(stream)) => {
                        // See HTTP-proxy branch — SSH wants every packet on the
                        // wire immediately, no Nagle batching.
                        let _ = stream.set_nodelay(true);
                        apply_tcp_keepalive(&stream);
                        emit_log("Direct TCP Connection established successfully.", "success");
                        Ok(Box::new(stream))
                    }
                    Ok(Err(e)) => {
                        Err(humanize_network_err(&e.to_string(), &host, port, "Connection"))
                    }
                    Err(_) => {
                        Err(format!("{}:{} did not respond within 10 seconds", host, port))
                    }
                }
            }
        }
        };

        let stream = match stream_res {
            Ok(s) => s,
            Err(e) => {
                emit_log(&e, "error");
                cleanup().await;
                let _ = app.emit(&format!("connection-failed-{}", session_id_clone), serde_json::json!({"reason": e}));
                return;
            }
        };

        emit_log("Starting SSH Handshake and establishing secure session...", "info");
        // Config (keepalive, windows, algorithm negotiation) is shared with the
        // ProxyJump hop — see build_ssh_client_config for the full rationale.
        let config = Arc::new(build_ssh_client_config());

        let connect_future = client::connect_stream(config, StreamWrapper(stream), handler);

        match tokio::time::timeout(Duration::from_secs(15), connect_future).await {
            Ok(Ok(mut session)) => {
                emit_log("SSH Handshake complete. Authenticating user...", "info");
                
                let final_pass = custom_password.or(password);
                let saved_pass_for_sudo = final_pass.clone();
                
                let mut auth_res = if let Some((private_key, passphrase)) = key_data {
                    emit_log("Attempting Private Key Authentication...", "info");
                    let normalized_key = private_key.replace("\r\n", "\n");
                    match russh_keys::decode_secret_key(&normalized_key, passphrase.as_deref()) {
                        Ok(keypair) => {
                            let key_arc = std::sync::Arc::new(keypair);
                            session.authenticate_publickey(&effective_user, key_arc).await
                        }
                        Err(e) => {
                            // RSA private keys only work in builds that include the
                            // OpenSSL backend (release CI). Local debug builds skip
                            // OpenSSL to stay Perl-free, so surface a targeted hint
                            // instead of the raw "Unsupported key type rsa" string.
                            #[cfg(not(feature = "full-ssh-algos"))]
                            {
                                let err_str = e.to_string();
                                if err_str.contains("Unsupported key type rsa")
                                    || err_str.contains("rsa")
                                    || private_key.contains("RSA PRIVATE KEY")
                                {
                                    emit_log("RSA private keys aren't supported in this debug build — use Ed25519 for local testing, or grab a release build from GitHub for full RSA support.", "error");
                                }
                            }
                            emit_log(&format!("Failed to parse private key: {}", e), "error");
                            Err(russh::Error::from(std::io::Error::new(
                                std::io::ErrorKind::InvalidData,
                                e.to_string(),
                            )))
                        }
                    }
                } else if let Some(pass) = final_pass {
                    emit_log("Attempting Password Authentication...", "info");
                    session.authenticate_password(&effective_user, pass).await
                } else {
                    emit_log("Neither private key nor password auth credentials provided.", "error");
                    Ok(false)
                };

                // Keyboard-interactive (2FA / verification-code) fallback. Many
                // hardened servers gate login behind an interactive one-time
                // code AFTER — or INSTEAD of — a password. If the primary
                // attempt above didn't already authenticate us and the server
                // offers keyboard-interactive, drive it: relay each prompt to
                // the UI, collect the user's answers, and send them back. If
                // the server doesn't offer it, `run_keyboard_interactive`
                // returns None and we keep the original auth result untouched.
                if allow_kbi && !matches!(auth_res, Ok(true)) {
                    if let Some(kbi_res) = run_keyboard_interactive(
                        &mut session,
                        &effective_user,
                        &app,
                        &session_id_clone,
                        &connect_nonce,
                        &kbi_txs_clone,
                    )
                    .await
                    {
                        auth_res = kbi_res;
                    }
                }

                match auth_res {
                    Ok(true) => {
                        let session_arc = Arc::new(Mutex::new(session));
                        // "Still wanted?" registration guard. The handshake can
                        // take up to ~15s (longer via proxy/jump). If, meanwhile,
                        // a reconnect for this key bumped the generation or a
                        // disconnect/teardown swept it (both of which bump the
                        // generation BEFORE removing the connection), registering
                        // now would create a ZOMBIE: a live SSH connection with a
                        // watcher that immediately exits on the generation
                        // mismatch, plus — for ::fwd — tunnels migrated onto a
                        // connection nobody tracks. Do the check and the insert
                        // TOGETHER under the generation lock so a concurrent
                        // teardown can't interleave: we either observe the newer
                        // generation and bail, or insert first and the teardown's
                        // later connection-remove reaps us.
                        let registered = {
                            let g = state_session_generation.lock().await;
                            if g.get(&session_id_clone).copied().unwrap_or(0) == connect_generation {
                                state_connections
                                    .lock()
                                    .await
                                    .insert(session_id_clone.clone(), Arc::clone(&session_arc));
                                if let Some(ref p) = saved_pass_for_sudo {
                                    state_session_passwords
                                        .lock()
                                        .await
                                        .insert(session_id_clone.clone(), p.clone());
                                }
                                true
                            } else {
                                false
                            }
                        };
                        if !registered {
                            emit_log("Connection superseded before it was ready — dropping it.", "info");
                            // `session_arc` drops here, closing the transport.
                            // The FpCleanupGuard's Drop still clears the nonce.
                            return;
                        }
                        emit_log("Authentication successful. Session ready.", "success");
                        // A dedicated `::sftp` transport just came up — drop the
                        // base session's cached SFTP subsystem (it rides the
                        // primary). The next file operation re-opens on this
                        // dedicated connection via get_sftp_session's
                        // transport preference. Live migration, no re-keying.
                        if let Some(base) = session_id_clone.strip_suffix("::sftp") {
                            state_sftp_sessions.lock().await.remove(base);
                        }
                        // ProxyJump: now that the target session is live, park
                        // the bastion's Handle so it stays alive for the whole
                        // session (its direct-tcpip channel carries our
                        // transport). Dropped on reconnect / disconnect / close.
                        if let Some(jh) = jump_handle_holder.take() {
                            state_jump_connections.lock().await.insert(session_id_clone.clone(), jh);
                        }
                        let _ = app.emit(
                            &format!("connection-success-{}", session_id_clone),
                            serde_json::json!({}),
                        );

                        // Separate-sessions topology: in shared mode the primary
                        // owns the saved tunnels; in separate mode the dedicated
                        // `::fwd` connection owns them (it re-enters this same
                        // block under its own suffixed session id, so the tunnels
                        // are tagged/keyed against `::fwd` and ride that handle).
                        // `start_tunnels_inline` is false for the `::sftp`
                        // connection and for the primary when `separate` is on.
                        if start_tunnels_inline {
                        // Auto-start every tunnel attached to this session.
                        // Source of truth is the in-memory `session_tunnel_specs`
                        // map, which carries both the DB-saved rules AND any
                        // ad-hoc tunnels the user opened during the previous
                        // session lifetime. On first connect it's empty, so
                        // we seed it from the DB row's `tunnels` JSON.
                        let specs_to_start: Vec<tunnel::TunnelSpec> = {
                            let mut map = state_session_tunnel_specs.lock().await;
                            // A PRESENT replay list — even an empty one — is
                            // authoritative, exactly as in the ::fwd branch below
                            // and in restart_session_tunnels. An empty list means
                            // the user stopped every tunnel; only an ABSENT key is
                            // a genuine first engagement worth seeding from the
                            // node's saved rules. Treating empty as "unset" here
                            // meant every reconnect — including the health
                            // watcher's automatic one — silently reopened local
                            // listeners the user had deliberately closed.
                            match map.get(&session_id_clone).cloned() {
                                Some(existing) => existing,
                                None => match serde_json::from_str::<Vec<tunnel::TunnelSpec>>(&tunnels_json) {
                                    Ok(db_specs) => {
                                        map.insert(session_id_clone.clone(), db_specs.clone());
                                        db_specs
                                    }
                                    Err(e) => {
                                        emit_log(&format!("Tunnels JSON parse error: {}", e), "error");
                                        Vec::new()
                                    }
                                }
                            }
                        };
                        for spec in &specs_to_start {
                            let started = tunnel::start_tunnel(
                                app.clone(),
                                session_id_clone.clone(),
                                Arc::clone(&session_arc),
                                Arc::clone(&state_tunnels),
                                Arc::clone(&session_forwarded_targets),
                                spec.clone(),
                            ).await;
                            match started {
                                Ok(id) => emit_log(
                                    &format!("Tunnel started [{}]: {} {}", id, spec.kind, spec.local),
                                    "info",
                                ),
                                Err(e) => {
                                    // KEEP the spec in the replay list on failure
                                    // so the NEXT reconnect retries it. Stripping
                                    // it here (the old behaviour) turned a
                                    // transient rebind race on a flaky network —
                                    // a momentary AddrInUse while the previous
                                    // listener finished releasing the port — into
                                    // permanent loss of the tunnel until the user
                                    // manually restarted it. bind_with_retry now
                                    // absorbs that race; anything still failing is
                                    // logged and retried on the next reconnect
                                    // rather than silently dropped.
                                    emit_log(
                                        &format!("Tunnel start failed ({} {}): {} — will retry on next reconnect", spec.kind, spec.local, e),
                                        "error",
                                    );
                                }
                            }
                        }
                        } // end if start_tunnels_inline

                        // Dedicated `::fwd` transport: MIGRATE the session's
                        // tunnels onto this fresh connection. Stop whatever is
                        // running under the base tag (riding the primary, or a
                        // previous dead `::fwd`) so re-binding the same local
                        // ports can't conflict, then start the full replay
                        // list — seeded from the node's saved tunnels on first
                        // engagement — on this handle, still tagged under the
                        // BASE session id so the Tunnels panel / list / events
                        // never re-key. This runs on fresh connects, live
                        // toggle-on, the reconnect button, and auto-retry.
                        if role == "forward" {
                            let base = session_id_clone
                                .strip_suffix("::fwd")
                                .unwrap_or(&session_id_clone)
                                .to_string();
                            tunnel::stop_all_for_session(&state_tunnels, &base).await;
                            let specs: Vec<tunnel::TunnelSpec> = {
                                let mut map = state_session_tunnel_specs.lock().await;
                                // A PRESENT replay list — even an empty one — is
                                // authoritative: the session is already engaged
                                // and an empty list means the user stopped every
                                // tunnel. Only seed from the node's saved tunnels
                                // when the key is ABSENT (genuine first
                                // engagement) — otherwise stopped tunnels would
                                // resurrect on every ::fwd reconnect / toggle.
                                match map.get(&base).cloned() {
                                    Some(existing) => existing,
                                    None => match serde_json::from_str::<Vec<tunnel::TunnelSpec>>(&tunnels_json) {
                                        Ok(db_specs) => {
                                            if !db_specs.is_empty() {
                                                map.insert(base.clone(), db_specs.clone());
                                            }
                                            db_specs
                                        }
                                        Err(e) => {
                                            emit_log(&format!("Tunnels JSON parse error: {}", e), "error");
                                            Vec::new()
                                        }
                                    },
                                }
                            };
                            if !specs.is_empty() {
                                emit_log("Dedicated forwarding connection ready — moving tunnels onto it.", "info");
                                start_tunnel_specs_on(
                                    &app,
                                    &base,
                                    &session_arc,
                                    &session_forwarded_targets,
                                    &state_tunnels,
                                    &state_session_tunnel_specs,
                                    specs,
                                )
                                .await;
                            }
                        }

                        // Health watcher: polls the SSH handle every 5s. If
                        // `is_closed()` flips to true while the session is
                        // still registered (i.e. the user did NOT call
                        // disconnect_session explicitly), we fire a
                        // `session-disconnected-{id}` event so the UI can lock
                        // down the terminal/SFTP and show a reconnect prompt.
                        // An explicit disconnect removes the map entry, which
                        // the watcher detects and exits silently — no event.
                        let app_w = app.clone();
                        let sid_w = session_id_clone.clone();
                        let state_w = Arc::clone(&state_connections);
                        let state_sftp_w = Arc::clone(&state_sftp_sessions);
                        let state_gen_w = Arc::clone(&state_session_generation);
                        let state_tunnels_w = Arc::clone(&state_tunnels);
                        let state_mirrors_w: MirrorMap = mirrors_owned.clone();
                        // Captured so the watcher can periodically re-attempt a
                        // configured tunnel that failed to bind while the session
                        // stays alive (see the retry block in the loop below).
                        let state_specs_w = Arc::clone(&state_session_tunnel_specs);
                        let targets_w = Arc::clone(&session_forwarded_targets);
                        let my_gen = connect_generation;
                        tauri::async_runtime::spawn(async move {
                            // Two-tier liveness check:
                            //   - Every 2s: cheap is_closed() poll. Catches TCP
                            //     RST / FIN, russh's own teardown, AND — now that
                            //     the transport socket carries OS TCP keepalive
                            //     (see apply_tcp_keepalive) — kernel-detected
                            //     dead peers during long idle.
                            //   - Slow active probe: open a tiny SSH channel to
                            //     force a real round-trip, catching black-holes
                            //     the kernel hasn't flagged yet. Primary every
                            //     ~30s, dedicated `::sftp`/`::fwd` secondaries
                            //     every ~60s (they matter less urgently and the
                            //     probes multiply per-session overhead).
                            //     TWO consecutive probe failures are required
                            //     before declaring death: on poor networks a
                            //     single 10s latency spike is common, and the
                            //     old one-strike/5s-timeout probe tore down
                            //     perfectly recoverable sessions — the exact
                            //     opposite of what a flaky link needs.
                            let probe_every: u32 = if sid_w.contains("::") { 30 } else { 15 };
                            let mut tick: u32 = 0;
                            let mut probe_strikes: u8 = 0;
                            loop {
                                tokio::time::sleep(Duration::from_secs(2)).await;
                                tick = tick.wrapping_add(1);

                                // Generation guard: a reconnect under the same
                                // session_id bumps the counter. If we observe a
                                // newer value here, a fresh watcher has already
                                // taken over — bow out silently so we don't
                                // double-emit `session-disconnected-{id}`.
                                {
                                    let g = state_gen_w.lock().await;
                                    if g.get(&sid_w).copied().unwrap_or(0) != my_gen {
                                        break;
                                    }
                                }

                                let handle_opt = {
                                    let conns = state_w.lock().await;
                                    conns.get(&sid_w).cloned()
                                };
                                let handle_arc = match handle_opt {
                                    Some(h) => h,
                                    None => break, // explicit disconnect — quiet
                                };

                                let is_closed = {
                                    let h = handle_arc.lock().await;
                                    h.is_closed()
                                };

                                let mut dead = is_closed;

                                if !dead && tick % probe_every == 0 {
                                    // Active probe: hold the handle lock long
                                    // enough to start AND finish the round
                                    // trip — concurrent commands wait, but
                                    // that's fine, they would block on the
                                    // same lock to open their own channel
                                    // anyway. 10s timeout: generous enough
                                    // that a congested-but-alive link doesn't
                                    // strike out spuriously.
                                    let probe = {
                                        let h = handle_arc.lock().await;
                                        tokio::time::timeout(
                                            Duration::from_secs(10),
                                            h.channel_open_session(),
                                        ).await
                                    };
                                    match probe {
                                        Ok(Ok(ch)) => {
                                            probe_strikes = 0;
                                            // Close cleanly so the server
                                            // doesn't log a stuck session.
                                            let _ = ch.close().await;
                                        }
                                        _ => {
                                            probe_strikes += 1;
                                            if probe_strikes >= 2 {
                                                dead = true;
                                            } else {
                                                // One strike: re-probe on the
                                                // next 2s tick instead of a
                                                // full interval away, so a
                                                // real death still surfaces
                                                // promptly.
                                                tick = probe_every.wrapping_sub(1);
                                            }
                                        }
                                    }
                                }

                                // While the session is ALIVE, periodically re-attempt
                                // any configured tunnel that isn't currently running.
                                // A listener that failed to bind (its local port was
                                // briefly taken) otherwise stays dead until the user
                                // closes and reopens the tab — nothing retries it
                                // without a full reconnect. `start_tunnel_specs_on`
                                // skips specs already running (anywhere under this
                                // session), so this is a no-op once everything is up
                                // and can't create duplicates. Gated to the primary
                                // session id: the dedicated `::fwd`/`::sftp`
                                // transports have their own migration/restore paths,
                                // and the primary handle is the correct transport for
                                // the default (shared) topology. Spawned so a slow
                                // bind retry never delays death detection.
                                if !dead && tick % 30 == 0 && !sid_w.contains("::") {
                                    let specs = state_specs_w.lock().await.get(&sid_w).cloned().unwrap_or_default();
                                    if !specs.is_empty() {
                                        let app_r = app_w.clone();
                                        let sid_r = sid_w.clone();
                                        let handle_r = Arc::clone(&handle_arc);
                                        let targets_r = Arc::clone(&targets_w);
                                        let tunnels_r = Arc::clone(&state_tunnels_w);
                                        let specs_r = Arc::clone(&state_specs_w);
                                        tauri::async_runtime::spawn(async move {
                                            start_tunnel_specs_on(&app_r, &sid_r, &handle_r, &targets_r, &tunnels_r, &specs_r, specs).await;
                                        });
                                    }
                                }

                                if dead {
                                    // Re-check generation + verify OUR handle is
                                    // still the registered one before tearing
                                    // anything down. A slow probe holds the handle
                                    // lock up to 10s; during that window a manual
                                    // reconnect / auto-retry can bump the
                                    // generation and register a fresh, healthy
                                    // connection. Without this guard we'd remove
                                    // that NEW connection and kill its just-
                                    // migrated tunnels. Bail silently on mismatch.
                                    {
                                        let g = state_gen_w.lock().await;
                                        if g.get(&sid_w).copied().unwrap_or(0) != my_gen {
                                            break;
                                        }
                                    }
                                    // Compare-and-remove: only drop the map entry
                                    // if it's still OUR handle (Arc identity).
                                    {
                                        let mut conns = state_w.lock().await;
                                        match conns.get(&sid_w) {
                                            Some(cur) if Arc::ptr_eq(cur, &handle_arc) => { conns.remove(&sid_w); }
                                            _ => break, // superseded by a fresh connection — leave it be
                                        }
                                    }
                                    state_sftp_w.lock().await.remove(&sid_w);
                                    // Tear down all tunnels bound to this
                                    // session so their listeners release the
                                    // local ports + bridge tasks exit. Without
                                    // this, the listeners stayed up holding
                                    // the now-dead Arc<Handle>, and stop_tunnel
                                    // calls during reconnect raced with the
                                    // replay logic. This is the single
                                    // authoritative SSH-death tunnel-teardown
                                    // path; the listener tasks themselves no
                                    // longer probe the handle.
                                    tunnel::stop_all_for_session(&state_tunnels_w, &sid_w).await;
                                    // Dedicated-transport death: tunnels are
                                    // tagged under the BASE session id but ride
                                    // this `::fwd` connection — stop them so
                                    // their listeners release; the frontend's
                                    // auto-retry either brings the transport
                                    // back (migration restarts them on it) or
                                    // falls back to the primary. Same for the
                                    // base SFTP cache riding a dead `::sftp`.
                                    if let Some(base) = sid_w.strip_suffix("::fwd") {
                                        tunnel::stop_all_for_session(&state_tunnels_w, base).await;
                                    }
                                    if let Some(base) = sid_w.strip_suffix("::sftp") {
                                        state_sftp_w.lock().await.remove(base);
                                    }
                                    // Stop any mirrors bound to this session too — otherwise the
                                    // mirror worker keeps its own Arc<SftpSession> pointing at
                                    // this dead handle and hammers upload-fail on every future
                                    // FS event until the app is quit.
                                    mirror::stop_all_for_session(&state_mirrors_w, &sid_w).await;
                                    let _ = app_w.emit(
                                        &format!("session-disconnected-{}", sid_w),
                                        serde_json::json!({
                                            "reason": "Connection lost"
                                        }),
                                    );
                                    break;
                                }
                            }
                        });
                    },
                    Ok(false) => {
                        // Server reached the auth phase and explicitly told
                        // us "no". This is the only branch that maps to a
                        // real auth failure — everything else gets routed
                        // through `classify_russh_error` so a network drop
                        // or host-key timeout never gets relabelled as one.
                        emit_log("Authentication rejected by server.", "error");
                        let _ = app.emit(
                            &format!("connection-failed-{}", session_id_clone),
                            serde_json::json!({
                                "reason": "Authentication rejected by server (wrong password, missing key, or account locked).",
                                "is_auth_error": true,
                            }),
                        );
                    },
                    Err(e) => {
                        let kind = classify_russh_error(&e);
                        let target = format!("{}:{}", host, port);
                        let reason = describe_error_kind(kind, &target);
                        emit_log(&format!("{} (raw: {})", reason, e), "error");
                        let _ = app.emit(
                            &format!("connection-failed-{}", session_id_clone),
                            serde_json::json!({
                                "reason": reason,
                                "is_auth_error": kind.is_auth(),
                            }),
                        );
                    }
                }
            },
            Ok(Err(e)) => {
                // Connect-stream failed AFTER the TCP socket opened — most
                // commonly this is the host-key flow ending in either a
                // declined fingerprint or a timed-out prompt. Read the
                // outcome the handler stashed and surface a precise reason
                // instead of letting it ride the generic transport bucket.
                use std::sync::atomic::Ordering;
                let fp = fp_outcome_for_driver.load(Ordering::SeqCst);
                let (reason, kind) = match fp {
                    2 => (
                        "Host key prompt timed out — Reconnect and approve the fingerprint within 90 seconds.".to_string(),
                        ConnectErrorKind::HostKey,
                    ),
                    0 => (
                        "Host key was not approved. Reconnect to see the fingerprint prompt again.".to_string(),
                        ConnectErrorKind::HostKey,
                    ),
                    _ => {
                        let kind = classify_russh_error(&e);
                        let target = format!("{}:{}", host, port);
                        (describe_error_kind(kind, &target), kind)
                    }
                };
                emit_log(&format!("{} (raw: {})", reason, e), "error");
                let _ = app.emit(
                    &format!("connection-failed-{}", session_id_clone),
                    serde_json::json!({
                        "reason": reason,
                        "is_auth_error": kind.is_auth(),
                    }),
                );
            },
            Err(_) => {
                // 15s wall-clock on connect_stream — the TCP socket is up
                // but the SSH handshake never completed. Distinct enough
                // from the auth path to deserve its own message.
                let msg = format!(
                    "{}:{} did not finish SSH handshake within 15 seconds — host may be filtering SSH or running a non-SSH service on this port.",
                    host, port
                );
                emit_log(&msg, "error");
                let _ = app.emit(
                    &format!("connection-failed-{}", session_id_clone),
                    serde_json::json!({
                        "reason": msg,
                        "is_auth_error": false,
                    }),
                );
            }
        }

        cleanup().await;
    });
    
    Ok(())
}

/// Frontend acknowledgement of the SSH host-key prompt. The `nonce` must
/// match the value the matching `fingerprint-prompt-{session_id}` event
/// carried — without that match the response is dropped on the floor. Any
/// stale "accept" from a previous attempt cannot satisfy a fresh prompt.
#[tauri::command]
async fn verify_fingerprint_response(
    state: tauri::State<'_, SshState>,
    nonce: String,
    accepted: bool,
) -> Result<(), String> {
    if let Some(tx) = state.fp_txs.lock().await.remove(&nonce) {
        let _ = tx.send(accepted);
    }
    Ok(())
}

/// Frontend callback for a keyboard-interactive (2FA / verification-code)
/// prompt. `responses` is `Some(answers)` when the user submits, or `None`
/// when they cancel. Mirrors `verify_fingerprint_response`: the nonce binds
/// the answer 1:1 to the connect attempt that emitted the prompt, and a nonce
/// with no in-flight entry is silently a no-op (stale / forged responses can't
/// satisfy a fresh prompt).
#[tauri::command]
async fn submit_kbi_response(
    state: tauri::State<'_, SshState>,
    nonce: String,
    responses: Option<Vec<String>>,
) -> Result<(), String> {
    if let Some(tx) = state.kbi_txs.lock().await.remove(&nonce) {
        let _ = tx.send(responses);
    }
    Ok(())
}

#[tauri::command]
async fn disconnect_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    mirrors: tauri::State<'_, MirrorMap>,
    session_id: String,
) -> Result<(), String> {
    // Invalidate any connect worker still handshaking for THIS key: bump the
    // generation before removing anything, so a late auth-success hits its
    // "still wanted?" guard and drops instead of re-registering a transport the
    // user just turned off (which would then steal / strand tunnels). Done for
    // every key, including secondaries — this is the toggle-off / reconnect-
    // button invalidation path.
    {
        let mut g = state.session_generation.lock().await;
        let next = g.get(&session_id).copied().unwrap_or(0).wrapping_add(1);
        g.insert(session_id.clone(), next);
    }
    // Disconnecting a dedicated transport directly (toggle-off / reconnect
    // button): tunnels are tagged under the BASE session id but ride this
    // `::fwd` connection. Stop them ONLY when the dedicated connection actually
    // exists — i.e. the tunnels really are riding it. If it's absent (a failed
    // `::fwd` that never registered, so the tunnels fell back to the primary),
    // stopping base-tagged tunnels here would needlessly bounce every live
    // primary tunnel. The caller restarts them on the best transport via
    // restart_session_tunnels afterwards.
    if let Some(base) = session_id.strip_suffix("::fwd") {
        if state.connections.lock().await.contains_key(&session_id) {
            tunnel::stop_all_for_session(&state.tunnels, base).await;
        }
    }
    // `::sftp`: remove the dedicated transport FIRST, then purge the base SFTP
    // cache — so an SFTP op racing this teardown can't re-cache a subsystem on
    // the dying transport after the purge (get_sftp_session's still-current
    // check would then see the transport gone and refuse to cache).
    if session_id.ends_with("::sftp") {
        state.connections.lock().await.remove(&session_id);
        if let Some(base) = session_id.strip_suffix("::sftp") {
            state.sftp_sessions.lock().await.remove(base);
        }
    }
    // Stop all forwarders so their listener sockets are released before the
    // SSH handle is dropped (otherwise newly-incoming connections would just
    // bounce off a dead channel).
    tunnel::stop_all_for_session(&state.tunnels, &session_id).await;
    state.forwarded_targets.lock().await.remove(&session_id);
    // Explicit user disconnect — drop the replay list too. (Auto-reconnect
    // calls `initiate_connection` directly and never hits this path, so
    // those tunnels survive the cycle.)
    state.session_tunnel_specs.lock().await.remove(&session_id);
    // Same idea for any mirror that's still running — its watcher would
    // try to push uploads through a dead SSH handle otherwise.
    mirror::stop_all_for_session(&mirrors, &session_id).await;
    // Drop SFTP first so the channel it holds is freed before we tear down the
    // underlying SSH handle.
    state.sftp_sessions.lock().await.remove(&session_id);
    state.connections.lock().await.remove(&session_id);
    state.session_passwords.lock().await.remove(&session_id);
    // Drop any ProxyJump bastion handle for this session — closes the jump
    // connection once the target it was carrying is gone.
    state.jump_connections.lock().await.remove(&session_id);
    // Drop terminal tx/resize entries so a subsequent reconnect doesn't try
    // to write into a dead PTY task. Match by the exact `${session_id}-term-`
    // prefix — a `contains` here silently tears down session-10's terminals
    // when the user disconnects session-1.
    let term_prefix = format!("{}-term-", session_id);
    state.terminal_txs.lock().await.retain(|k, _| !k.starts_with(&term_prefix));
    state.resize_txs.lock().await.retain(|k, _| !k.starts_with(&term_prefix));
    // Wipe any temp files this session left behind (live-edit downloads + drag
    // staging). Best-effort: failures are usually because an editor still holds
    // a lock on a file, in which case the file persists until the OS cleans temp.
    let session_temp_dir = session_sftp_dir(&session_id);
    if session_temp_dir.exists() {
        let _ = std::fs::remove_dir_all(&session_temp_dir);
    }
    let session_drag = session_drag_dir(&session_id);
    if session_drag.exists() {
        let _ = std::fs::remove_dir_all(&session_drag);
    }
    // Separate-sessions: reap the dedicated `::sftp` / `::fwd` secondaries so an
    // explicit primary disconnect doesn't leak their SSH sessions. Only when
    // this IS a primary id (no `::` suffix) — a direct disconnect of a secondary
    // must not recurse into non-existent grandchildren.
    if !session_id.contains("::") {
        teardown_connection_key(state.inner(), mirrors.inner(), &format!("{}::sftp", session_id)).await;
        teardown_connection_key(state.inner(), mirrors.inner(), &format!("{}::fwd", session_id)).await;
    }
    // Tell the UI so the tab status dot flips to red. `user_initiated` keeps
    // SessionView from kicking off an auto-reconnect cycle for an intentional
    // disconnect — distinct from the watcher path which has no such flag.
    use tauri::Emitter;
    let _ = app.emit(
        &format!("session-disconnected-{}", session_id),
        serde_json::json!({
            "reason": "User disconnected",
            "user_initiated": true,
        }),
    );
    Ok(())
}

/// Bucket the failure modes that can come out of an SSH connect / auth round.
/// Drives both the UI's `is_auth_error` flag (so auto-reconnect only stops
/// on real credential rejection) and the wording of the error message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectErrorKind {
    /// Server refused the credentials we presented.
    Auth,
    /// Couldn't agree on KEX / cipher / MAC / host-key algorithm with the
    /// peer. Server is reachable, our crypto preference set doesn't overlap.
    Algorithm,
    /// Host key issue — mismatched, declined by the user, or the prompt
    /// timed out. Distinct from auth: credentials never even got tried.
    HostKey,
    /// Transport-level drop: TCP reset, EOF, peer disconnect, IO error.
    Transport,
    /// Server didn't respond inside our window (handshake / auth / probe).
    Timeout,
    /// We couldn't even reach the box: DNS lookup failed, route missing,
    /// connection refused.
    Unreachable,
    /// Anything russh surfaced that we don't have a categorical bucket for.
    /// Treated as non-auth so the UI keeps trying — a real credential
    /// rejection has a specific variant for it.
    Unknown,
}

impl ConnectErrorKind {
    fn is_auth(self) -> bool {
        matches!(self, Self::Auth)
    }
}

/// Map a russh error onto a `ConnectErrorKind`. Uses enum variants when the
/// information is available (russh 0.40 exposes them all), falling back to
/// a string sniff only for the catch-all `_ =>` branch — so a russh upgrade
/// that adds new variants degrades gracefully instead of misreporting them
/// as auth failures.
fn classify_russh_error(e: &russh::Error) -> ConnectErrorKind {
    use russh::Error::*;
    match e {
        // Real credential rejection — the only path that should set
        // is_auth_error so the UI stops auto-retrying.
        NotAuthenticated | NoAuthMethod => ConnectErrorKind::Auth,

        // Algorithm negotiation — server's reachable, we just don't share
        // the cipher / KEX / etc. it asked for.
        NoCommonCipher | NoCommonKexAlgo | NoCommonKeyAlgo
        | NoCommonCompression | NoCommonMac
        | UnknownAlgo | UnknownKey => ConnectErrorKind::Algorithm,

        // Host-key flow: the server's signature didn't verify. KeyChanged
        // carries data so it falls through to the catch-all branch which
        // sniffs the string.
        WrongServerSig => ConnectErrorKind::HostKey,

        // Transport-level: connection died mid-protocol.
        IO(_) | HUP | Disconnect | SendError => ConnectErrorKind::Transport,

        // Explicit timeouts from russh.
        ConnectionTimeout | Elapsed(_) => ConnectErrorKind::Timeout,

        // Protocol disagreements that aren't algorithm- or auth-shaped:
        // version skew, packet integrity, decryption — surface as transport
        // so the user is told "connection broke" not "password wrong".
        // `StrictKeyExchangeViolation` / `ChannelOpenFailure` carry data;
        // the `_ =>` fallthrough handles those via the string sniff below.
        Version | Kex | PacketAuth | Inconsistent | IndexOutOfBounds
        | DecryptionError | KexInit
        | WrongChannel | Pending => ConnectErrorKind::Transport,

        // Key-file problems (local cert can't be parsed). Tag as Auth-shaped
        // so the UI doesn't auto-retry a key that will keep failing.
        CouldNotReadKey | Keys(_) => ConnectErrorKind::Auth,

        // Last-resort string sniff for anything russh adds in future
        // versions or for io::Error subtypes the explicit arms above
        // missed. Default to Unknown which the driver treats as non-auth.
        _ => {
            let lc = e.to_string().to_lowercase();
            if lc.contains("connection refused")
                || lc.contains("no route")
                || lc.contains("network is unreachable")
                || lc.contains("dns")
            {
                ConnectErrorKind::Unreachable
            } else if lc.contains("timed out") || lc.contains("timeout") {
                ConnectErrorKind::Timeout
            } else if lc.contains("io error") || lc.contains("eof")
                || lc.contains("disconnect") || lc.contains("reset")
                || lc.contains("broken pipe") || lc.contains("aborted")
            {
                ConnectErrorKind::Transport
            } else if lc.contains("not authenticated") || lc.contains("auth method") {
                ConnectErrorKind::Auth
            } else {
                ConnectErrorKind::Unknown
            }
        }
    }
}

/// Human-readable phrase for an error bucket. Combined with `target` to
/// build the reason string the UI shows next to a failed connection.
fn describe_error_kind(kind: ConnectErrorKind, target: &str) -> String {
    match kind {
        ConnectErrorKind::Auth =>
            "Authentication rejected by server (wrong password, missing key, or account locked).".into(),
        ConnectErrorKind::Algorithm =>
            format!("Negotiation with {} failed: no SSH algorithm in common (this build might be missing legacy ciphers — try the release build).", target),
        ConnectErrorKind::HostKey =>
            "Host key was not approved (wrong key, declined, or the fingerprint prompt timed out).".into(),
        ConnectErrorKind::Transport =>
            format!("Connection to {} dropped mid-handshake.", target),
        ConnectErrorKind::Timeout =>
            format!("{} did not respond in time.", target),
        ConnectErrorKind::Unreachable =>
            format!("Could not reach {} (DNS lookup, route, or port refusal).", target),
        ConnectErrorKind::Unknown =>
            format!("Connection to {} failed for an unrecognised reason.", target),
    }
}

/// Translate raw socket / SSH error messages into something a human can act
/// on. Most russh / tokio errors come out as "tcp: io error: ..." with the
/// useful detail buried — this lifts the common cases up to a clear sentence
/// while still falling back to the original text for anything unfamiliar.
fn humanize_network_err(raw: &str, host: &str, port: i32, label: &str) -> String {
    let lower = raw.to_lowercase();
    let target = if port > 0 { format!("{}:{}", host, port) } else { host.to_string() };

    if lower.contains("connection refused") {
        return format!("{}: {} refused the connection (is the SSH server running on this port?)", label, target);
    }
    if lower.contains("network is unreachable") || lower.contains("network unreachable") {
        return format!("{}: network is unreachable — check VPN / firewall / internet", label);
    }
    if lower.contains("no route to host") {
        return format!("{}: no route to {} — host is down or blocked", label, target);
    }
    if lower.contains("name or service not known")
        || lower.contains("nodename nor servname")
        || lower.contains("failed to lookup address")
        || lower.contains("no such host")
        || lower.contains("dns")
    {
        return format!("{}: could not resolve hostname {}", label, host);
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return format!("{}: {} did not respond in time", label, target);
    }
    if lower.contains("connection reset") || lower.contains("broken pipe") {
        return format!("{}: {} closed the connection", label, target);
    }
    if lower.contains("permission denied") {
        return format!("{}: permission denied (check key file readability)", label);
    }
    // Fallback — keep the raw detail so power users can still see it.
    format!("{}: {}", label, raw)
}

pub(crate) use commands::sftp::{is_safe_dir_entry_name, session_drag_dir, session_sftp_dir};

/// Library entrypoint shared by both the desktop `bin/main.rs` shim and
/// Tauri's Android entry-point macro. Everything that builds the
/// `tauri::Builder`, registers plugins/state/commands, and finally calls
/// `.run(generate_context!())` lives here so the same binary contents
/// ship on both platforms — only the wrapping is different.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Tauri 2 on Linux embeds webkit2gtk-4.1. Two failure modes have to be
    // headed off before the WebKit child process spawns, because once it's
    // up the env it inherited is the only one it sees:
    //
    //   1. The DMA-BUF + EGL renderer that WebKit defaults to crashes with
    //      "EGL_BAD_PARAMETER … Aborting" / SIGABRT on Mesa ≥ 24 across
    //      most GPUs. Flipping it off forces the older GLES path.
    //      (WebKit #258834, tauri-apps/tauri#9304)
    //
    //   2. On Wayland sessions with Mesa ≥ 24 (Fedora 40+, KDE Plasma 6,
    //      GNOME 46+) the bundled webkit2gtk-4.1's eglGetDisplay() against
    //      a wl_display still aborts even with the DMA-BUF renderer off,
    //      because the bundled libwayland-egl ABI predates the host Mesa.
    //      Routing GTK through XWayland avoids the mismatched Wayland-EGL
    //      handshake entirely and keeps the app usable on every desktop.
    //      The trade-off is XWayland's slightly fuzzier HiDPI scaling,
    //      which is acceptable in exchange for "the app actually opens".
    //
    // Every override is gated on `var_os(...).is_none()` so power users
    // (or distros that ship a patched WebKit) can opt back in by exporting
    // the variable themselves before launching.
    #[cfg(target_os = "linux")]
    {
        // The single most effective override for the EGL_BAD_PARAMETER abort
        // seen on Fedora 40+ / Mesa 24+: tell WebKit not to attempt hardware
        // accelerated rendering AT ALL. The flag short-circuits the WebKit
        // codepath that calls eglGetDisplay(), which is the exact line that
        // SIGABRTs when the bundled libwayland-egl can't negotiate with the
        // host Mesa. Set before any of the more granular flags so it wins
        // on builds of WebKit that ignore the renderer-specific switches.
        if std::env::var_os("WEBKIT_DISABLE_HARDWARE_ACCELERATION").is_none() {
            std::env::set_var("WEBKIT_DISABLE_HARDWARE_ACCELERATION", "1");
        }
        // bwrap sandbox strips inherited env from WebKitWebProcess (Fedora's
        // SELinux-confined bwrap is the canonical offender) — the flags we
        // set in this block need to reach the render-process child or none
        // of the rendering overrides will fire.
        //
        // WebKit 2.42 renamed `WEBKIT_FORCE_SANDBOX=0` to
        // `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1` and the old name now
        // emits a warning ("no longer allows disabling the sandbox") instead
        // of actually disabling anything. We set BOTH so the override works
        // across the full WebKit version range we'll meet in the wild —
        // older WebKit picks up the legacy name, 2.42+ picks up the loud
        // one. Losing the sandbox boundary for the webview is acceptable
        // for a desktop app that already runs with the user's full
        // filesystem access; the security boundary that matters
        // (Tauri capabilities + strict CSP) is unaffected.
        if std::env::var_os("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS").is_none() {
            std::env::set_var("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1");
        }
        if std::env::var_os("WEBKIT_FORCE_SANDBOX").is_none() {
            std::env::set_var("WEBKIT_FORCE_SANDBOX", "0");
        }
        // Older-renderer + DMA-BUF flags stay as belt-and-braces — they
        // cost nothing on builds where WEBKIT_DISABLE_HARDWARE_ACCELERATION
        // already wins, and they cover the corner cases where a downstream
        // patched WebKit honours one but not the other.
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
        if std::env::var_os("GDK_BACKEND").is_none() {
            std::env::set_var("GDK_BACKEND", "x11");
        }
        // Mesa software rasteriser flag kept as the final fallback in case
        // WebKit's "no hardware" path still calls into Mesa somewhere.
        if std::env::var_os("LIBGL_ALWAYS_SOFTWARE").is_none() {
            std::env::set_var("LIBGL_ALWAYS_SOFTWARE", "1");
        }
    }

    let builder = tauri::Builder::default();
    // Save/restore the main window's last size + position to a JSON file
    // in app_data_dir. Keeps the user's preferred geometry across launches
    // without us having to wire setSize/setPosition by hand. Plain plugin —
    // it intercepts window events; no JS-facing commands to lock down.
    // Mobile builds skip this entirely: Android decides window geometry,
    // not us, and the plugin's crate isn't compiled into the Android target.
    #[cfg(not(target_os = "android"))]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    // Cross-platform URL opener — Android (Intent.ACTION_VIEW), Windows
    // (start), macOS (open), Linux (xdg-open). about.rs's open_external_url
    // dispatches through this so the same code path works in the desktop
    // installer AND the Android APK. Capability is granted in default.json.
    let builder = builder.plugin(tauri_plugin_opener::init());
    builder
        .manage(DbState { conn: std::sync::Arc::new(StdMutex::new(None)), master_key: StdMutex::new(None), salt: StdMutex::new(None), db_path: StdMutex::new(None), active_profile: StdMutex::new(None), hlc: StdMutex::new(None), session_password: StdMutex::new(None) })
        .manage(SshState::new())
        // Docker live-log stream registry — keyed by frontend-issued stream id,
        // values are tokio AbortHandles so the user can stop tailing on demand.
        .manage(docker::DockerStreams::new())
        // Monitoring state is its own root-level Tauri-managed value, separate
        // from SshState — monitors and interactive sessions own different SSH
        // handles per node and don't share lifecycle.
        .manage::<MonitorMap>(std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())))
        // Mirror tasks live under their own root-managed map — keyed by mirror
        // id, populated by `start_mirror`, drained by the spawned worker on
        // exit. Session teardown calls `mirror::stop_all_for_session` to make
        // sure no orphan watcher is left running after the SSH handle dies.
        .manage::<MirrorMap>(std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())))
        // Global monitor settings live in one shared Arc<Mutex>. Pollers
        // read it at the start of every cycle so interval/threshold changes
        // are hot-applied without restarting any monitor.
        .manage::<SharedSettings>(std::sync::Arc::new(tokio::sync::Mutex::new(monitor::MonitorSettings::default())))
        // CloudState needs the AppHandle to find app_data_dir on construction
        // (to load any persisted bearer token). Setup is the earliest hook we
        // get an AppHandle, so initialise it there and `manage` it for commands.
        .setup(|app| {
            cloud_config::init(&app.handle());
            let cloud_state = cloud::CloudState::new(&app.handle());
            app.manage(cloud_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::profile::check_db_exists,
            commands::profile::setup_master_db,
            commands::profile::persist_vault,
            commands::profile::list_profiles,
            commands::profile::cloud_list_sync_profiles,
            commands::profile::cloud_delete_profile,
            commands::profile::force_push_profile,
            commands::profile::select_profile,
            commands::profile::create_profile,
            commands::profile::delete_profile,
            commands::profile::rename_profile,
            commands::profile::close_profile,
            commands::profile::prepare_switch_profile,
            commands::profile::has_session_password,
            commands::profile::switch_profile_seamless,
            commands::profile::get_profiles_sync_status,
            commands::profile::sync_profile_password,
            commands::profile::change_master_password,
            commands::profile::export_profile,
            commands::profile::import_profile_pick,
            commands::profile::import_profile_save,
            commands::profile::save_audit_log,
            cloud::cloud_set_api_base, cloud::cloud_status, cloud::cloud_signup, cloud::cloud_consume_verify_link,
            cloud::cloud_set_password, cloud::cloud_login, cloud::cloud_logout,
            cloud::cloud_request_password_reset, cloud::cloud_reset_password,
            cloud::cloud_request_login_link, cloud::cloud_login_with_link,
            cloud_config::cloud_get_server, cloud_config::cloud_set_server,
            commands::sync::sync_now,
            commands::sync::identity_status,
            commands::sync::setup_identity,
            commands::sync::reset_identity,
            commands::sync::share_current_profile,
            commands::sync::invite_to_share,
            commands::sync::list_shares,
            commands::sync::share_member_list,
            commands::sync::accept_share,
            commands::sync::import_shared_profile,
            commands::sync::restore_personal_profile,
            commands::sync::share_set_role,
            commands::sync::share_revoke,
            commands::sync::share_leave,
            commands::sync::share_delete,
            commands::sync::profile_share_status,
            commands::sync::stop_sharing,
            commands::sync::profile_sync_stats,
            commands::sync::set_editor_label,
            commands::servers::add_server, commands::servers::save_quick_connect_node, commands::servers::edit_server, commands::servers::delete_server, commands::servers::add_mirror_to_server, commands::servers::get_servers, commands::servers::get_ssh_keys, commands::servers::set_server_color, commands::servers::set_folder_color, commands::servers::set_server_notes, commands::servers::set_server_run_on_connect, commands::servers::set_server_jump_host, commands::servers::set_server_is_production, commands::servers::set_server_icon, commands::servers::update_server_os_info, commands::servers::reorder_servers, commands::servers::clone_server, commands::servers::reveal_server_password, commands::servers::reveal_credential_password, commands::servers::reveal_ssh_key,
            commands::servers::get_credentials, commands::servers::generate_ssh_key,
            commands::servers::add_folder, commands::servers::rename_folder, commands::servers::delete_folder, commands::servers::get_folders,
            commands::servers::add_command, commands::servers::edit_command, commands::servers::delete_command, commands::servers::get_commands,
            commands::servers::cmd_history_add, commands::servers::cmd_history_list, commands::servers::cmd_history_clear,
            commands::servers::add_note, commands::servers::edit_note, commands::servers::delete_note, commands::servers::get_notes,
            commands::mirror::mirror_dry_run,
            commands::mirror::start_mirror,
            commands::mirror::stop_mirror,
            commands::mirror::list_mirrors,
            commands::mirror::pick_local_directory,
            commands::servers::add_credential, commands::servers::edit_credential, commands::servers::delete_credential,
            commands::servers::add_ssh_key, commands::servers::edit_ssh_key, commands::servers::delete_ssh_key,
            commands::profile::get_known_hosts,
            commands::profile::delete_known_host,
            commands::profile::clear_all_known_hosts,
            initiate_connection, verify_fingerprint_response, submit_kbi_response, disconnect_session,
            commands::tunnels::start_tunnel, commands::tunnels::stop_tunnel, commands::tunnels::list_tunnels, commands::tunnels::restart_session_tunnels, commands::tunnels::persist_session_tunnels,
            commands::terminal::open_terminal, commands::terminal::open_local_terminal, commands::terminal::get_available_local_shells, commands::terminal::write_terminal_data, commands::terminal::resize_terminal, commands::terminal::close_terminal,
            commands::diagnostics::ssh_info_probe_section,
            commands::diagnostics::ssh_systemctl_action,
            commands::diagnostics::ssh_kill_process,
            commands::diagnostics::detect_session_os,
            commands::diagnostics::ssh_iptables_chain,
            commands::diagnostics::ssh_nft_chain,
            docker::ssh_docker_container_action,
            docker::ssh_docker_inspect,
            docker::ssh_docker_stats,
            docker::ssh_docker_logs,
            docker::ssh_docker_logs_start,
            docker::ssh_docker_logs_stop,
            docker::ssh_docker_networks,
            docker::ssh_docker_containers,
            docker::ssh_docker_images_list,
            docker::ssh_docker_volumes_list,
            docker::ssh_docker_compose_list,
            docker::ssh_docker_compose_per_container,
            docker::ssh_docker_compose_services,
            docker::ssh_docker_compose_action,
            docker::ssh_docker_compose_view,
            docker::ssh_docker_prune,
            docker::open_container_terminal,
            commands::sftp::select_local_folder, commands::sftp::local_list_dir,
            commands::sftp::local_home_dir, commands::sftp::local_desktop_dir, commands::sftp::local_create_dir, commands::sftp::local_remove, commands::sftp::local_rename,
            commands::sftp::android_quick_dirs, commands::sftp::android_default_local_dir,
            commands::sftp::parse_ssh_config,
            commands::sftp::parse_client_import,
            commands::sftp::sftp_list_dir, commands::sftp::sftp_resolve_owners, commands::sftp::sftp_create_dir, commands::sftp::sftp_remove_file, commands::sftp::sftp_remove_dir,
            commands::sftp::sftp_rename, commands::sftp::sftp_set_permissions, commands::sftp::sftp_set_owner,
            commands::sftp::sftp_download_file, commands::sftp::sftp_download_dir, commands::sftp::sftp_upload_file, commands::sftp::sftp_upload_dir, commands::sftp::sftp_cancel_transfer, commands::sftp::sftp_open_remote_file,
            commands::sftp::sftp_read_file_text, commands::sftp::sftp_write_file_text, commands::sftp::local_read_file_text, commands::sftp::local_write_file_text, commands::sftp::sftp_exec_command,
            commands::sftp::local_open_file, commands::sftp::local_open_in_explorer, commands::sftp::sftp_prepare_drag,
            commands::sftp::local_copy_entry,
            commands::terminal::set_ssh_keepalive_interval,
            commands::network::send_wake_on_lan, commands::network::perform_port_knock,
            commands::network::probe_tcp_port, commands::network::batch_probe_ports,
            commands::monitor_settings::monitor_list,
            commands::monitor_settings::monitor_add,
            commands::monitor_settings::monitor_remove,
            commands::monitor_settings::monitor_set_metrics,
            commands::monitor_settings::monitor_set_custom_metrics,
            commands::monitor_settings::monitor_resume,
            commands::monitor_settings::monitor_pause,
            commands::monitor_settings::monitor_resume_all,
            commands::monitor_settings::monitor_pause_all,
            commands::monitor_settings::monitor_get_settings,
            commands::monitor_settings::monitor_set_settings,
            about::app_info, about::check_for_updates, about::open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_entry_name_rejects_traversal_and_separators() {
        // Attack vectors a hostile SFTP server can put in a readdir name.
        for bad in [
            "",
            ".",
            "..",
            "../../etc/passwd",
            "..\\..\\Startup\\x.bat",
            "a/b",
            "a\\b",
            "/etc/passwd",
            "with\0nul",
        ] {
            assert!(!is_safe_dir_entry_name(bad), "should reject {:?}", bad);
        }
    }

    #[test]
    fn dir_entry_name_accepts_plain_filenames() {
        // Legitimate names must still pass — including ones that merely
        // start with dots or contain colons/spaces (all legal on POSIX).
        for ok in [
            "file.txt",
            "notes 2024.md",
            ".bashrc",
            "..foo",
            "2024:01:01.log",
            "release-v0.2.37",
            "Ω_unicode_名前",
        ] {
            assert!(is_safe_dir_entry_name(ok), "should accept {:?}", ok);
        }
    }
}
