// A small MCP server (Streamable HTTP, JSON responses only) so agent CLIs such
// as Claude Code can use the SSH sessions open in SubTerm. Off by default,
// bound to 127.0.0.1, bearer-token protected, and every command waits for the
// user's approval in the app. The thin Tauri commands live in commands/mcp.rs.
//
// Written on tokio directly rather than adding an HTTP framework: it serves one
// path, one method and small bodies, and closes the connection after each reply.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 1024 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(30);
pub const PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub production: bool,
}

/// What a JSON-RPC message asks for. `Run` needs the app (approval, SSH), so
/// the caller performs it; everything else is answered here.
#[derive(Debug, PartialEq)]
pub enum Action {
    Reply(Value),
    /// A notification: answer 202 with no body.
    Accepted,
    Run { id: Value, session: SessionInfo, command: String },
}

pub fn handle_rpc(msg: &Value, sessions: &[SessionInfo]) -> Action {
    let id = msg.get("id").cloned();
    let method = msg["method"].as_str().unwrap_or("");
    let Some(id) = id else { return Action::Accepted };
    let ok = |result: Value| Action::Reply(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    match method {
        "initialize" => ok(json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or(PROTOCOL_VERSION),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "subterm", "version": env!("CARGO_PKG_VERSION")},
            "instructions": "Runs commands on SSH sessions open in the SubTerm app. The user approves every command in SubTerm.",
        })),
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({"tools": [
            {
                "name": "list_sessions",
                "description": "List the SSH sessions open in SubTerm.",
                "inputSchema": {"type": "object", "properties": {}},
            },
            {
                "name": "run_command",
                "description": "Run one non-interactive shell command on an open SubTerm SSH session and get stdout, stderr and the exit code. The user approves each command in SubTerm; a declined or unanswered request returns an error. Times out after 60 s.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "session": {"type": "string", "description": "Session id or exact name from list_sessions"},
                        "command": {"type": "string"},
                    },
                    "required": ["session", "command"],
                },
            },
        ]})),
        "tools/call" => {
            let args = &msg["params"]["arguments"];
            match msg["params"]["name"].as_str() {
                Some("list_sessions") => Action::Reply(tool_result(&id, &serde_json::to_string_pretty(sessions).unwrap_or_default(), false)),
                Some("run_command") => {
                    let command = args["command"].as_str().unwrap_or("").trim().to_string();
                    let wanted = args["session"].as_str().unwrap_or("");
                    if command.is_empty() {
                        return Action::Reply(tool_result(&id, "No command given.", true));
                    }
                    match find_session(sessions, wanted) {
                        Ok(session) => Action::Run { id, session, command },
                        Err(e) => Action::Reply(tool_result(&id, &e, true)),
                    }
                }
                other => Action::Reply(rpc_error(&id, -32602, &format!("Unknown tool {}", other.unwrap_or("")))),
            }
        }
        _ => Action::Reply(rpc_error(&id, -32601, &format!("Method not found: {method}"))),
    }
}

fn find_session(sessions: &[SessionInfo], wanted: &str) -> Result<SessionInfo, String> {
    if let Some(s) = sessions.iter().find(|s| s.id == wanted) {
        return Ok(s.clone());
    }
    let by_name: Vec<_> = sessions.iter().filter(|s| s.name == wanted).collect();
    match by_name.as_slice() {
        [one] => Ok((*one).clone()),
        [] => Err(format!("No open session called {wanted:?}. Call list_sessions.")),
        _ => Err(format!("More than one session is called {wanted:?}; pass its id.")),
    }
}

pub fn tool_result(id: &Value, text: &str, is_error: bool) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": {"content": [{"type": "text", "text": text}], "isError": is_error}})
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

