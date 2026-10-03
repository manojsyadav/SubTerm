// Local SSH agent transport for SSH agent forwarding (-A). This module only
// proxies raw bytes between a forwarded SSH channel and whatever local agent
// socket/pipe the user has running — it never parses the ssh-agent wire
// protocol itself. That's deliberate: OpenSSH's agent, Pageant, and the
// SSH-agent-compatible sockets/pipes exposed by 1Password, KeePassXC, and
// Vaultwarden/Bitwarden all speak the same standard protocol, so a dumb byte
// proxy gets forwarding working with all of them for free, with no
// per-vendor integration code.

use std::io;
use tokio::io::{AsyncRead, AsyncWrite};

/// Connects to the local SSH agent. `custom_path` overrides the default
/// socket path (Unix) or pipe name (Windows) — useful for pointing at a
/// non-standard agent (e.g. 1Password's own pipe) instead of the OS default.
#[cfg(unix)]
pub(crate) async fn connect_local_agent(
    custom_path: Option<&str>,
) -> io::Result<impl AsyncRead + AsyncWrite + Unpin + Send + 'static> {
    use tokio::net::UnixStream;
    let path = match custom_path {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => std::env::var("SSH_AUTH_SOCK").map_err(|_| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "SSH_AUTH_SOCK is not set — no local SSH agent running",
            )
        })?,
    };
    UnixStream::connect(path).await
}

/// Connects to the local SSH agent via the OpenSSH-compatible named pipe
/// (`\\.\pipe\openssh-ssh-agent`, what Windows' built-in OpenSSH agent
/// service and Pageant-compatible agents expose). `custom_path`, if given,
/// overrides the pipe name.
#[cfg(windows)]
pub(crate) async fn connect_local_agent(
    custom_path: Option<&str>,
) -> io::Result<impl AsyncRead + AsyncWrite + Unpin + Send + 'static> {
    use tokio::net::windows::named_pipe::ClientOptions;
    const DEFAULT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";
    let pipe_name = match custom_path {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => DEFAULT_PIPE.to_string(),
    };
    // ERROR_PIPE_BUSY (231): another client is mid-handshake with the agent.
    // That's typically a few-ms window, not a real unavailability — one
    // short retry avoids a spurious failure under concurrent agent use.
    match ClientOptions::new().open(&pipe_name) {
        Ok(client) => Ok(client),
        Err(e) if e.raw_os_error() == Some(231) => {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            ClientOptions::new().open(&pipe_name)
        }
        Err(e) => Err(e),
    }
}

#[cfg(not(any(unix, windows)))]
pub(crate) async fn connect_local_agent(
    _custom_path: Option<&str>,
) -> io::Result<tokio::net::TcpStream> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "SSH agent forwarding is not supported on this platform",
    ))
}
