// AI assistant bridge: provider config in the vault, and one streamed chat
// turn per `ai_chat` call. Two wire formats cover every supported provider —
// OpenAI-compatible `/chat/completions` (Ollama, OpenAI, OpenRouter, LM Studio,
// Gemini's compat endpoint) and Anthropic Messages. The agent loop itself
// (tool approval, step cap) lives in the front end; this side only does HTTP,
// so API keys never leave Rust.

use crate::vault::save_vault_internal;
use crate::DbState;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::ipc::Channel;
use zeroize::Zeroizing;

// Local models on CPU can take minutes to load before the first token.
const CHUNK_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    id: i64,
    name: String,
    kind: String,
    base_url: String,
    model: String,
    has_key: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInput {
    id: Option<i64>,
    name: String,
    kind: String,
    base_url: String,
    model: String,
    /// `None` keeps the stored key, `Some("")` clears it.
    api_key: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Raw JSON text, as the model produced it.
    pub arguments: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatMsg {
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
}

#[derive(Deserialize)]
pub struct ToolDef {
    name: String,
    description: String,
    parameters: Value,
}

struct Provider {
    kind: String,
    base_url: String,
    model: String,
    key: Zeroizing<String>,
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .user_agent(concat!("subterm-app/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client should build")
    })
}

fn load_provider(state: &DbState, id: i64) -> Result<Provider, String> {
    let guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    conn.query_row(
        "SELECT kind, base_url, model, COALESCE(api_key, '') FROM ai_providers WHERE id = ?1",
        [id],
        |r| {
            Ok(Provider {
                kind: r.get(0)?,
                base_url: r.get(1)?,
                model: r.get(2)?,
                key: Zeroizing::new(r.get(3)?),
            })
        },
    )
    .map_err(|_| "AI provider not found".to_string())
}

fn authed(p: &Provider, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    if p.kind == "anthropic" {
        req.header("x-api-key", p.key.as_str()).header("anthropic-version", "2023-06-01")
    } else if p.key.is_empty() {
        req
    } else {
        req.bearer_auth(p.key.as_str())
    }
}

fn url(p: &Provider, path: &str) -> String {
    format!("{}/{}", p.base_url.trim_end_matches('/'), path)
}

#[tauri::command]
pub async fn ai_list_providers(state: tauri::State<'_, DbState>) -> Result<Vec<ProviderInfo>, String> {
    let guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    let mut stmt = conn
        .prepare("SELECT id, name, kind, base_url, model, COALESCE(api_key, '') != '' FROM ai_providers ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ProviderInfo {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                base_url: r.get(3)?,
                model: r.get(4)?,
                has_key: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| format!("[DATABASE] ROW_FETCH_FAILED: {e}"))
}

#[tauri::command]
pub async fn ai_save_provider(state: tauri::State<'_, DbState>, provider: ProviderInput) -> Result<i64, String> {
    if provider.kind != "openai" && provider.kind != "anthropic" {
        return Err("Provider type must be 'openai' or 'anthropic'".into());
    }
    let base = provider.base_url.trim();
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("Base URL must start with http:// or https://".into());
    }
    let key = provider.api_key.map(|k| Zeroizing::new(k.trim().to_string()));
    let guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    let id = match provider.id {
        Some(id) => {
            conn.execute(
                "UPDATE ai_providers SET name=?2, kind=?3, base_url=?4, model=?5 WHERE id=?1",
                rusqlite::params![id, provider.name, provider.kind, base, provider.model.trim()],
            )
            .map_err(|e| format!("[DATABASE] AI_PROVIDER_UPDATE_FAILED: {e}"))?;
            id
        }
        None => {
            conn.execute(
                "INSERT INTO ai_providers (name, kind, base_url, model) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![provider.name, provider.kind, base, provider.model.trim()],
            )
            .map_err(|e| format!("[DATABASE] AI_PROVIDER_INSERT_FAILED: {e}"))?;
            conn.last_insert_rowid()
        }
    };
    if let Some(k) = key {
        conn.execute("UPDATE ai_providers SET api_key=?2 WHERE id=?1", rusqlite::params![id, k.as_str()])
            .map_err(|e| format!("[DATABASE] AI_KEY_UPDATE_FAILED: {e}"))?;
    }
    drop(guard);
    save_vault_internal(&state)?;
    Ok(id)
}