/// Read one HTTP/1.1 request with size and time limits.
pub async fn read_request<S: AsyncRead + Unpin>(sock: &mut S) -> Result<Request, u16> {
    let read = async {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        let head_end = loop {
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i;
            }
            if buf.len() > MAX_HEAD {
                return Err(431);
            }
            let n = sock.read(&mut chunk).await.map_err(|_| 400u16)?;
            if n == 0 {
                return Err(400);
            }
            buf.extend_from_slice(&chunk[..n]);
        };
        let head = std::str::from_utf8(&buf[..head_end]).map_err(|_| 400u16)?;
        let mut lines = head.split("\r\n");
        let mut first = lines.next().unwrap_or("").split(' ');
        let method = first.next().unwrap_or("").to_string();
        let path = first.next().unwrap_or("").to_string();
        let headers: Vec<(String, String)> = lines
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
            .collect();
        let len: usize = headers
            .iter()
            .find(|(k, _)| k == "content-length")
            .map(|(_, v)| v.parse().map_err(|_| 400u16))
            .transpose()?
            .unwrap_or(0);
        if len > MAX_BODY {
            return Err(413);
        }
        let mut body = buf[head_end + 4..].to_vec();
        while body.len() < len {
            let n = sock.read(&mut chunk).await.map_err(|_| 400u16)?;
            if n == 0 {
                return Err(400);
            }
            body.extend_from_slice(&chunk[..n]);
        }
        body.truncate(len);
        Ok(Request { method, path, headers, body })
    };
    tokio::time::timeout(READ_TIMEOUT, read).await.unwrap_or(Err(408))
}

