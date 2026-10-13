import { describe, it, expect } from "vitest";
import { s16leToChannels } from "./audio";

describe("s16leToChannels", () => {
  it("splits interleaved stereo into channels scaled to [-1, 1)", () => {
    // L=16384 R=-32768, L=0 R=32767, plus a trailing odd byte that is ignored
    const [l, r] = s16leToChannels(Uint8Array.from([0x00, 0x40, 0x00, 0x80, 0x00, 0x00, 0xff, 0x7f, 0x01]));
    expect([...l]).toEqual([0.5, 0]);
    expect(r[0]).toBe(-1);
    expect(r[1]).toBeCloseTo(32767 / 32768);
  });
});
