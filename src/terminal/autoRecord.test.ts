// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeMock = vi.fn(async () => "C:/rec/x.cast");
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...(a as [])) }));

const { isAlwaysRecorded, setAlwaysRecorded, autoRecordingName, markAutoRecording, saveAllAutoRecordings, isAutoRecording } = await import("./autoRecord");
const { startRecording, getRecorder, isRecording } = await import("./recorder");
import { isPreferenceKey } from "../settingsBackup";

describe("always record", () => {
  beforeEach(() => localStorage.clear());

  it("is per profile and per server", () => {
    setAlwaysRecorded("work", 3, true);
    expect(isAlwaysRecorded("work", 3)).toBe(true);
    expect(isAlwaysRecorded("home", 3)).toBe(false);
    expect(isAlwaysRecorded("work", 4)).toBe(false);
    setAlwaysRecorded("work", 3, true); // no duplicate
    expect(JSON.parse(localStorage.getItem("subterm-always-record:work")!)).toEqual([3]);
    setAlwaysRecorded("work", 3, false);
    expect(isAlwaysRecorded("work", 3)).toBe(false);
    expect(isAlwaysRecorded("work", 0)).toBe(false);
  });

  it("stays out of preference backups, which travel between machines", () => {
    expect(isPreferenceKey("subterm-always-record:work")).toBe(false);
  });

  it("names files by server and time", () => {
    expect(autoRecordingName("web-1", new Date("2026-10-13T19:40:05.123Z"))).toBe("web-1-2026-10-13T19-40-05.cast");
  });
});

describe("saving automatic recordings on quit", () => {
  it("saves every automatic recording and leaves manual ones running", async () => {
    invokeMock.mockClear();
    for (const id of ["t1", "t2", "manual"]) {
      startRecording(id, { cols: 80, rows: 24 });
      getRecorder(id)!.output(new TextEncoder().encode(`hello from ${id}`));
    }
    markAutoRecording("t1", "web-1");
    markAutoRecording("t2", "db-1");
    await saveAllAutoRecordings();
    const saved = invokeMock.mock.calls.map((c) => (c as unknown as [string, { filename: string; content: string }])[1]);
    expect(saved.map((a) => a.filename.split("-20")[0]).sort()).toEqual(["db-1", "web-1"]);
    expect(saved.every((a) => a.content.includes("hello from t"))).toBe(true);
    expect(isAutoRecording("t1") || isRecording("t1") || isRecording("t2")).toBe(false);
    expect(isRecording("manual")).toBe(true);
  });
});
