// Tauri side of the MCP server in crate::mcp: start/stop, the session list the
// front end keeps current, and the approval round trip for run_command.

use crate::mcp::{self, Action, SessionInfo};
use crate::ssh_manager::SshState;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
const EXEC_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Default)]
struct Inner {
    server: Option<(u16, tokio::task::JoinHandle<()>)>,
    sessions: Vec<SessionInfo>,
    pending: HashMap<String, oneshot::Sender<bool>>,
}

fn inner() -> &'static Mutex<Inner> {
    static INNER: OnceLock<Mutex<Inner>> = OnceLock::new();
    INNER.get_or_init(Default::default)
}

/// Listen on 127.0.0.1:`port`. Restarts if already running.
#[tauri::command]
pub async fn mcp_start(app: AppHandle, port: u16, token: String) -> Result<(), String> {
    if token.len() < 32 {
        return Err("Token too short".into());
    }
    mcp_stop();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("Could not listen on 127.0.0.1:{port}: {e}"))?;
    let token = Arc::new(token);
    let task = tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else { continue };
            tokio::spawn(serve(app.clone(), sock, token.clone()));
        }
    });
    inner().lock().map_err(|_| "[STATE] LOCK_FAILED")?.server = Some((port, task));
    Ok(())
}

#[tauri::command]
pub fn mcp_stop() {
    if let Ok(mut g) = inner().lock() {
        if let Some((_, task)) = g.server.take() {
            task.abort();
        }
        // Dropping the senders declines whatever is still waiting.
        g.pending.clear();
    }
}

/// The open SSH sessions an agent may see, with the names the user knows them by.
#[tauri::command]
pub fn mcp_set_sessions(sessions: Vec<SessionInfo>) {
    if let Ok(mut g) = inner().lock() {
        g.sessions = sessions;
    }
}

#[tauri::command]
pub fn mcp_answer(request_id: String, approved: bool) {
    if let Some(tx) = inner().lock().ok().and_then(|mut g| g.pending.remove(&request_id)) {
        let _ = tx.send(approved);
    }
}

async fn serve(app: AppHandle, mut sock: tokio::net::TcpStream, token: Arc<String>) {
    let req = match mcp::read_request(&mut sock).await {
        Ok(r) => r,
        Err(code) => return mcp::respond(&mut sock, code, None).await,
    };
    if let Some(code) = mcp::check(&req, &token) {
        return mcp::respond(&mut sock, code, None).await;
    }
    let Ok(msg) = serde_json::from_slice::<Value>(&req.body) else {
        let err = json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "Parse error"}});
        return mcp::respond(&mut sock, 400, Some(&err)).await;
    };
    let client = req.header("user-agent").unwrap_or("An agent").to_string();
    match mcp::handle_rpc(&msg, &live_sessions(&app).await) {
        Action::Accepted => mcp::respond(&mut sock, 202, None).await,
        Action::Reply(v) => mcp::respond(&mut sock, 200, Some(&v)).await,
        Action::Run { id, session, command } => {
            let (text, is_error) = run(&app, &session, &command, &client).await;
            mcp::respond(&mut sock, 200, Some(&mcp::tool_result(&id, &text, is_error))).await
        }
    }
}

/// Named sessions that still have a live SSH connection.
async fn live_sessions(app: &AppHandle) -> Vec<SessionInfo> {
    let named = inner().lock().map(|g| g.sessions.clone()).unwrap_or_default();
    let ssh = app.state::<SshState>();
    let live = ssh.connections.lock().await;
    named.into_iter().filter(|s| live.contains_key(&s.id)).collect()
}

async fn run(app: &AppHandle, session: &SessionInfo, command: &str, client: &str) -> (String, bool) {
    let request_id = format!("{:032x}", rand::random::<u128>());
    let (tx, rx) = oneshot::channel();
    if let Ok(mut g) = inner().lock() {
        g.pending.insert(request_id.clone(), tx);
    }
    let _ = app.emit(
        "mcp-approval",
        json!({"requestId": request_id, "session": session.name, "production": session.production, "command": command, "client": client}),
    );
    let approved = matches!(tokio::time::timeout(APPROVAL_TIMEOUT, rx).await, Ok(Ok(true)));
    if let Ok(mut g) = inner().lock() {
        g.pending.remove(&request_id);
    }
    if !approved {
        return ("The user declined this command in SubTerm, or did not answer within 2 minutes.".into(), true);
    }
    match crate::commands::ai::exec_ssh(&app.state::<SshState>(), &session.id, command, EXEC_TIMEOUT).await {
        Ok(r) => (r.to_text(EXEC_TIMEOUT.as_secs()), false),
        Err(e) => (format!("Could not run the command: {e}"), true),
    }
}
