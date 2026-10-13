import { describe, it, expect } from "vitest";
import { encodeGif } from "./gifEncoder";

// Small GIF decoder for the test: reads the palette and every frame's pixels back.
function decode(gif: Uint8Array) {
  let p = 0;
  const u8 = () => gif[p++];
  const u16 = () => { const v = gif[p] | (gif[p + 1] << 8); p += 2; return v; };
  const sig = String.fromCharCode(...gif.slice(0, 6)); p = 6;
  const width = u16(); const height = u16();
  const packed = u8(); p += 2;
  const palette: number[] = [];
  for (let i = 0; i < 1 << ((packed & 7) + 1); i++) palette.push((u8() << 16) | (u8() << 8) | u8());
  const frames: { delay: number; pixels: number[] }[] = [];
  let delay = 0;
  for (;;) {
    const b = u8();
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = u8();
      if (label === 0xf9) { p += 2; delay = u16(); p += 2; continue; }
      for (let n = u8(); n; n = u8()) p += n;
      continue;
    }
    p += 9; // image descriptor
    const min = u8();
    const data: number[] = [];
    for (let n = u8(); n; n = u8()) { data.push(...gif.slice(p, p + n)); p += n; }
    const clear = 1 << min, eoi = clear + 1;
    let size = min + 1, bitPos = 0;
    const read = () => { let c = 0; for (let i = 0; i < size; i++, bitPos++) c |= ((data[bitPos >> 3] >> (bitPos & 7)) & 1) << i; return c; };
    let dict: number[][] = [];
    const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; dict[clear] = []; dict[eoi] = []; size = min + 1; };
    reset();
    const pixels: number[] = [];
    let prev: number[] | null = null;
    for (;;) {
      const code = read();
      if (code === clear) { reset(); prev = null; continue; }
      if (code === eoi) break;
      const entry: number[] = code < dict.length ? dict[code] : [...prev!, prev![0]];
      pixels.push(...entry);
      if (prev) dict.push([...prev, entry[0]]);
      prev = entry;
      if (dict.length === 1 << size && size < 12) size++;
    }
    frames.push({ delay, pixels });
  }
  return { sig, width, height, palette, frames };
}

describe("encodeGif", () => {
  it("round-trips palette, delays and pixels, including long LZW runs and table resets", () => {
    const w = 200, h = 150;
    const noisy = new Uint8Array(w * h).map((_, i) => (i * 7919 + (i >> 5)) % 5); // forces many codes and a reset
    const flat = new Uint8Array(w * h).fill(2);
    const palette = [0x0b0b0f, 0xffffff, 0xcd3131, 0x0dbc79, 0x2472c8];
    const gif = decode(encodeGif(w, h, palette, [{ indices: noisy, delayCs: 10 }, { indices: flat, delayCs: 200 }]));
    expect(gif.sig).toBe("GIF89a");
    expect([gif.width, gif.height]).toEqual([w, h]);
    expect(gif.palette.slice(0, 5)).toEqual(palette);
    expect(gif.frames.map((f) => f.delay)).toEqual([10, 200]);
    expect(gif.frames[0].pixels).toEqual([...noisy]);
    expect(gif.frames[1].pixels).toEqual([...flat]);
  });

  it("rejects a palette GIF cannot hold", () => {
    expect(() => encodeGif(1, 1, [], [])).toThrow();
    expect(() => encodeGif(1, 1, new Array(257).fill(0), [])).toThrow();
  });
});