#[tauri::command]
pub async fn ai_delete_provider(state: tauri::State<'_, DbState>, id: i64) -> Result<(), String> {
    let guard = state.conn.lock().map_err(|_| "[STATE] LOCK_FAILED")?;
    let conn = guard.as_ref().ok_or("[STATE] DATABASE_NOT_INITIALIZED")?;
    conn.execute("DELETE FROM ai_providers WHERE id=?1", [id])
        .map_err(|e| format!("[DATABASE] AI_PROVIDER_DELETE_FAILED: {e}"))?;
    drop(guard);
    save_vault_internal(&state)
}

/// Both formats answer `GET {base}/models` with `{"data":[{"id":…}]}` —
/// Ollama included, through its `/v1` compat layer.
#[tauri::command]
pub async fn ai_list_models(state: tauri::State<'_, DbState>, id: i64) -> Result<Vec<String>, String> {
    let p = load_provider(&state, id)?;
    let resp = authed(&p, http().get(url(&p, "models")))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Could not reach {}: {e}", p.base_url))?;
    let status = resp.status();
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(error_text(status, &body));
    }
    let mut models: Vec<String> = body["data"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(String::from)).collect())
        .unwrap_or_default();
    models.sort();
    Ok(models)
}

/// One assistant turn. Text deltas stream over `on_text`; the finished message,
/// including any tool calls, is the return value.
#[tauri::command]
pub async fn ai_chat(
    state: tauri::State<'_, DbState>,
    id: i64,
    system: String,
    messages: Vec<ChatMsg>,
    tools: Vec<ToolDef>,
    on_text: Channel<String>,
) -> Result<ChatMsg, String> {
    let p = load_provider(&state, id)?;
    stream_chat(&p, &system, &messages, &tools, |t| {
        let _ = on_text.send(t);
    })
    .await
}

async fn stream_chat(
    p: &Provider,
    system: &str,
    messages: &[ChatMsg],
    tools: &[ToolDef],
    mut on_text: impl FnMut(String),
) -> Result<ChatMsg, String> {
    if p.model.trim().is_empty() {
        return Err("Pick a model for this provider in Settings → AI".into());
    }
    let anthropic = p.kind == "anthropic";
    let (path, body) = if anthropic {
        ("messages", anthropic_body(&p.model, system, messages, tools))
    } else {
        ("chat/completions", openai_body(&p.model, system, messages, tools))
    };
    let resp = authed(p, http().post(url(p, path)))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Could not reach {}: {e}", p.base_url))?;
    let status = resp.status();
    if !status.is_success() {
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        return Err(error_text(status, &body));
    }

    let mut acc = Acc::default();
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let chunk = match tokio::time::timeout(CHUNK_TIMEOUT, stream.next()).await {
            Err(_) => return Err("The model stopped responding".into()),
            Ok(None) => break,
            Ok(Some(c)) => c.map_err(|e| e.to_string())?,
        };
        buf.extend_from_slice(&chunk);
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl).collect();
            let Some(data) = sse_data(&line) else { continue };
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            let delta = if anthropic { acc.feed_anthropic(&v)? } else { acc.feed_openai(&v)? };
            if let Some(t) = delta {
                on_text(t);
            }
        }
    }
    Ok(ChatMsg { role: "assistant".into(), content: acc.text, tool_calls: acc.calls, tool_call_id: None })
}

fn error_text(status: reqwest::StatusCode, body: &Value) -> String {
    let msg = body["error"]["message"].as_str().or_else(|| body["error"].as_str()).unwrap_or("");
    if msg.is_empty() { format!("Provider returned HTTP {status}") } else { format!("HTTP {status}: {msg}") }
}

fn sse_data(line: &[u8]) -> Option<&str> {
    let s = std::str::from_utf8(line).ok()?.trim();
    let d = s.strip_prefix("data:")?.trim();
    (d != "[DONE]" && !d.is_empty()).then_some(d)
}

