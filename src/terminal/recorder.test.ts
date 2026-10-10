import { describe, it, expect } from "vitest";
import {
  CastRecorder, parseCast, castToPlainText, startRecording, stopRecording, isRecording, getRecorder,
  onRecordingChange, MAX_RECORDING_CHARS,
} from "./recorder";

const enc = (s: string) => new TextEncoder().encode(s);

function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
}

describe("CastRecorder", () => {
  it("writes an asciinema v2 header and relative timestamps", () => {
    const c = clock();
    const r = new CastRecorder({ cols: 80, rows: 24, title: "web-1", now: c.now });
    c.tick(1500);
    r.output(enc("hello"));
    c.tick(250);
    r.output(enc("\r\n"));
    const lines = r.toCast().trimEnd().split("\n");
    expect(JSON.parse(lines[0])).toEqual({ version: 2, width: 80, height: 24, timestamp: 1_700_000_000, title: "web-1" });
    expect(JSON.parse(lines[1])).toEqual([1.5, "o", "hello"]);
    expect(JSON.parse(lines[2])).toEqual([1.75, "o", "\r\n"]);
  });

  it("does not record input unless asked (passwords)", () => {
    const off = new CastRecorder({ cols: 80, rows: 24 });
    off.input("secret");
    expect(off.events).toHaveLength(0);
    const on = new CastRecorder({ cols: 80, rows: 24, captureInput: true });
    on.input("ls\r");
    expect(on.events.map((e) => e[1])).toEqual(["i"]);
  });

  it("records resizes", () => {
    const r = new CastRecorder({ cols: 80, rows: 24 });
    r.resize(120, 40);
    expect(r.events[0][1]).toBe("r");
    expect(r.events[0][2]).toBe("120x40");
  });

  it("keeps a multi-byte character intact when split across chunks", () => {
    const r = new CastRecorder({ cols: 80, rows: 24 });
    const bytes = enc("é"); // 2 bytes
    r.output(bytes.slice(0, 1));
    r.output(bytes.slice(1));
    expect(r.events.map((e) => e[2]).join("")).toBe("é");
  });

  it("stops appending once the size cap is reached", () => {
    const r = new CastRecorder({ cols: 80, rows: 24 });
    r.output(enc("x".repeat(1000)));
    // Force near-cap without allocating 50MB of events.
    (r as unknown as { chars: number }).chars = MAX_RECORDING_CHARS - 1;
    r.output(enc("yy"));
    expect(r.truncated).toBe(true);
    const n = r.events.length;
    r.output(enc("more"));
    expect(r.events).toHaveLength(n);
  });
});

describe("parseCast / castToPlainText", () => {
  it("round-trips a recording", () => {
    const c = clock();
    const r = new CastRecorder({ cols: 100, rows: 30, captureInput: true, now: c.now });
    c.tick(100); r.output(enc("a"));
    c.tick(100); r.input("b");
    const parsed = parseCast(r.toCast());
    expect(parsed.header.width).toBe(100);
    expect(parsed.events).toEqual(r.events);
  });

  it("rejects non-cast and unsupported-version files, skips corrupt event lines", () => {
    expect(() => parseCast("")).toThrow();
    expect(() => parseCast("hello")).toThrow(/asciinema/);
    expect(() => parseCast('{"version":1,"width":80,"height":24}')).toThrow(/version/);
    const p = parseCast('{"version":2,"width":80,"height":24}\n[0.1,"o","ok"]\n{bad\n[0.2,"x","no"]\n[0.3,"o","two"]');
    expect(p.events.map((e) => e[2])).toEqual(["ok", "two"]);
  });

  it("plain text strips colours, OSC titles and carriage returns", () => {
    const text = castToPlainText([
      [0, "o", "\x1b]0;title\x07\x1b[32mgreen\x1b[0m\r\n"],
      [0.1, "i", "ignored"],
      [0.2, "o", "done\r\n"],
    ]);
    expect(text).toBe("green\ndone\n");
  });
});

describe("recording registry", () => {
  it("tracks one recorder per terminal and notifies listeners", () => {
    let calls = 0;
    const off = onRecordingChange(() => { calls++; });
    expect(isRecording("t1")).toBe(false);
    const rec = startRecording("t1", { cols: 80, rows: 24 });
    expect(isRecording("t1")).toBe(true);
    expect(getRecorder("t1")).toBe(rec);
    expect(stopRecording("t1")).toBe(rec);
    expect(stopRecording("t1")).toBeNull();
    expect(calls).toBe(2);
    off();
  });
});
