//! SubTerm RDP helper: one RDP session per process.
//!
//! Reads a JSON connection request on stdin, connects (TLS + CredSSP/NLA), then
//! streams decoded screen updates to stdout and applies mouse/keyboard events
//! arriving on stdin. See `wire.rs` for the framing. Stdout carries ONLY frames;
//! diagnostics go to stderr.

mod channels;
mod wire;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::mpsc;
use std::time::Duration;

use anyhow::Context as _;
use ironrdp::connector::{self, ConnectionResult, Credentials};
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::input::{Database, MouseButton, MousePosition, Operation, Scancode, WheelRotations};
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp::pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{ActiveStage, ActiveStageBuilder, ActiveStageOutput};
use serde::Deserialize;
use sspi::network_client::reqwest_network_client::ReqwestNetworkClient;
use tokio_rustls::rustls;
use wire::{crop_rgba, read_input, write_frame, Dirty, Input, OUT_CERT, OUT_CLOSED, OUT_CONNECTED, OUT_ERROR, OUT_UPDATE};

#[derive(Deserialize)]
struct Request {
    host: String,
    port: u16,
    username: String,
    password: String,
    #[serde(default)]
    domain: Option<String>,
    width: u16,
    height: u16,
    /// Ask the server to play its sound here (sent to the app as AUDIO frames).
    #[serde(default)]
    audio: bool,
}

type Tls = rustls::StreamOwned<rustls::ClientConnection, TcpStream>;
pub(crate) type Framed = ironrdp_blocking::Framed<Tls>;

fn main() {
    // Several crates in the graph enable a rustls backend; pick one explicitly.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let result = run();
    let mut out = std::io::stdout().lock();
    match result {
        Ok(reason) => { let _ = write_frame(&mut out, OUT_CLOSED, reason.as_bytes()); }
        Err(e) => {
            let _ = write_frame(&mut out, OUT_ERROR, format!("{e:#}").as_bytes());
            let _ = write_frame(&mut out, OUT_CLOSED, b"");
        }
    }
}

