//! Embedded homelab browser proxy.
//!
//! Provides a local loopback HTTP proxy (bound to 127.0.0.1 with bearer token)
//! so SubTerm's embedded browser tab can:
//! 1. Connect to homelab services with self-signed SSL certificates (Proxmox, TrueNAS, etc.)
//!    without SSL authority failures.
//! 2. Strip `X-Frame-Options` and `Content-Security-Policy: frame-ancestors` headers that
//!    prevent web management consoles from rendering inside the session tabs.
//! 3. Inject base href for relative assets to resolve cleanly.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const DEFAULT_PROXY_PORT: u16 = 47823;
const MAX_HEAD_SIZE: usize = 32 * 1024;
const MAX_BODY_SIZE: usize = 16 * 1024 * 1024; // 16MB for uploads/posts
const PROXY_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyInfo {
    pub port: u16,
    pub token: String,
    pub running: bool,
}

#[derive(Default)]
struct ProxyState {
    server: Option<(u16, tokio::task::JoinHandle<()>)>,
    token: String,
    port: u16,
    last_target_origin: String,
}

fn state() -> &'static Mutex<ProxyState> {
    static STATE: OnceLock<Mutex<ProxyState>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}

pub fn generate_token() -> String {
    let bytes = (0..24).map(|_| rand::random::<u8>()).collect::<Vec<_>>();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Start or return the running proxy info.
pub async fn start_proxy(requested_port: Option<u16>) -> Result<ProxyInfo, String> {
    // 1. Check if already running without holding lock across await
    {
        let g = state().lock().map_err(|_| "[STATE] LOCK_FAILED".to_string())?;
        if let Some((port, _)) = &g.server {
            return Ok(ProxyInfo {
                port: *port,
                token: g.token.clone(),
                running: true,
            });
        }
    }

    let token = generate_token();
    let port = requested_port.unwrap_or(DEFAULT_PROXY_PORT);

    // Try binding requested port; if occupied, bind 0 for an ephemeral port
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(_) => tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| format!("Could not bind proxy on 127.0.0.1: {e}"))?,
    };

    let actual_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token_clone = Arc::new(token.clone());

    // Build client that trusts homelab self-signed certificates and follows redirects
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(PROXY_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let client = Arc::new(client);

    let task = tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else { continue };
            let client = client.clone();
            let token = token_clone.clone();
            tokio::spawn(async move {
                handle_socket(sock, client, token).await;
            });
        }
    });

    {
        let mut g = state().lock().map_err(|_| "[STATE] LOCK_FAILED".to_string())?;
        g.server = Some((actual_port, task));
        g.token = token.clone();
        g.port = actual_port;
    }

    Ok(ProxyInfo {
        port: actual_port,
        token,
        running: true,
    })
}

pub fn stop_proxy() {
    if let Ok(mut g) = state().lock() {
        if let Some((_, task)) = g.server.take() {
            task.abort();
        }
        g.port = 0;
        g.token.clear();
        g.last_target_origin.clear();
    }
}

pub fn get_proxy_status() -> ProxyInfo {
    if let Ok(g) = state().lock() {
        ProxyInfo {
            port: g.port,
            token: g.token.clone(),
            running: g.server.is_some(),
        }
    } else {
        ProxyInfo {
            port: 0,
            token: String::new(),
            running: false,
        }
    }
}

struct ParsedRequest {
    method: String,
    uri: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

async fn read_http_request(sock: &mut tokio::net::TcpStream) -> Result<ParsedRequest, u16> {
    let mut buf = Vec::with_capacity(4096);
    let mut temp = [0u8; 2048];
    let mut header_end = None;

    while buf.len() < MAX_HEAD_SIZE {
        let n = sock.read(&mut temp).await.map_err(|_| 500u16)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&temp[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = Some(pos);
            break;
        }
    }

    let Some(sep) = header_end else {
        return Err(400);
    };

    let head_str = std::str::from_utf8(&buf[..sep]).map_err(|_| 400u16)?;
    let mut lines = head_str.lines();
    let first = lines.next().ok_or(400u16)?;
    let mut parts = first.split_whitespace();
    let method = parts.next().ok_or(400u16)?.to_string();
    let uri = parts.next().ok_or(400u16)?.to_string();

    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let mut body = buf[sep + 4..].to_vec();
    if let Some(cl_val) = headers.get("content-length") {
        if let Ok(content_len) = cl_val.parse::<usize>() {
            if content_len > MAX_BODY_SIZE {
                return Err(413);
            }
            while body.len() < content_len {
                let n = sock.read(&mut temp).await.map_err(|_| 500u16)?;
                if n == 0 {
                    break;
                }
                body.extend_from_slice(&temp[..n]);
            }
        }
    }

    Ok(ParsedRequest {
        method,
        uri,
        headers,
        body,
    })
}

fn parse_query(uri: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Some((_, query)) = uri.split_once('?') {
        for pair in query.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                if let Ok(decoded_val) = urlencoding_decode(v) {
                    map.insert(k.to_string(), decoded_val);
                }
            }
        }
    }
    map
}

