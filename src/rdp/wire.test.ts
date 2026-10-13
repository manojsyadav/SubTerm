import { describe, it, expect } from "vitest";
import {
  parseEvent, encodeMouseMove, encodeMouseButton, encodeWheel, encodeKey, clampPoint, wheelUnits,
  scancodeFor, ctrlAltDelete,
} from "./wire";

describe("parseEvent", () => {
  it("reads connected, error and closed messages", () => {
    expect(parseEvent(Uint8Array.from([1, 0x00, 0x05, 0xd0, 0x02]))).toEqual({ kind: "connected", width: 1280, height: 720 });
    expect(parseEvent(Uint8Array.from([3, ...new TextEncoder().encode("bad login")]))).toEqual({ kind: "error", message: "bad login" });
    expect(parseEvent(Uint8Array.from([4]))).toEqual({ kind: "closed", reason: "" });
  });

  it("reads a certificate question and ignores a malformed one", () => {
    const ask = JSON.stringify({ sessionId: "rdp-1-1", fingerprint: "SHA256:abc", mismatch: true });
    expect(parseEvent(Uint8Array.from([5, ...new TextEncoder().encode(ask)]))).toEqual({
      kind: "cert", sessionId: "rdp-1-1", fingerprint: "SHA256:abc", mismatch: true,
    });
    expect(parseEvent(Uint8Array.from([5, ...new TextEncoder().encode("{")]))).toEqual({ kind: "unknown" });
  });

  it("reads a screen update with its pixels", () => {
    const pixels = [1, 2, 3, 255, 4, 5, 6, 255];
    const ev = parseEvent(Uint8Array.from([2, 10, 0, 20, 0, 2, 0, 1, 0, ...pixels]));
    expect(ev.kind).toBe("update");
    if (ev.kind === "update") {
      expect([ev.x, ev.y, ev.width, ev.height]).toEqual([10, 20, 2, 1]);
      expect([...ev.pixels]).toEqual(pixels);
    }
  });

  it("ignores short, empty-size or unknown messages instead of throwing", () => {
    expect(parseEvent(new Uint8Array())).toEqual({ kind: "unknown" });
    expect(parseEvent(Uint8Array.from([1, 0, 0]))).toEqual({ kind: "unknown" });
    expect(parseEvent(Uint8Array.from([2, 0, 0, 0, 0, 2, 0, 2, 0, 1, 2, 3]))).toEqual({ kind: "unknown" }); // pixels truncated
    expect(parseEvent(Uint8Array.from([2, 0, 0, 0, 0, 0, 0, 5, 0]))).toEqual({ kind: "unknown" }); // zero width
    expect(parseEvent(Uint8Array.from([99]))).toEqual({ kind: "unknown" });
  });
});

describe("input encoding matches the helper's wire format", () => {
  it("encodes each event kind", () => {
    expect(encodeMouseMove(0x1234, 0x5678)).toEqual([1, 0x34, 0x12, 0x78, 0x56]);
    expect(encodeMouseButton(2, true)).toEqual([2, 2, 1]);
    expect(encodeWheel(true, -2)).toEqual([3, 1, 0xfe, 0xff]);
    expect(encodeKey(0x1d, true, false)).toEqual([4, 0x1d, 1, 0]);
  });
});

describe("pointer and wheel maths", () => {
  it("clamps into the remote screen", () => {
    expect(clampPoint(-5, 9999, 1280, 720)).toEqual([0, 719]);
    expect(clampPoint(10.6, 20.4, 1280, 720)).toEqual([11, 20]);
  });

  it("converts browser wheel deltas to RDP units with the sign flipped", () => {
    expect(wheelUnits(100, 0)).toBe(-120); // one notch down
    expect(wheelUnits(-100, 0)).toBe(120); // one notch up
    expect(wheelUnits(3, 1)).toBe(-360); // three lines down
    expect(wheelUnits(25, 0)).toBe(-30); // fine-grained trackpad scrolling stays proportional
    expect(wheelUnits(0.001, 0)).toBe(-120); // a delta that rounds to nothing still moves one notch
    expect(wheelUnits(0, 0)).toBe(0);
    expect(wheelUnits(1e9, 0)).toBe(-32768); // clamped to i16
  });
});

describe("keyboard", () => {
  it("maps physical keys, with extended keys flagged", () => {
    expect(scancodeFor("KeyA")).toEqual([0x1e, false]);
    expect(scancodeFor("Enter")).toEqual([0x1c, false]);
    expect(scancodeFor("NumpadEnter")).toEqual([0x1c, true]);
    expect(scancodeFor("ArrowUp")).toEqual([0x48, true]);
    expect(scancodeFor("Delete")).toEqual([0x53, true]);
    expect(scancodeFor("ControlRight")).toEqual([0x1d, true]);
    expect(scancodeFor("MediaPlayPause")).toBeNull();
  });

  it("has no two plain keys sharing a scancode", () => {
    const codes = ["KeyA", "KeyB", "KeyC", "Digit1", "F1", "F12", "Space", "Tab", "Escape", "Backquote", "IntlBackslash"];
    const seen = codes.map((c) => scancodeFor(c)![0]);
    expect(new Set(seen).size).toBe(codes.length);
  });

  it("Ctrl+Alt+Del presses in order and releases in reverse", () => {
    const seq = ctrlAltDelete();
    expect(seq).toEqual([
      4, 0x1d, 0, 1, 4, 0x38, 0, 1, 4, 0x53, 1, 1,
      4, 0x53, 1, 0, 4, 0x38, 0, 0, 4, 0x1d, 0, 0,
    ]);
  });
});
