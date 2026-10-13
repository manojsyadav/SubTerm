// Plays the RDP helper's AUDIO frames (44.1 kHz stereo s16le PCM) through WebAudio.
// Chunks are queued back to back a little ahead of the clock so network jitter
// does not cause gaps; if playback falls behind, it restarts at the current time.

export const RATE = 44_100;
export const CHANNELS = 2;
const LEAD_SECONDS = 0.15;

/** Interleaved s16le bytes -> one Float32Array per channel, in [-1, 1). */
export function s16leToChannels(bytes: Uint8Array, channels = CHANNELS): Float32Array<ArrayBuffer>[] {
  const frames = Math.floor(bytes.length / (2 * channels));
  const view = new DataView(bytes.buffer, bytes.byteOffset, frames * 2 * channels);
  const out = Array.from({ length: channels }, () => new Float32Array(new ArrayBuffer(frames * 4)));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) out[c][f] = view.getInt16((f * channels + c) * 2, true) / 32768;
  }
  return out;
}

export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private next = 0;
  private muted: boolean;

  constructor(muted = false) {
    this.muted = muted;
  }

  push(bytes: Uint8Array): void {
    if (this.muted) return;
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: RATE });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    const data = s16leToChannels(bytes);
    if (data[0].length === 0) return;
    const buf = this.ctx.createBuffer(CHANNELS, data[0].length, RATE);
    data.forEach((ch, i) => buf.copyToChannel(ch, i));
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain!);
    const now = this.ctx.currentTime;
    if (this.next < now) this.next = now + LEAD_SECONDS;
    src.start(this.next);
    this.next += buf.duration;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.close();
  }

  close(): void {
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.gain = null;
    this.next = 0;
  }
}