fn urlencoding_decode(s: &str) -> Result<String, ()> {
    let mut res = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex_str = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|_| ())?;
            let byte = u8::from_str_radix(hex_str, 16).map_err(|_| ())?;
            res.push(byte);
            i += 3;
        } else if bytes[i] == b'+' {
            res.push(b' ');
            i += 1;
        } else {
            res.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(res).map_err(|_| ())
}

fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

async fn write_response(
    sock: &mut tokio::net::TcpStream,
    status: u16,
    status_text: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) {
    let mut head = format!("HTTP/1.1 {status} {status_text}\r\n");
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    head.push_str("Connection: close\r\n\r\n");

    let _ = sock.write_all(head.as_bytes()).await;
    let _ = sock.write_all(body).await;
    let _ = sock.shutdown().await;
}

async fn handle_socket(
    mut sock: tokio::net::TcpStream,
    client: Arc<reqwest::Client>,
    expected_token: Arc<String>,
) {
    let req = match read_http_request(&mut sock).await {
        Ok(r) => r,
        Err(code) => {
            write_response(&mut sock, code, "Error", &[], b"Request parse error").await;
            return;
        }
    };

    // Health check endpoint
    if req.uri == "/health" {
        write_response(
            &mut sock,
            200,
            "OK",
            &[("Content-Type", "text/plain"), ("Access-Control-Allow-Origin", "*")],
            b"subterm-browser-proxy-ok",
        )
        .await;
        return;
    }

    let query = parse_query(&req.uri);
    let mut token = query.get("token").cloned().unwrap_or_else(|| {
        req.headers
            .get("authorization")
            .and_then(|h| h.strip_prefix("Bearer "))
            .unwrap_or("")
            .to_string()
    });

    if token.is_empty() {
        if let Some(cookie) = req.headers.get("cookie") {
            for part in cookie.split(';') {
                let trimmed = part.trim();
                if let Some(val) = trimmed.strip_prefix("subterm_token=") {
                    token = val.to_string();
                    break;
                }
            }
        }
    }

    if token.is_empty() {
        if let Some(referer) = req.headers.get("referer") {
            let ref_query = parse_query(referer);
            if let Some(t) = ref_query.get("token") {
                token = t.clone();
            }
        }
    }

    if token != *expected_token {
        write_response(&mut sock, 401, "Unauthorized", &[], b"Invalid proxy token").await;
        return;
    }

    // Determine upstream target URL:
    // 1. Direct 'url' query parameter (e.g. /proxy?url=https://10.0.0.1/)
    // 2. Relative subresource resolved against Referer's 'url' parameter
    // 3. Fallback to last known target origin for this proxy session
    let target_url = if let Some(u) = query.get("url") {
        let u_str = u.to_string();
        if let Ok(parsed) = reqwest::Url::parse(&u_str) {
            let origin = format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or(""));
            let origin_with_port = if let Some(port) = parsed.port() {
                format!("{origin}:{port}")
            } else {
                origin
            };
            if let Ok(mut g) = state().lock() {
                g.last_target_origin = origin_with_port;
            }
        }
        u_str
    } else {
        let origin = if let Some(referer) = req.headers.get("referer") {
            let ref_query = parse_query(referer);
            if let Some(ref_u) = ref_query.get("url") {
                if let Ok(parsed) = reqwest::Url::parse(ref_u) {
                    let o = format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or(""));
                    if let Some(port) = parsed.port() {
                        format!("{o}:{port}")
                    } else {
                        o
                    }
                } else {
                    state().lock().map(|g| g.last_target_origin.clone()).unwrap_or_default()
                }
            } else {
                state().lock().map(|g| g.last_target_origin.clone()).unwrap_or_default()
            }
        } else {
            state().lock().map(|g| g.last_target_origin.clone()).unwrap_or_default()
        };

        if origin.is_empty() {
            write_response(&mut sock, 400, "Bad Request", &[], b"Missing target URL or Referer").await;
            return;
        }

        if req.uri.starts_with('/') {
            format!("{origin}{}", req.uri)
        } else {
            format!("{origin}/{}", req.uri)
        }
    };

    let target_lower = target_url.to_ascii_lowercase();
    if !target_lower.starts_with("http://") && !target_lower.starts_with("https://") {
        write_response(&mut sock, 400, "Bad Request", &[], b"Only http:// and https:// URLs are supported").await;
        return;
    }

    let method = match req.method.as_str() {
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        "HEAD" => reqwest::Method::HEAD,
        "OPTIONS" => reqwest::Method::OPTIONS,
        _ => reqwest::Method::GET,
    };

    let mut builder = client.request(method, &target_url);

    for (k, v) in &req.headers {
        if k != "host" && k != "content-length" && k != "connection" {
            builder = builder.header(k.as_str(), v.as_str());
        }
    }

    if !req.body.is_empty() {
        builder = builder.body(req.body);
    }

    let resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("SubTerm Proxy Error: Failed to fetch {target_url}: {e}");
            write_response(
                &mut sock,
                502,
                "Bad Gateway",
                &[("Content-Type", "text/html; charset=utf-8"), ("Access-Control-Allow-Origin", "*")],
                msg.as_bytes(),
            )
            .await;
            return;
        }
    };

    let status = resp.status().as_u16();
    let status_text = resp.status().canonical_reason().unwrap_or("OK").to_string();

    let mut response_headers: Vec<(String, String)> = Vec::new();
    let current_origin = state().lock().map(|g| g.last_target_origin.clone()).unwrap_or_default();

    for (k, v) in resp.headers() {
        let name = k.as_str().to_ascii_lowercase();
        if name == "x-frame-options"
            || name == "content-security-policy"
            || name == "cross-origin-opener-policy"
            || name == "cross-origin-embedder-policy"
            || name == "content-length"
            || name == "transfer-encoding"
            || name == "connection"
        {
            continue;
        }

        if let Ok(val) = v.to_str() {
            if name == "set-cookie" {
                // Strip Domain=... so browser allows cookie for 127.0.0.1
                let parts: Vec<&str> = val.split(';').map(|p| p.trim()).collect();
                let filtered: Vec<&str> = parts
                    .into_iter()
                    .filter(|p| !p.to_ascii_lowercase().starts_with("domain="))
                    .map(|p| {
                        if p.to_ascii_lowercase().starts_with("samesite=") {
                            "SameSite=Lax"
                        } else {
                            p
                        }
                    })
                    .collect();
                response_headers.push(("Set-Cookie".to_string(), filtered.join("; ")));
            } else if name == "location" {
                // Rewrite redirects so they route through the proxy
                let rewritten = if val.starts_with("http://") || val.starts_with("https://") {
                    format!("/proxy?url={}&token={}", urlencoding_encode(val), expected_token)
                } else if !current_origin.is_empty() {
                    let full = if val.starts_with('/') {
                        format!("{}{}", current_origin, val)
                    } else {
                        format!("{}/{}", current_origin, val)
                    };
                    format!("/proxy?url={}&token={}", urlencoding_encode(&full), expected_token)
                } else {
                    val.to_string()
                };
                response_headers.push(("Location".to_string(), rewritten));
            } else {
                response_headers.push((k.as_str().to_string(), val.to_string()));
            }
        }
    }

    // Set token cookie so subresources authenticate automatically
    response_headers.push((
        "Set-Cookie".to_string(),
        format!("subterm_token={}; Path=/; SameSite=Lax", *expected_token),
    ));

    let body = resp.bytes().await.unwrap_or_default().to_vec();

    let mut head = format!("HTTP/1.1 {status} {status_text}\r\n");
    for (k, v) in &response_headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("Access-Control-Allow-Origin: *\r\n");
    head.push_str("Access-Control-Allow-Methods: *\r\n");
    head.push_str("Access-Control-Allow-Headers: *\r\n");
    head.push_str("Access-Control-Allow-Credentials: true\r\n");
    head.push_str("X-SubTerm-Proxy: 1\r\n");
    head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    head.push_str("Connection: close\r\n\r\n");

    let _ = sock.write_all(head.as_bytes()).await;
    let _ = sock.write_all(&body).await;
    let _ = sock.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_url_decoding() {
        assert_eq!(
            urlencoding_decode("https%3A%2F%2F192.168.1.100%3A8006%2F").unwrap(),
            "https://192.168.1.100:8006/"
        );
        assert_eq!(urlencoding_decode("hello+world").unwrap(), "hello world");
    }

    #[test]
    fn test_token_generation() {
        let t1 = generate_token();
        let t2 = generate_token();
        assert_eq!(t1.len(), 48);
        assert_ne!(t1, t2);
    }

    #[tokio::test]
    async fn test_proxy_lifecycle() {
        let info = start_proxy(None).await.unwrap();
        assert!(info.running);
        assert!(info.port > 0);
        assert!(!info.token.is_empty());

        let status = get_proxy_status();
        assert!(status.running);
        assert_eq!(status.port, info.port);

        stop_proxy();
        let stopped = get_proxy_status();
        assert!(!stopped.running);
    }
}
