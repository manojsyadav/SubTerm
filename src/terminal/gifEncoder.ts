// Minimal animated GIF89a encoder: one global palette (up to 256 colours), full
// frames, LZW-compressed. Enough for terminal recordings, which use few colours.

export interface GifFrame {
  /** One palette index per pixel, row by row. */
  indices: Uint8Array;
  /** Display time in hundredths of a second. */
  delayCs: number;
}

class ByteWriter {
  private buf = new Uint8Array(1 << 16);
  length = 0;
  byte(b: number) {
    if (this.length === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = b & 0xff;
  }
  u16(n: number) { this.byte(n); this.byte(n >> 8); }
  bytes(a: ArrayLike<number>) { for (let i = 0; i < a.length; i++) this.byte(a[i]); }
  ascii(s: string) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
  result() { return this.buf.slice(0, this.length); }
}

/** LZW-compress `indices` into GIF data sub-blocks (same scheme as omggif). */
function writeLzw(out: ByteWriter, indices: Uint8Array, minCodeSize: number) {
  out.byte(minCodeSize);
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let table = new Map<number, number>();

  const block: number[] = [];
  let bits = 0;
  let nbits = 0;
  const emit = (code: number) => {
    bits |= code << nbits;
    nbits += codeSize;
    while (nbits >= 8) {
      block.push(bits & 0xff);
      bits >>>= 8;
      nbits -= 8;
      if (block.length === 255) { out.byte(255); out.bytes(block); block.length = 0; }
    }
  };

  emit(clearCode);
  let cur = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (cur << 8) | k;
    const hit = table.get(key);
    if (hit !== undefined) { cur = hit; continue; }
    emit(cur);
    if (nextCode === 4096) {
      emit(clearCode);
      nextCode = eoiCode + 1;
      codeSize = minCodeSize + 1;
      table = new Map();
    } else {
      if (nextCode >= 1 << codeSize) codeSize++;
      table.set(key, nextCode++);
    }
    cur = k;
  }
  emit(cur);
  emit(eoiCode);
  if (nbits > 0) block.push(bits & 0xff);
  if (block.length) { out.byte(block.length); out.bytes(block); }
  out.byte(0); // block terminator
}

/** Encode looping frames of `width` x `height` pixels over `palette` (0xRRGGBB values). */
export function encodeGif(width: number, height: number, palette: readonly number[], frames: readonly GifFrame[]): Uint8Array {
  if (palette.length === 0 || palette.length > 256) throw new Error("GIF palette must hold 1-256 colours");
  const tableBits = Math.max(1, Math.ceil(Math.log2(palette.length)));
  const out = new ByteWriter();
  out.ascii("GIF89a");
  out.u16(width);
  out.u16(height);
  out.byte(0x80 | ((tableBits - 1) << 4) | (tableBits - 1)); // global colour table
  out.byte(0); // background colour index
  out.byte(0); // pixel aspect ratio
  for (let i = 0; i < 1 << tableBits; i++) {
    const c = palette[i] ?? 0;
    out.byte(c >> 16); out.byte(c >> 8); out.byte(c);
  }
  // Loop forever (NETSCAPE2.0 application extension).
  out.bytes([0x21, 0xff, 0x0b]); out.ascii("NETSCAPE2.0"); out.bytes([0x03, 0x01, 0x00, 0x00, 0x00]);

  const minCodeSize = Math.max(2, tableBits);
  for (const f of frames) {
    out.bytes([0x21, 0xf9, 0x04, 0x00]); // graphic control extension, no transparency
    out.u16(Math.max(2, Math.round(f.delayCs)));
    out.bytes([0x00, 0x00]);
    out.byte(0x2c); // image descriptor
    out.u16(0); out.u16(0); out.u16(width); out.u16(height);
    out.byte(0);
    writeLzw(out, f.indices, minCodeSize);
  }
  out.byte(0x3b);
  return out.result();
}
