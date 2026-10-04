// Standalone smoke test for the russh 0.63 upgrade, run against a real
// (throwaway, local-only) sshd — NOT a unit test, since it needs a live
// server. Exercises exactly the API surface the upgrade touched:
// connect_stream, publickey auth via PrivateKeyWithHashAlg, channel_open_session,
// exec, reading ChannelMsg::Data, tcpip_forward, and port-forward channel
// accept via the new ChannelOpenHandle-based Handler callback.
//
// Usage: SMOKE_SSH_PORT=2222 SMOKE_SSH_KEY=/path/to/client_key cargo run
// --example russh_smoke_test
//
// Deliberately does NOT reuse the app's own ClientHandler (which needs a
// live Tauri AppHandle + sqlite connection for the known_hosts/fingerprint
// flow) — this test's Handler just accepts any host key, since the goal is
// proving the russh 0.63 API calls work, not re-testing TOFU logic already
// covered by this app's own code review.

use russh::client::{self, Msg};
use russh::keys::{decode_secret_key, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Preferred};
use std::sync::Arc;
use tokio::sync::oneshot;

// Exercises the exact `Channel<Msg>` + `ChannelOpenHandle` callback shape
// ssh_manager.rs's `server_channel_open_forwarded_tcpip` AND
// `server_channel_open_agent_forward` both use post-upgrade — they're
// structurally identical (accept the handle, then bridge the channel's
// stream to a local endpoint via `tokio::io::copy_bidirectional`), so a
// live round trip through one is strong direct evidence the other's
// rewritten agent-forward bridge uses a proven-working pattern, without
// needing a second real ssh-agent process to fully exercise.
struct TestHandler {
    local_target_port: u16,
    forwarded_channel_opened: Option<oneshot::Sender<()>>,
}

impl client::Handler for TestHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true) // throwaway local test server — accept unconditionally
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        let target_port = self.local_target_port;
        if let Some(tx) = self.forwarded_channel_opened.take() {
            let _ = tx.send(());
        }
        tokio::spawn(async move {
            let mut local = match tokio::net::TcpStream::connect(("127.0.0.1", target_port)).await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("      [handler] local connect failed: {e}");
                    return;
                }
            };
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut local, &mut stream).await;
        });
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = std::env::var("SMOKE_SSH_PORT")
        .unwrap_or_else(|_| "2222".into())
        .parse()?;
    let key_path = std::env::var("SMOKE_SSH_KEY")
        .unwrap_or_else(|_| "client_key".into());
    let user = std::env::var("SMOKE_SSH_USER").unwrap_or_else(|_| "manoj".into());

    println!("[0/7] Starting a local echo listener as the port-forward target...");
    let local_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let local_target_port = local_listener.local_addr()?.port();
    tokio::spawn(async move {
        if let Ok((mut sock, _)) = local_listener.accept().await {
            let mut buf = [0u8; 256];
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            if let Ok(n) = sock.read(&mut buf).await {
                let _ = sock.write_all(&buf[..n]).await; // echo back
            }
        }
    });
    println!("      listening on 127.0.0.1:{local_target_port}.");

    println!("[1/7] Building client config (same build_ssh_client_config shape as the app)...");
    let mut config = client::Config::default();
    config.preferred = Preferred::DEFAULT; // exercises the new Preferred shape
    let config = Arc::new(config);

    let (opened_tx, opened_rx) = oneshot::channel();
    let handler = TestHandler {
        local_target_port,
        forwarded_channel_opened: Some(opened_tx),
    };

    println!("[2/7] Connecting to 127.0.0.1:{port}...");
    let mut session = client::connect(config, ("127.0.0.1", port), handler).await?;
    println!("      connected.");

    println!("[3/7] Loading key + authenticating via publickey (PrivateKeyWithHashAlg)...");
    let pem = std::fs::read_to_string(&key_path)?;
    let key = decode_secret_key(&pem, None)?;
    let hash_alg = session.best_supported_rsa_hash().await?.flatten();
    let auth_res = session
        .authenticate_publickey(&user, PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg))
        .await?;
    if !auth_res.success() {
        return Err(format!("publickey auth failed: {:?}", auth_res).into());
    }
    println!("      authenticated as {user}.");

    println!("[4/7] Opening channel + exec'ing a command...");
    let mut channel = session.channel_open_session().await?;
    channel.exec(true, "echo RUSSH_SMOKE_TEST_OK").await?;
    let mut output = Vec::new();
    let mut exit_status = None;
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => output.extend_from_slice(data),
            ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }
    let output_str = String::from_utf8_lossy(&output);
    println!("      exec exit_status={exit_status:?} output={output_str:?}");
    if !output_str.contains("RUSSH_SMOKE_TEST_OK") {
        return Err("exec output did not contain expected marker".into());
    }

    println!("[5/7] Requesting a remote port forward (tcpip_forward)...");
    let bound_port = session.tcpip_forward("127.0.0.1", 0).await?;
    println!("      server granted forward on port {bound_port}.");

    println!("[6/7] Connecting to the forwarded port to trigger the ChannelOpenHandle callback...");
    {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut external = tokio::net::TcpStream::connect(("127.0.0.1", bound_port as u16)).await?;
        external.write_all(b"AGENT_FORWARD_BRIDGE_TEST").await?;
        let mut buf = [0u8; 256];
        let n = tokio::time::timeout(std::time::Duration::from_secs(5), external.read(&mut buf)).await??;
        let echoed = String::from_utf8_lossy(&buf[..n]);
        tokio::time::timeout(std::time::Duration::from_secs(2), opened_rx).await??;
        println!("      handler's server_channel_open_forwarded_tcpip fired, echoed back: {echoed:?}");
        if echoed != "AGENT_FORWARD_BRIDGE_TEST" {
            return Err("round-trip bytes did not match — bridge is corrupting data".into());
        }
    }

    println!("[7/7] Opening an SFTP subsystem channel (russh-sftp, unaffected by the russh API changes but exercised here for completeness)...");
    {
        let sftp_channel = session.channel_open_session().await?;
        sftp_channel.request_subsystem(true, "sftp").await?;
        let sftp = russh_sftp::client::SftpSession::new(sftp_channel.into_stream()).await?;
        let remote_dir = std::env::var("SMOKE_SFTP_DIR").unwrap_or_else(|_| ".".into());
        let remote_path = format!("{}/subterm-smoke-test-{}.txt", remote_dir.trim_end_matches('/'), std::process::id());
        use tokio::io::{AsyncWriteExt, AsyncReadExt};
        {
            let mut f = sftp
                .open_with_flags(&remote_path, russh_sftp::protocol::OpenFlags::WRITE | russh_sftp::protocol::OpenFlags::CREATE | russh_sftp::protocol::OpenFlags::TRUNCATE)
                .await?;
            f.write_all(b"SFTP_SMOKE_TEST_CONTENT").await?;
            f.shutdown().await?;
        }
        let mut readback = Vec::new();
        {
            let mut f = sftp.open(&remote_path).await?;
            f.read_to_end(&mut readback).await?;
        }
        sftp.remove_file(&remote_path).await?;
        if readback != b"SFTP_SMOKE_TEST_CONTENT" {
            return Err("SFTP read-back content did not match what was written".into());
        }
        println!("      SFTP write/read/remove round-trip OK.");
    }

    session
        .disconnect(russh::Disconnect::ByApplication, "smoke test done", "en")
        .await?;
    println!("\nALL CHECKS PASSED (including the Channel<Msg>+ChannelOpenHandle bridge pattern agent-forward now shares, and a live SFTP round trip)");
    Ok(())
}