fn openai_body(model: &str, system: &str, messages: &[ChatMsg], tools: &[ToolDef]) -> Value {
    let mut msgs = vec![json!({"role": "system", "content": system})];
    for m in messages {
        msgs.push(match m.role.as_str() {
            "tool" => json!({"role": "tool", "tool_call_id": m.tool_call_id, "content": m.content}),
            "assistant" if !m.tool_calls.is_empty() => json!({
                "role": "assistant",
                "content": m.content,
                "tool_calls": m.tool_calls.iter().map(|c| json!({
                    "id": c.id, "type": "function",
                    "function": {"name": c.name, "arguments": c.arguments},
                })).collect::<Vec<_>>(),
            }),
            role => json!({"role": role, "content": m.content}),
        });
    }
    let mut body = json!({"model": model, "messages": msgs, "stream": true});
    if !tools.is_empty() {
        body["tools"] = tools
            .iter()
            .map(|t| json!({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.parameters}}))
            .collect();
    }
    body
}

fn anthropic_body(model: &str, system: &str, messages: &[ChatMsg], tools: &[ToolDef]) -> Value {
    let mut msgs: Vec<Value> = Vec::new();
    for m in messages {
        match m.role.as_str() {
            "tool" => {
                let block = json!({"type": "tool_result", "tool_use_id": m.tool_call_id, "content": m.content});
                // Results of parallel tool calls must share one user turn.
                match msgs.last_mut() {
                    Some(last) if last["role"] == "user" && last["content"].is_array() => {
                        last["content"].as_array_mut().unwrap().push(block)
                    }
                    _ => msgs.push(json!({"role": "user", "content": [block]})),
                }
            }
            "assistant" => {
                let mut blocks = Vec::new();
                if !m.content.is_empty() {
                    blocks.push(json!({"type": "text", "text": m.content}));
                }
                for c in &m.tool_calls {
                    let input: Value = serde_json::from_str(&c.arguments).unwrap_or_else(|_| json!({}));
                    blocks.push(json!({"type": "tool_use", "id": c.id, "name": c.name, "input": input}));
                }
                msgs.push(json!({"role": "assistant", "content": blocks}));
            }
            // A user message right after tool results joins their turn: roles must alternate.
            _ => match msgs.last_mut() {
                Some(last) if last["role"] == "user" && last["content"].is_array() => {
                    last["content"].as_array_mut().unwrap().push(json!({"type": "text", "text": m.content}))
                }
                _ => msgs.push(json!({"role": "user", "content": m.content})),
            },
        }
    }
    let mut body = json!({"model": model, "max_tokens": 4096, "system": system, "messages": msgs, "stream": true});
    if !tools.is_empty() {
        body["tools"] = tools
            .iter()
            .map(|t| json!({"name": t.name, "description": t.description, "input_schema": t.parameters}))
            .collect();
    }
    body
}

// What the model gets back from one command. The tail is kept because that is
// where errors and summaries are.
const OUTPUT_CAP: usize = 16 * 1024;
const RAW_CAP: usize = 4 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    truncated: bool,
    timed_out: bool,
}

fn tail(buf: &[u8]) -> (String, bool) {
    let cut = buf.len().saturating_sub(OUTPUT_CAP);
    (String::from_utf8_lossy(&buf[cut..]).into_owned(), cut > 0)
}

fn finish(out: &[u8], err: &[u8], exit_code: Option<i32>, timed_out: bool) -> ExecResult {
    let (stdout, t1) = tail(out);
    let (stderr, t2) = tail(err);
    ExecResult { stdout, stderr, exit_code, truncated: t1 || t2, timed_out }
}

fn push_capped(buf: &mut Vec<u8>, data: &[u8]) {
    if buf.len() < RAW_CAP {
        buf.extend_from_slice(data);
    }
}

/// Run one command the user approved in the AI panel, on a new channel of the
/// session (so the visible terminal is untouched), or locally when
/// `session_id` is `None`. Unlike `exec_ssh_cmd` it returns the exit code and
/// separate stderr, and enforces an overall deadline rather than an idle gap.
#[tauri::command]
pub async fn ai_exec(
    state: tauri::State<'_, crate::ssh_manager::SshState>,
    session_id: Option<String>,
    command: String,
    cwd: Option<String>,
    shell: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<ExecResult, String> {
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(60).clamp(1, 600));
    match session_id {
        Some(id) => exec_ssh(&state, &id, &command, timeout).await,
        None => exec_local(&command, cwd, shell.as_deref(), timeout).await,
    }
}

