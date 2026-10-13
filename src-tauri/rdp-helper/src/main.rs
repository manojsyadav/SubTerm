//! SubTerm RDP helper: one RDP session per process.
//!
//! Reads a JSON connection request on stdin, connects (TLS + CredSSP/NLA), then
//! streams decoded screen updates to stdout and applies mouse/keyboard events
//! arriving on stdin. See `wire.rs` for the framing. Stdout carries ONLY frames;
//! diagnostics go to stderr.

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
use wire::{crop_rgba, read_input, write_frame, Input, OUT_CERT, OUT_CLOSED, OUT_CONNECTED, OUT_ERROR, OUT_UPDATE};

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
}

type Tls = rustls::StreamOwned<rustls::ClientConnection, TcpStream>;
type Framed = ironrdp_blocking::Framed<Tls>;

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
    let (conn, mut framed) = connect(config, &req.host, req.port, &mut stdin).context("connect")?;
    let size = conn.desktop_size;
    let mut image = DecodedImage::new(PixelFormat::RgbA32, size.width, size.height);

    {
        let mut out = std::io::stdout().lock();
        let mut p = Vec::with_capacity(4);
        p.extend_from_slice(&size.width.to_le_bytes());
        p.extend_from_slice(&size.height.to_le_bytes());
        write_frame(&mut out, OUT_CONNECTED, &p)?;
    }

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

    loop {
        while let Ok(ev) = rx.try_recv() {
            if ev == Input::Disconnect {
                if let Ok(outs) = stage.graceful_shutdown() {
                    let _ = handle_outputs(&mut framed, &image, outs);
                }
                return Ok("disconnected".into());
            }
            let events = input_db.apply(to_operations(ev));
            if events.is_empty() {
                continue;
            }
            let outs = stage.process_fastpath_input(&mut image, &events).context("send input")?;
            if let Some(reason) = handle_outputs(&mut framed, &image, outs)? {
                return Ok(reason);
            }
        }

        match framed.read_pdu() {
            Ok((action, payload)) => {
                let outs = stage.process(&mut image, action, &payload).context("process frame")?;
                if let Some(reason) = handle_outputs(&mut framed, &image, outs)? {
                    return Ok(reason);
                }
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok("the server closed the connection".into()),
            Err(e) => return Err(anyhow::Error::new(e).context("read from server")),
        }
    }
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
        Input::Disconnect => Vec::new(),
    }
}

/// Write replies to the server and forward screen changes to the app.
/// Returns `Some(reason)` when the session should end.
fn handle_outputs(framed: &mut Framed, image: &DecodedImage, outs: Vec<ActiveStageOutput>) -> anyhow::Result<Option<String>> {
    for out in outs {
        match out {
            ActiveStageOutput::ResponseFrame(frame) => framed.write_all(&frame).context("write to server")?,
            ActiveStageOutput::GraphicsUpdate(rect) => {
                let (l, t) = (usize::from(rect.left), usize::from(rect.top));
                let r = usize::from(rect.right).min(usize::from(image.width()).saturating_sub(1));
                let b = usize::from(rect.bottom).min(usize::from(image.height()).saturating_sub(1));
                if r < l || b < t {
                    continue;
                }
                let mut payload = Vec::with_capacity(8 + (r + 1 - l) * (b + 1 - t) * 4);
                for v in [l, t, r + 1 - l, b + 1 - t] {
                    payload.extend_from_slice(&(v as u16).to_le_bytes());
                }
                payload.extend_from_slice(&crop_rgba(image.data(), usize::from(image.width()), l, t, r, b));
                write_frame(&mut std::io::stdout().lock(), OUT_UPDATE, &payload).context("send update")?;
            }
            ActiveStageOutput::Terminate(reason) => return Ok(Some(reason.description())),
            ActiveStageOutput::DeactivateAll => {
                return Ok(Some("the server changed the display settings; reconnect to continue".into()))
            }
            _ => {}
        }
    }
    Ok(None)
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
        enable_audio_playback: false,
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

fn connect(config: connector::Config, host: &str, port: u16, answers: &mut impl Read) -> anyhow::Result<(ConnectionResult, Framed)> {
    let addr = (host, port).to_socket_addrs()?.next().context("could not resolve the host name")?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(10)).context("TCP connect")?;
    tcp.set_nodelay(true).ok();
    // Generous while negotiating (NLA can wait on the server); tightened after connect.
    tcp.set_read_timeout(Some(Duration::from_secs(30)))?;
    let client_addr = tcp.local_addr().context("local address")?;

    let mut framed = ironrdp_blocking::Framed::new(tcp);
    let mut connector = connector::ClientConnector::new(config, client_addr);
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
