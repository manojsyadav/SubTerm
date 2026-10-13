//! Virtual channels on top of the core session: remote audio (RDPSND), text
//! clipboard (CLIPRDR) and display resizing (DRDYNVC + DisplayControl), plus the
//! deactivation-reactivation sequence a resize triggers.

use std::borrow::Cow;

use anyhow::Context as _;
use ironrdp::cliprdr::backend::CliprdrBackend;
use ironrdp::cliprdr::pdu::{
    ClipboardFormat, ClipboardFormatId, ClipboardGeneralCapabilityFlags, FileContentsRequest, FileContentsResponse,
    FormatDataRequest, FormatDataResponse, LockDataId, OwnedFormatDataResponse,
};
use ironrdp::cliprdr::CliprdrClient;
use ironrdp::connector::connection_activation::{ConnectionActivationFactory, ConnectionActivationState};
use ironrdp::connector::{self, Sequence as _};
use ironrdp::core::WriteBuf;
use ironrdp::displaycontrol::client::DisplayControlClient;
use ironrdp::displaycontrol::pdu::MonitorLayoutEntry;
use ironrdp::dvc::DrdynvcClient;
use ironrdp::rdpsnd::client::{Rdpsnd, RdpsndClientHandler};
use ironrdp::rdpsnd::pdu::{AudioFormat, PitchPdu, VolumePdu, WaveFormat};
use ironrdp::session::{fast_path, ActiveStage};

use crate::wire::{write_frame, OUT_AUDIO, OUT_CLIPBOARD};
use crate::Framed;

/// Register every optional channel. Must happen before `connect_begin`.
pub fn attach(connector: &mut connector::ClientConnector, audio: bool) {
    connector.attach_static_channel(DrdynvcClient::new().with_dynamic_channel(DisplayControlClient::new(|_caps| Ok(Vec::new()))));
    connector.attach_static_channel(CliprdrClient::new(Box::new(Clip::default())));
    if audio {
        connector.attach_static_channel(Rdpsnd::new(Box::new(AudioOut::new())));
    }
}

// ---- audio ------------------------------------------------------------------

/// Forwards the server's PCM to the app (frame OUT_AUDIO), which plays it.
/// Exactly one format is advertised, so the server either sends it or sends nothing.
#[derive(Debug)]
struct AudioOut {
    formats: [AudioFormat; 1],
}

/// 44.1 kHz stereo 16-bit little-endian PCM; every Windows server offers it.
pub const AUDIO_RATE: u32 = 44_100;
pub const AUDIO_CHANNELS: u16 = 2;

impl AudioOut {
    fn new() -> Self {
        let bits = 16u16;
        let align = AUDIO_CHANNELS * bits / 8;
        Self {
            formats: [AudioFormat {
                format: WaveFormat::PCM,
                n_channels: AUDIO_CHANNELS,
                n_samples_per_sec: AUDIO_RATE,
                n_avg_bytes_per_sec: AUDIO_RATE * u32::from(align),
                n_block_align: align,
                bits_per_sample: bits,
                data: None,
            }],
        }
    }
}

impl RdpsndClientHandler for AudioOut {
    fn get_formats(&self) -> &[AudioFormat] {
        &self.formats
    }
    fn wave(&mut self, _format_no: usize, _ts: u32, data: Cow<'_, [u8]>) {
        let _ = write_frame(&mut std::io::stdout().lock(), OUT_AUDIO, &data);
    }
    fn set_volume(&mut self, _: VolumePdu) {}
    fn set_pitch(&mut self, _: PitchPdu) {}
    fn close(&mut self) {}
}

// ---- clipboard --------------------------------------------------------------

/// Callbacks only record what happened; `pump_clipboard` acts on it after each
/// `stage.process`, when the CLIPRDR processor can be borrowed from the stage.
#[derive(Debug, Default)]
struct Clip {
    ready: bool,
    need_format_list: bool,
    remote_has_text: bool,
    server_wants_text: bool,
    server_wants_other: bool,
    remote_text: Option<String>,
}
ironrdp::core::impl_as_any!(Clip);

impl CliprdrBackend for Clip {
    fn temporary_directory(&self) -> &str {
        ".cliprdr"
    }
    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::empty()
    }
    fn on_ready(&mut self) {
        self.ready = true;
    }
    fn on_request_format_list(&mut self) {
        self.need_format_list = true;
    }
    fn on_process_negotiated_capabilities(&mut self, _: ClipboardGeneralCapabilityFlags) {}
    fn on_remote_copy(&mut self, formats: &[ClipboardFormat]) {
        self.remote_has_text = formats.iter().any(|f| f.id() == ClipboardFormatId::CF_UNICODETEXT);
    }
    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        if request.format == ClipboardFormatId::CF_UNICODETEXT {
            self.server_wants_text = true;
        } else {
            self.server_wants_other = true;
        }
    }
    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        if !response.is_error() {
            self.remote_text = response.to_unicode_string().ok();
        }
    }
    fn on_file_contents_request(&mut self, _: FileContentsRequest) {}
    fn on_file_contents_response(&mut self, _: FileContentsResponse<'_>) {}
    fn on_lock(&mut self, _: LockDataId) {}
    fn on_unlock(&mut self, _: LockDataId) {}
}