async fn exec_ssh(
    state: &crate::ssh_manager::SshState,
    session_id: &str,
    command: &str,
    timeout: Duration,
) -> Result<ExecResult, String> {
    use russh::ChannelMsg;
    let session = state
        .connections
        .lock()
        .await
        .get(session_id)
        .cloned()
        .ok_or("Session not found — reconnect and try again")?;
    let mut ch = session.lock().await.channel_open_session().await.map_err(|e| e.to_string())?;
    ch.exec(true, command.as_bytes()).await.map_err(|e| e.to_string())?;
    let deadline = tokio::time::Instant::now() + timeout;
    let (mut out, mut err, mut code) = (Vec::new(), Vec::new(), None);
    loop {
        match tokio::time::timeout_at(deadline, ch.wait()).await {
            Err(_) => {
                let _ = ch.close().await;
                return Ok(finish(&out, &err, code, true));
            }
            Ok(None) | Ok(Some(ChannelMsg::Close)) => break,
            Ok(Some(ChannelMsg::Data { data })) => push_capped(&mut out, &data),
            Ok(Some(ChannelMsg::ExtendedData { data, .. })) => push_capped(&mut err, &data),
            Ok(Some(ChannelMsg::ExitStatus { exit_status })) => code = Some(exit_status as i32),
            Ok(Some(_)) => {}
        }
    }
    Ok(finish(&out, &err, code, false))
}

#[cfg(desktop)]
async fn exec_local(command: &str, cwd: Option<String>, shell: Option<&str>, timeout: Duration) -> Result<ExecResult, String> {
    // The same shell the tab runs, so the model's commands mean what they would typed there.
    let (program, _) = crate::commands::terminal::resolve_local_shell(shell);
    let kind = std::path::Path::new(&program)
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let mut cmd = tokio::process::Command::new(&program);
    match kind.as_str() {
        "pwsh" | "powershell" => {
            cmd.args(["-NoProfile", "-NonInteractive", "-Command", command]);
        }
        // cmd parses its own command line, so it gets it raw rather than MSVC-quoted.
        #[cfg(windows)]
        "cmd" => {
            cmd.raw_arg(format!("/D /S /C \"{command}\""));
        }
        "wsl" => {
            cmd.args(["-e", "sh", "-c", command]);
        }
        _ => {
            cmd.args(["-c", command]);
        }
    }
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    if let Some(dir) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
        cmd.current_dir(dir);
    }
    cmd.stdin(std::process::Stdio::null()).kill_on_drop(true);
    match tokio::time::timeout(timeout, cmd.output()).await {
        Err(_) => Ok(finish(b"", b"", None, true)),
        Ok(r) => {
            let o = r.map_err(|e| format!("Could not start the shell: {e}"))?;
            Ok(finish(&o.stdout, &o.stderr, o.status.code(), false))
        }
    }
}

#[cfg(not(desktop))]
async fn exec_local(_: &str, _: Option<String>, _: Option<&str>, _: Duration) -> Result<ExecResult, String> {
    Err("Local commands are not available on this platform".into())
}

#[derive(Default)]
struct Acc {
    text: String,
    calls: Vec<ToolCall>,
}

impl Acc {
    fn push_text(&mut self, t: Option<&str>) -> Option<String> {
        let t = t.filter(|t| !t.is_empty())?;
        self.text.push_str(t);
        Some(t.to_string())
    }

    fn feed_openai(&mut self, v: &Value) -> Result<Option<String>, String> {
        if let Some(e) = v.get("error") {
            return Err(e["message"].as_str().unwrap_or("Provider error").to_string());
        }
        let d = &v["choices"][0]["delta"];
        for tc in d["tool_calls"].as_array().into_iter().flatten() {
            // Ollama omits `index` and sends each call whole, so no index means a new call.
            let i = match tc["index"].as_u64() {
                Some(i) => i as usize,
                None => self.calls.len(),
            };
            while self.calls.len() <= i {
                self.calls.push(ToolCall::default());
            }
            let call = &mut self.calls[i];
            if let Some(id) = tc["id"].as_str() {
                call.id = id.to_string();
            }
            if let Some(n) = tc["function"]["name"].as_str() {
                call.name.push_str(n);
            }
            if let Some(a) = tc["function"]["arguments"].as_str() {
                call.arguments.push_str(a);
            }
        }
        for (n, c) in self.calls.iter_mut().enumerate() {
            if c.id.is_empty() {
                c.id = format!("call_{n}");
            }
        }
        Ok(self.push_text(d["content"].as_str()))
    }