/// Status to refuse the request with, or `None` when it may reach the RPC handler.
pub fn check(req: &Request, token: &str) -> Option<u16> {
    if req.path != "/mcp" {
        return Some(404);
    }
    // Browsers always send Origin; agent CLIs don't. This blocks web pages from
    // reaching the port even before the token check.
    if req.header("origin").is_some() {
        return Some(403);
    }
    let expected = format!("Bearer {token}");
    if !req.header("authorization").is_some_and(|a| constant_eq(a.as_bytes(), expected.as_bytes())) {
        return Some(401);
    }
    if req.method != "POST" {
        return Some(405);
    }
    None
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub async fn respond<S: AsyncWrite + Unpin>(sock: &mut S, status: u16, body: Option<&Value>) {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        _ => "Error",
    };
    let text = body.map(|b| b.to_string()).unwrap_or_default();
    let mut out = format!("HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n", text.len());
    if body.is_some() {
        out.push_str("Content-Type: application/json\r\n");
    }
    if status == 405 {
        out.push_str("Allow: POST\r\n");
    }
    out.push_str("\r\n");
    out.push_str(&text);
    let _ = sock.write_all(out.as_bytes()).await;
    let _ = sock.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sessions() -> Vec<SessionInfo> {
        vec![
            SessionInfo { id: "s1".into(), name: "web-01".into(), production: false },
            SessionInfo { id: "s2".into(), name: "db".into(), production: true },
            SessionInfo { id: "s3".into(), name: "db".into(), production: false },
        ]
    }

    fn call(name: &str, args: Value) -> Value {
        json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": name, "arguments": args}})
    }

    #[test]
    fn answers_the_handshake_and_lists_tools() {
        let init = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}});
        let Action::Reply(r) = handle_rpc(&init, &[]) else { panic!() };
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(r["result"]["serverInfo"]["name"], "subterm");
        assert_eq!(handle_rpc(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}), &[]), Action::Accepted);
        let Action::Reply(r) = handle_rpc(&json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}), &[]) else { panic!() };
        assert_eq!(r["result"]["tools"].as_array().unwrap().len(), 2);
        let Action::Reply(r) = handle_rpc(&json!({"jsonrpc": "2.0", "id": 3, "method": "nope"}), &[]) else { panic!() };
        assert_eq!(r["error"]["code"], -32601);
    }

    #[test]
    fn run_command_resolves_the_session_by_id_or_unique_name() {
        let Action::Run { session, command, .. } = handle_rpc(&call("run_command", json!({"session": "web-01", "command": " df -h "})), &sessions()) else { panic!() };
        assert_eq!((session.id.as_str(), command.as_str()), ("s1", "df -h"));
        let Action::Run { session, .. } = handle_rpc(&call("run_command", json!({"session": "s2", "command": "ls"})), &sessions()) else { panic!() };
        assert!(session.production);
        for (args, msg) in [
            (json!({"session": "db", "command": "ls"}), "more than one"),
            (json!({"session": "nope", "command": "ls"}), "no open session"),
            (json!({"session": "s1", "command": ""}), "no command"),
        ] {
            let Action::Reply(r) = handle_rpc(&call("run_command", args), &sessions()) else { panic!() };
            assert_eq!(r["result"]["isError"], true);
            assert!(r["result"]["content"][0]["text"].as_str().unwrap().to_lowercase().contains(msg));
        }
    }

    async fn request(raw: &str) -> Result<Request, u16> {
        let (mut client, mut server) = tokio::io::duplex(64 * 1024);
        client.write_all(raw.as_bytes()).await.unwrap();
        read_request(&mut server).await
    }

    #[tokio::test]
    async fn refuses_wrong_token_browsers_and_other_paths() {
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        let raw = |extra: &str, path: &str| format!("POST {path} HTTP/1.1\r\nHost: x\r\n{extra}Content-Length: {}\r\n\r\n{body}", body.len());
        let ok = request(&raw("Authorization: Bearer t0k\r\n", "/mcp")).await.unwrap();
        assert_eq!(check(&ok, "t0k"), None);
        assert_eq!(ok.body, body.as_bytes());
        assert_eq!(check(&ok, "other"), Some(401));
        let no_auth = request(&raw("", "/mcp")).await.unwrap();
        assert_eq!(check(&no_auth, "t0k"), Some(401));
        let browser = request(&raw("Authorization: Bearer t0k\r\nOrigin: https://evil.example\r\n", "/mcp")).await.unwrap();
        assert_eq!(check(&browser, "t0k"), Some(403));
        let path = request(&raw("Authorization: Bearer t0k\r\n", "/other")).await.unwrap();
        assert_eq!(check(&path, "t0k"), Some(404));
        let get = request("GET /mcp HTTP/1.1\r\nAuthorization: Bearer t0k\r\n\r\n").await.unwrap();
        assert_eq!(check(&get, "t0k"), Some(405));
    }

    #[tokio::test]
    async fn speaks_http_to_a_real_client() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = listener.accept().await.unwrap();
                let req = match read_request(&mut sock).await {
                    Ok(r) => r,
                    Err(c) => { respond(&mut sock, c, None).await; continue; }
                };
                if let Some(c) = check(&req, "secret") { respond(&mut sock, c, None).await; continue; }
                let msg: Value = serde_json::from_slice(&req.body).unwrap();
                match handle_rpc(&msg, &sessions()) {
                    Action::Reply(v) => respond(&mut sock, 200, Some(&v)).await,
                    Action::Accepted => respond(&mut sock, 202, None).await,
                    Action::Run { .. } => respond(&mut sock, 500, None).await,
                }
            }
        });
        let url = format!("http://127.0.0.1:{port}/mcp");
        let http = reqwest::Client::new();
        let r = http.post(&url).bearer_auth("secret").json(&call("list_sessions", json!({}))).send().await.unwrap();
        assert_eq!(r.status(), 200);
        let v: Value = r.json().await.unwrap();
        assert!(v["result"]["content"][0]["text"].as_str().unwrap().contains("web-01"));
        let r = http.post(&url).bearer_auth("secret").json(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).send().await.unwrap();
        assert_eq!(r.status(), 202);
        let r = http.post(&url).json(&json!({})).send().await.unwrap();
        assert_eq!(r.status(), 401);
    }

    #[tokio::test]
    async fn limits_body_size() {
        let raw = format!("POST /mcp HTTP/1.1\r\nContent-Length: {}\r\n\r\n", MAX_BODY + 1);
        assert_eq!(request(&raw).await.err(), Some(413));
    }
}
