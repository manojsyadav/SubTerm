import { describe, it, expect } from "vitest";
import { readReconnectSettings, reconnectDelayMs, shouldGiveUp } from "./reconnectPolicy";

const store = (o: Record<string, string>) => ({ getItem: (k: string) => o[k] ?? null });

describe("reconnectPolicy", () => {
  it("defaults to retrying forever with a 30 s ceiling", () => {
    expect(readReconnectSettings(store({}))).toEqual({ maxAttempts: 0, maxDelaySec: 30 });
  });

  it("ignores junk and clamps the ceiling", () => {
    expect(readReconnectSettings(store({ "subterm-reconnect-max-attempts": "x", "subterm-reconnect-max-delay-sec": "99999" }))).toEqual({ maxAttempts: 0, maxDelaySec: 300 });
    expect(readReconnectSettings(store({ "subterm-reconnect-max-delay-sec": "0" })).maxDelaySec).toBe(2);
  });

  it("doubles the delay and stops at the ceiling", () => {
    const s = { maxAttempts: 0, maxDelaySec: 30 };
    expect([1, 2, 3, 4, 5, 6, 10].map((a) => reconnectDelayMs(a, s))).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(reconnectDelayMs(5, { maxAttempts: 0, maxDelaySec: 10 })).toBe(10000);
  });

  it("gives up only past a non-zero limit", () => {
    expect(shouldGiveUp(100, { maxAttempts: 0, maxDelaySec: 30 })).toBe(false);
    expect(shouldGiveUp(5, { maxAttempts: 5, maxDelaySec: 30 })).toBe(false);
    expect(shouldGiveUp(6, { maxAttempts: 5, maxDelaySec: 30 })).toBe(true);
  });
});