    fn feed_anthropic(&mut self, v: &Value) -> Result<Option<String>, String> {
        match v["type"].as_str() {
            Some("error") => Err(v["error"]["message"].as_str().unwrap_or("Provider error").to_string()),
            Some("content_block_start") if v["content_block"]["type"] == "tool_use" => {
                let b = &v["content_block"];
                self.calls.push(ToolCall {
                    id: b["id"].as_str().unwrap_or_default().to_string(),
                    name: b["name"].as_str().unwrap_or_default().to_string(),
                    arguments: String::new(),
                });
                Ok(None)
            }
            Some("content_block_delta") => {
                let d = &v["delta"];
                if d["type"] == "input_json_delta" {
                    if let (Some(c), Some(p)) = (self.calls.last_mut(), d["partial_json"].as_str()) {
                        c.arguments.push_str(p);
                    }
                    Ok(None)
                } else {
                    Ok(self.push_text(d["text"].as_str()))
                }
            }
            _ => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_sse(raw: &str, anthropic: bool) -> Acc {
        let mut acc = Acc::default();
        for line in raw.lines() {
            if let Some(d) = sse_data(line.as_bytes()) {
                let v: Value = serde_json::from_str(d).unwrap();
                if anthropic { acc.feed_anthropic(&v).unwrap() } else { acc.feed_openai(&v).unwrap() };
            }
        }
        acc
    }

    #[test]
    fn openai_stream_accumulates_text_and_split_tool_args() {
        let raw = r#"data: {"choices":[{"delta":{"content":"Let me "}}]}
data: {"choices":[{"delta":{"content":"check."}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"run_command","arguments":"{\"comm"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"and\":\"df -h\"}"}}]}}]}
data: [DONE]"#;
        let acc = feed_sse(raw, false);
        assert_eq!(acc.text, "Let me check.");
        assert_eq!(
            acc.calls,
            vec![ToolCall { id: "call_a".into(), name: "run_command".into(), arguments: r#"{"command":"df -h"}"#.into() }]
        );
    }

    #[test]
    fn ollama_calls_without_index_or_id_are_separate() {
        let raw = r#"data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"run_command","arguments":"{\"command\":\"uptime\"}"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"run_command","arguments":"{\"command\":\"free -m\"}"}}]}}]}"#;
        let acc = feed_sse(raw, false);
        assert_eq!(acc.calls.len(), 2);
        assert_eq!(acc.calls[1].id, "call_1");
        assert_eq!(acc.calls[1].arguments, r#"{"command":"free -m"}"#);
    }

    #[test]
    fn anthropic_stream_accumulates_text_and_tool_use() {
        let raw = r#"event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking disk."}}
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"run_command","input":{}}}
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"command\":"}}
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"df -h\"}"}}
data: {"type":"message_stop"}"#;
        let acc = feed_sse(raw, true);
        assert_eq!(acc.text, "Checking disk.");
        assert_eq!(acc.calls[0].id, "toolu_1");
        assert_eq!(acc.calls[0].arguments, r#"{"command":"df -h"}"#);
    }

    /// Talks to a real model. Run with
    /// `SUBTERM_AI_LIVE_URL=http://localhost:11434/v1 SUBTERM_AI_LIVE_MODEL=qwen3.5:4b cargo test live_ -- --ignored --nocapture`
    /// (add `SUBTERM_AI_LIVE_KIND=anthropic` and `SUBTERM_AI_LIVE_KEY` for Claude).
    #[tokio::test]
    #[ignore]
    async fn live_tool_call_round_trip() {
        let p = Provider {
            kind: std::env::var("SUBTERM_AI_LIVE_KIND").unwrap_or_else(|_| "openai".into()),
            base_url: std::env::var("SUBTERM_AI_LIVE_URL").expect("SUBTERM_AI_LIVE_URL"),
            model: std::env::var("SUBTERM_AI_LIVE_MODEL").expect("SUBTERM_AI_LIVE_MODEL"),
            key: Zeroizing::new(std::env::var("SUBTERM_AI_LIVE_KEY").unwrap_or_default()),
        };
        let tools = vec![ToolDef {
            name: "run_command".into(),
            description: "Run one shell command and get its output.".into(),
            parameters: json!({"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}),
        }];
        let system = "You are a shell assistant. Use run_command to check things instead of guessing.";
        let mut msgs = vec![ChatMsg {
            role: "user".into(),
            content: "How much free disk space is there? Check it.".into(),
            tool_calls: vec![],
            tool_call_id: None,
        }];
        let mut streamed = 0usize;
        let first = stream_chat(&p, system, &msgs, &tools, |t| streamed += t.len()).await.unwrap();
        println!("first turn: {first:?}");
        let call = first.tool_calls.first().expect("model should call run_command").clone();
        assert_eq!(call.name, "run_command");
        let args: Value = serde_json::from_str(&call.arguments).expect("arguments are JSON");
        assert!(args["command"].as_str().is_some_and(|c| !c.is_empty()));

        msgs.push(first);
        msgs.push(ChatMsg {
            role: "tool".into(),
            content: "Exit code: 0\nstdout:\nFilesystem Size Used Avail Use% Mounted on\n/dev/sda1 100G 91G 9G 91% /".into(),
            tool_calls: vec![],
            tool_call_id: Some(call.id),
        });
        let mut text = String::new();
        let second = stream_chat(&p, system, &msgs, &tools, |t| text.push_str(&t)).await.unwrap();
        println!("second turn: {second:?}");
        assert_eq!(text, second.content, "streamed text matches the final message");
        assert!(second.content.contains('9') || !second.tool_calls.is_empty());
    }

    #[test]
    fn exec_output_keeps_the_tail() {
        let mut big = vec![b'a'; OUTPUT_CAP];
        big.extend_from_slice(b"ERROR at the end");
        let r = finish(&big, b"", Some(1), false);
        assert!(r.truncated);
        assert!(r.stdout.ends_with("ERROR at the end"));
        assert_eq!(r.stdout.len(), OUTPUT_CAP);
        assert!(!finish(b"ok", b"", Some(0), false).truncated);
    }

    #[cfg(desktop)]
    #[tokio::test]
    async fn local_exec_reports_exit_code_and_stderr() {
        let cmd = if cfg!(windows) { "Write-Output hi; [Console]::Error.WriteLine('bad'); exit 3" } else { "echo hi; echo bad >&2; exit 3" };
        let r = exec_local(cmd, None, None, Duration::from_secs(30)).await.unwrap();
        assert_eq!(r.exit_code, Some(3));
        assert_eq!(r.stdout.trim(), "hi");
        assert_eq!(r.stderr.trim(), "bad");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn local_exec_uses_the_tabs_shell() {
        let r = exec_local(r#"echo "a b"& exit /b 4"#, None, Some("cmd"), Duration::from_secs(30)).await.unwrap();
        assert_eq!((r.exit_code, r.stdout.trim()), (Some(4), r#""a b""#));
        let r = exec_local("$PSVersionTable.PSEdition", None, Some("powershell"), Duration::from_secs(30)).await.unwrap();
        assert_eq!(r.stdout.trim(), "Desktop");
    }

    #[test]
    fn stream_error_event_surfaces() {
        let v: Value = serde_json::from_str(r#"{"type":"error","error":{"message":"overloaded"}}"#).unwrap();
        assert_eq!(Acc::default().feed_anthropic(&v), Err("overloaded".into()));
    }

    #[test]
    fn anthropic_body_groups_tool_results_into_one_user_turn() {
        let call = |id: &str| ToolCall { id: id.into(), name: "run_command".into(), arguments: r#"{"command":"ls"}"#.into() };
        let msgs = vec![
            ChatMsg { role: "user".into(), content: "hi".into(), tool_calls: vec![], tool_call_id: None },
            ChatMsg { role: "assistant".into(), content: "".into(), tool_calls: vec![call("a"), call("b")], tool_call_id: None },
            ChatMsg { role: "tool".into(), content: "x".into(), tool_calls: vec![], tool_call_id: Some("a".into()) },
            ChatMsg { role: "tool".into(), content: "y".into(), tool_calls: vec![], tool_call_id: Some("b".into()) },
        ];
        let body = anthropic_body("m", "sys", &msgs, &[]);
        let m = body["messages"].as_array().unwrap();
        assert_eq!(m.len(), 3);
        assert_eq!(m[1]["content"][0]["input"]["command"], "ls");
        assert_eq!(m[2]["content"].as_array().unwrap().len(), 2);
    }
}
