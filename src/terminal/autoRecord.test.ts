// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { isAlwaysRecorded, setAlwaysRecorded, autoRecordingName } from "./autoRecord";
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
