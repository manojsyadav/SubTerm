import { describe, it, expect } from "vitest";
import { compressIdle, countPlayed, parseResize, formatClock } from "./playback";
import type { CastEvent } from "./recorder";

const ev = (t: number, d = "x"): CastEvent => [t, "o", d];

describe("compressIdle", () => {
  it("caps long gaps and keeps later events in order", () => {
    const out = compressIdle([ev(0.1), ev(0.5), ev(30), ev(30.2), ev(100)], 2);
    [0.1, 0.5, 2.5, 2.7, 4.7].forEach((want, i) => expect(out[i][0]).toBeCloseTo(want, 6));
  });
  it("leaves short gaps alone and does not mutate the input", () => {
    const input = [ev(1), ev(2), ev(3)];
    expect(compressIdle(input, 2)).toEqual(input);
    const long = [ev(10)];
    compressIdle(long, 2);
    expect(long[0][0]).toBe(10);
  });
  it("caps a long wait before the very first event", () => {
    expect(compressIdle([ev(20)], 2)[0][0]).toBe(2);
  });
});

describe("countPlayed", () => {
  const events = [ev(0), ev(1), ev(1), ev(3)];
  it("counts events at or before t", () => {
    expect(countPlayed(events, -1)).toBe(0);
    expect(countPlayed(events, 0)).toBe(1);
    expect(countPlayed(events, 1)).toBe(3);
    expect(countPlayed(events, 2.9)).toBe(3);
    expect(countPlayed(events, 3)).toBe(4);
    expect(countPlayed([], 5)).toBe(0);
  });
});

describe("helpers", () => {
  it("parses resize payloads", () => {
    expect(parseResize("120x40")).toEqual({ cols: 120, rows: 40 });
    expect(parseResize("0x10")).toBeNull();
    expect(parseResize("abc")).toBeNull();
  });
  it("formats clock", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(75.9)).toBe("1:15");
  });
});