fn run() -> anyhow::Result<String> {
    let mut stdin = BufReader::new(std::io::stdin());
    let mut line = String::new();
    stdin.read_line(&mut line).context("read request")?;
    let req: Request = serde_json::from_str(line.trim()).context("parse request")?;

    // Even sizes only (RDP requirement for some codecs), within sane bounds.
    let width = (req.width.clamp(640, 4096)) & !1;
    let height = (req.height.clamp(480, 4096)) & !1;

    let config = build_config(&req, width, height);
    let (conn, mut framed) = connect(config, &req.host, req.port, req.audio, &mut stdin).context("connect")?;
    let size = conn.desktop_size;
    let mut image = DecodedImage::new(PixelFormat::RgbA32, size.width, size.height);
    send_connected(size)?;
    let activation_factory = conn.activation_factory.clone();

    // Short read timeout from here on, so the loop can service input between server PDUs.
    framed.get_inner_mut().0.sock.set_read_timeout(Some(Duration::from_millis(15)))?;

    let (tx, rx) = mpsc::channel::<Input>();
    std::thread::spawn(move || {
        let mut stdin = stdin;
        while let Ok(Some(ev)) = read_input(&mut stdin) {
            let stop = ev == Input::Disconnect;
            if tx.send(ev).is_err() || stop {
                return;
            }
        }
        let _ = tx.send(Input::Disconnect); // app went away
    });

    let mut stage = ActiveStageBuilder {
        static_channels: conn.static_channels,
        user_channel_id: conn.user_channel_id,
        io_channel_id: conn.io_channel_id,
        message_channel_id: conn.message_channel_id,
        share_id: conn.share_id,
        compression_type: conn.compression_type,
        enable_server_pointer: conn.enable_server_pointer,
        pointer_software_rendering: conn.pointer_software_rendering,
    }
    .build();
    let mut input_db = Database::new();
    // Screen changes are merged and sent at most every FLUSH_EVERY, or as soon as the
    // server goes quiet, instead of one frame per update rectangle.
    let mut dirty = Dirty::default();
    let mut last_flush = std::time::Instant::now();
    let mut clipboard = channels::LocalClipboard::default();
    // Window resizes arrive in bursts while the user drags; each request costs the
    // server a full reactivation, so only the size it settles on is sent.
    let mut pending_resize: Option<(u16, u16, std::time::Instant)> = None;

    loop {
        while let Ok(ev) = rx.try_recv() {
            match ev {
                Input::Disconnect => {
                    if let Ok(outs) = stage.graceful_shutdown() {
                        let _ = handle_outputs(&mut framed, &mut dirty, outs);
                    }
                    return Ok("disconnected".into());
                }
                Input::Resize { width, height } => {
                    let current = (u32::from(image.width()), u32::from(image.height()));
                    pending_resize = (channels::resize_target(width, height) != current).then(|| (width, height, std::time::Instant::now()));
                    continue;
                }
                Input::Clipboard(text) => {
                    clipboard.text = (!text.is_empty()).then_some(text);
                    clipboard.changed = true;
                    if let Err(e) = channels::pump_clipboard(&mut stage, &mut framed, &mut clipboard) {
                        eprintln!("clipboard: {e:#}");
                    }
                    continue;
                }
                _ => {}
            }
            let events = input_db.apply(to_operations(ev));
            if events.is_empty() {
                continue;
            }
            let outs = stage.process_fastpath_input(&mut image, &events).context("send input")?;
            match handle_outputs(&mut framed, &mut dirty, outs)? {
                Flow::Continue => {}
                Flow::End(reason) => return Ok(reason),
                Flow::Reactivate => {
                    image = reactivate(&mut framed, &mut stage, &activation_factory, &mut dirty)?;
                }
            }
        }

        if let Some((w, h, at)) = pending_resize {
            if at.elapsed() >= RESIZE_SETTLE && channels::request_resize(&mut stage, &mut framed, w, h)? {
                pending_resize = None;
            }
        }

        let idle = match framed.read_pdu() {
            Ok((action, payload)) => {
                let outs = stage.process(&mut image, action, &payload).context("process frame")?;
                match handle_outputs(&mut framed, &mut dirty, outs)? {
                    Flow::Continue => {}
                    Flow::End(reason) => {
                        flush_dirty(&mut dirty, &image)?;
                        return Ok(reason);
                    }
                    Flow::Reactivate => {
                        image = reactivate(&mut framed, &mut stage, &activation_factory, &mut dirty)?;
                    }
                }
                // Clipboard trouble (an unexpected server state, say) must not end the session.
                if let Err(e) = channels::pump_clipboard(&mut stage, &mut framed, &mut clipboard) {
                    eprintln!("clipboard: {e:#}");
                }
                false
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => true,
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok("the server closed the connection".into()),
            Err(e) => return Err(anyhow::Error::new(e).context("read from server")),
        };
        if idle || last_flush.elapsed() >= FLUSH_EVERY {
            flush_dirty(&mut dirty, &image)?;
            last_flush = std::time::Instant::now();
        }
    }
}

/// Longest a screen change waits while the server keeps streaming (~30 fps).
const FLUSH_EVERY: Duration = Duration::from_millis(33);
/// How long the window size must stay put before the remote desktop follows it.
const RESIZE_SETTLE: Duration = Duration::from_millis(400);

fn send_connected(size: connector::DesktopSize) -> anyhow::Result<()> {
    let mut p = Vec::with_capacity(4);
    p.extend_from_slice(&size.width.to_le_bytes());
    p.extend_from_slice(&size.height.to_le_bytes());
    write_frame(&mut std::io::stdout().lock(), OUT_CONNECTED, &p).context("send size")
}

/// After the server's Deactivate-All: rejoin at the new size, and tell the app.
fn reactivate(
    framed: &mut Framed,
    stage: &mut ActiveStage,
    factory: &ironrdp::connector::connection_activation::ConnectionActivationFactory,
    dirty: &mut Dirty,
) -> anyhow::Result<DecodedImage> {
    let size = channels::reactivate(framed, stage, factory).context("apply the new display size")?;
    *dirty = Dirty::default();
    send_connected(size)?;
    Ok(DecodedImage::new(PixelFormat::RgbA32, size.width, size.height))
}

/// Send the merged dirty rectangle, if any, as one UPDATE frame.
fn flush_dirty(dirty: &mut Dirty, image: &DecodedImage) -> anyhow::Result<()> {
    let Some((l, t, r, b)) = dirty.take() else { return Ok(()) };
    let r = r.min(usize::from(image.width()).saturating_sub(1));
    let b = b.min(usize::from(image.height()).saturating_sub(1));
    if r < l || b < t {
        return Ok(());
    }
    let mut payload = Vec::with_capacity(8 + (r + 1 - l) * (b + 1 - t) * 4);
    for v in [l, t, r + 1 - l, b + 1 - t] {
        payload.extend_from_slice(&(v as u16).to_le_bytes());
    }
    payload.extend_from_slice(&crop_rgba(image.data(), usize::from(image.width()), l, t, r, b));
    write_frame(&mut std::io::stdout().lock(), OUT_UPDATE, &payload).context("send update")
}

fn to_operations(ev: Input) -> Vec<Operation> {
    match ev {
        Input::MouseMove { x, y } => vec![Operation::MouseMove(MousePosition { x, y })],
        Input::MouseButton { button, pressed } => {
            let b = match button {
                0 => MouseButton::Left,
                1 => MouseButton::Middle,
                2 => MouseButton::Right,
                3 => MouseButton::X1,
                4 => MouseButton::X2,
                _ => return Vec::new(),
            };
            vec![if pressed { Operation::MouseButtonPressed(b) } else { Operation::MouseButtonReleased(b) }]
        }
        Input::Wheel { vertical, units } => {
            vec![Operation::WheelRotations(WheelRotations { is_vertical: vertical, rotation_units: units })]
        }
        Input::Key { scancode, extended, pressed } => {
            let sc = Scancode::from_u8(extended, scancode);
            vec![if pressed { Operation::KeyPressed(sc) } else { Operation::KeyReleased(sc) }]
        }
        Input::Disconnect | Input::Resize { .. } | Input::Clipboard(_) => Vec::new(),
    }
}

enum Flow {
    Continue,
    End(String),
    /// The server is changing the display (after a resize): run the reactivation sequence.
    Reactivate,
}

/// Write replies to the server and collect screen changes for the app.
fn handle_outputs(framed: &mut Framed, dirty: &mut Dirty, outs: Vec<ActiveStageOutput>) -> anyhow::Result<Flow> {
    for out in outs {
        match out {
            ActiveStageOutput::ResponseFrame(frame) => framed.write_all(&frame).context("write to server")?,
            ActiveStageOutput::GraphicsUpdate(rect) => {
                dirty.add(usize::from(rect.left), usize::from(rect.top), usize::from(rect.right), usize::from(rect.bottom));
            }
            ActiveStageOutput::Terminate(reason) => return Ok(Flow::End(reason.description())),
            ActiveStageOutput::DeactivateAll => return Ok(Flow::Reactivate),
            _ => {}
        }
    }
    Ok(Flow::Continue)
}

fn build_config(req: &Request, width: u16, height: u16) -> connector::Config {
    connector::Config {
        credentials: Credentials::UsernamePassword { username: req.username.clone(), password: req.password.clone() },
        domain: req.domain.clone().filter(|d| !d.is_empty()),
        enable_tls: true,
        enable_credssp: true,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: connector::DesktopSize { width, height },
        bitmap: None,
        client_build: 0,
        client_name: "SubTerm".to_owned(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
        #[cfg(windows)]
        platform: MajorPlatformType::WINDOWS,
        #[cfg(target_os = "macos")]
        platform: MajorPlatformType::MACINTOSH,
        #[cfg(not(any(windows, target_os = "macos")))]
        platform: MajorPlatformType::UNIX,
        enable_server_pointer: false,
        request_data: None,
        autologon: false,
        enable_audio_playback: req.audio,
        compression_type: None,
        pointer_software_rendering: true,
        multitransport_flags: None,
        performance_flags: PerformanceFlags::default(),
        desktop_scale_factor: 0,
        hardware_id: None,
        license_cache: None,
        timezone_info: TimezoneInfo::default(),
        alternate_shell: String::new(),
        work_dir: String::new(),
    }
}

fn connect(config: connector::Config, host: &str, port: u16, audio: bool, answers: &mut impl Read) -> anyhow::Result<(ConnectionResult, Framed)> {
    let addr = (host, port).to_socket_addrs()?.next().context("could not resolve the host name")?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(10)).context("TCP connect")?;
    tcp.set_nodelay(true).ok();
    // Generous while negotiating (NLA can wait on the server); tightened after connect.
    tcp.set_read_timeout(Some(Duration::from_secs(30)))?;
    let client_addr = tcp.local_addr().context("local address")?;

    let mut framed = ironrdp_blocking::Framed::new(tcp);
    let mut connector = connector::ClientConnector::new(config, client_addr);
    channels::attach(&mut connector, audio);
    let should_upgrade = ironrdp_blocking::connect_begin(&mut framed, &mut connector).context("begin connection")?;

    let initial = framed.into_inner_no_leftover();
    let (tls, server_public_key) = tls_upgrade(initial, host).context("TLS upgrade")?;
    // The certificate itself is not CA-checked (see tls_upgrade): the app pins it per
    // host, so ask before CredSSP sends anything derived from the password.
    write_frame(&mut std::io::stdout().lock(), OUT_CERT, &server_public_key).context("send certificate")?;
    let mut answer = [0u8; 1];
    answers.read_exact(&mut answer).context("wait for the certificate answer")?;
    anyhow::ensure!(answer[0] == 1, "the server's certificate was not trusted");
    let upgraded = ironrdp_blocking::mark_as_upgraded(should_upgrade, &mut connector);

    let mut framed = ironrdp_blocking::Framed::new(tls);
    let mut network_client = ReqwestNetworkClient;
    let result = ironrdp_blocking::connect_finalize(
        upgraded,
        connector,
        &mut framed,
        &mut network_client,
        host.to_owned().into(),
        server_public_key,
        None,
    )
    .context("finish connection (check the user name and password)")?;
    Ok((result, framed))
}

fn tls_upgrade(stream: TcpStream, host: &str) -> anyhow::Result<(Tls, Vec<u8>)> {
    // RDP servers almost always present a self-signed certificate, so it can't be
    // validated against a CA. Like mstsc, the user approves it instead: the app pins
    // the public key on first use (OUT_CERT), and NLA binds the credential exchange to it.
    let mut config = rustls::client::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(std::sync::Arc::new(danger::NoCertificateVerification))
        .with_no_client_auth();
    // CredSSP does not support TLS session resumption.
    config.resumption = rustls::client::Resumption::disabled();

    let server_name = host.to_owned().try_into()?;
    let client = rustls::ClientConnection::new(std::sync::Arc::new(config), server_name)?;
    let mut tls = rustls::StreamOwned::new(client, stream);
    tls.flush()?; // drive the handshake so the peer certificate is available

    let cert = tls.conn.peer_certificates().and_then(|c| c.first()).context("the server sent no certificate")?;
    let key = server_public_key(cert)?;
    Ok((tls, key))
}

fn server_public_key(cert: &[u8]) -> anyhow::Result<Vec<u8>> {
    use x509_cert::der::Decode as _;
    let cert = x509_cert::Certificate::from_der(cert)?;
    Ok(cert
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .as_bytes()
        .context("certificate public key is not byte aligned")?
        .to_owned())
}

mod danger {
    use tokio_rustls::rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use tokio_rustls::rustls::{pki_types, DigitallySignedStruct, Error, SignatureScheme};

    #[derive(Debug)]
    pub(super) struct NoCertificateVerification;

    impl ServerCertVerifier for NoCertificateVerification {
        fn verify_server_cert(
            &self,
            _: &pki_types::CertificateDer<'_>,
            _: &[pki_types::CertificateDer<'_>],
            _: &pki_types::ServerName<'_>,
            _: &[u8],
            _: pki_types::UnixTime,
        ) -> Result<ServerCertVerified, Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(&self, _: &[u8], _: &pki_types::CertificateDer<'_>, _: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn verify_tls13_signature(&self, _: &[u8], _: &pki_types::CertificateDer<'_>, _: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            vec![
                SignatureScheme::RSA_PKCS1_SHA1,
                SignatureScheme::ECDSA_SHA1_Legacy,
                SignatureScheme::RSA_PKCS1_SHA256,
                SignatureScheme::ECDSA_NISTP256_SHA256,
                SignatureScheme::RSA_PKCS1_SHA384,
                SignatureScheme::ECDSA_NISTP384_SHA384,
                SignatureScheme::RSA_PKCS1_SHA512,
                SignatureScheme::ECDSA_NISTP521_SHA512,
                SignatureScheme::RSA_PSS_SHA256,
                SignatureScheme::RSA_PSS_SHA384,
                SignatureScheme::RSA_PSS_SHA512,
                SignatureScheme::ED25519,
                SignatureScheme::ED448,
            ]
        }
    }
}

// Silence "unused" in the type alias use above when ActiveStage is only named in signatures.
#[allow(dead_code)]
fn _assert_types(_: &ActiveStage) {}