/// This side's clipboard text as the session knows it.
#[derive(Default)]
pub struct LocalClipboard {
    pub text: Option<String>,
    /// Set when the app sends new text; announced to the server once the channel is ready.
    pub changed: bool,
}

/// Answer pending clipboard events and forward remote text to the app (frame OUT_CLIPBOARD).
pub fn pump_clipboard(stage: &mut ActiveStage, framed: &mut Framed, local: &mut LocalClipboard) -> anyhow::Result<()> {
    let text_format = [ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT)];
    let mut batches = Vec::new();
    let remote_text;
    {
        let Some(c) = stage.get_svc_processor_mut::<CliprdrClient>() else { return Ok(()) };
        let b = c.downcast_backend_mut::<Clip>().context("clipboard backend")?;
        // Before Ready, a format list is only sent when the server asks (it is the handshake).
        let announce = std::mem::take(&mut b.need_format_list) || (b.ready && std::mem::take(&mut local.changed));
        let paste = b.ready && std::mem::take(&mut b.remote_has_text);
        let give = std::mem::take(&mut b.server_wants_text);
        let deny = std::mem::take(&mut b.server_wants_other);
        remote_text = b.remote_text.take();
        let formats: &[ClipboardFormat] = if local.text.is_some() { &text_format } else { &[] };
        if announce {
            batches.push(c.initiate_copy(formats)?);
        }
        if paste {
            batches.push(c.initiate_paste(ClipboardFormatId::CF_UNICODETEXT)?);
        }
        if give || deny {
            let response = match (give, &local.text) {
                (true, Some(t)) => FormatDataResponse::new_unicode_string(t),
                _ => OwnedFormatDataResponse::new_error(),
            };
            batches.push(c.submit_format_data(response)?);
        }
    }
    for m in batches {
        framed.write_all(&stage.process_svc_processor_messages(m)?).context("write clipboard")?;
    }
    if let Some(t) = remote_text {
        write_frame(&mut std::io::stdout().lock(), OUT_CLIPBOARD, t.replace("\r\n", "\n").as_bytes())?;
    }
    Ok(())
}

// ---- resize -----------------------------------------------------------------

/// The size the server will accept for a requested `width` x `height` (even width, 200-8192).
pub fn resize_target(width: u16, height: u16) -> (u32, u32) {
    MonitorLayoutEntry::adjust_display_size(width.into(), height.into())
}

/// Ask the server for a new desktop size. `Ok(false)` when DisplayControl is not
/// open yet (or has not received capabilities), so the caller retries later.
pub fn request_resize(stage: &mut ActiveStage, framed: &mut Framed, width: u16, height: u16) -> anyhow::Result<bool> {
    let ready = stage
        .get_dvc::<DisplayControlClient>()
        .and_then(|d| d.channel_processor_downcast_ref::<DisplayControlClient>())
        .is_some_and(|c| c.ready());
    if !ready {
        return Ok(false);
    }
    let (w, h) = resize_target(width, height);
    match stage.encode_resize(w, h, None, None) {
        Some(frame) => {
            framed.write_all(&frame.context("encode resize")?).context("send resize")?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Run the deactivation-reactivation sequence that follows a size change and point
/// the stage at the new share. Returns the desktop size the server settled on.
pub fn reactivate(framed: &mut Framed, stage: &mut ActiveStage, factory: &ConnectionActivationFactory) -> anyhow::Result<connector::DesktopSize> {
    let mut seq = factory.create();
    let mut buf = WriteBuf::new();
    loop {
        if let ConnectionActivationState::Finalized { desktop_size, share_id, enable_server_pointer, pointer_software_rendering } =
            seq.connection_activation_state()
        {
            stage.set_share_id(share_id);
            stage.set_enable_server_pointer(enable_server_pointer);
            stage.set_fastpath_processor(
                fast_path::ProcessorBuilder {
                    io_channel_id: seq.io_channel_id(),
                    user_channel_id: seq.user_channel_id(),
                    share_id,
                    enable_server_pointer,
                    pointer_software_rendering,
                    bulk_decompressor: None,
                }
                .build(),
            );
            return Ok(desktop_size);
        }
        buf.clear();
        let written = match seq.next_pdu_hint() {
            Some(hint) => {
                // Short socket timeout: partial data stays buffered in Framed, so just retry.
                let pdu = loop {
                    match framed.read_by_hint(hint) {
                        Ok(p) => break p,
                        Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
                        Err(e) => return Err(anyhow::Error::new(e).context("read during reactivation")),
                    }
                };
                seq.step(&pdu, &mut buf).context("reactivation step")?
            }
            None => seq.step_no_input(&mut buf).context("reactivation step")?,
        };
        if let Some(n) = written.size() {
            framed.write_all(&buf.filled()[..n]).context("write during reactivation")?;
        }
    }
}
