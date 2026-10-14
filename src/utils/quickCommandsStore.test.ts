// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_QUICK_COMMANDS, STORAGE_KEY, loadQuickCommandsConfig } from "./quickCommandsStore";

const ids = (env: string) => loadQuickCommandsConfig()[env].commands.map((c) => c.id);

describe("new default quick commands", () => {
  beforeEach(() => localStorage.clear());

  it("reach a list saved before they shipped", () => {
    const old = { ...DEFAULT_QUICK_COMMANDS["windows-ps"], commands: [{ id: "mine", label: "x", cmd: "x\r" }] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ "windows-ps": old }));
    expect(ids("windows-ps")).toEqual(["mine", "wps-ai-1", "wps-ai-2", "wps-ai-3"]);
  });

  it("do not bring back a command the user deleted", () => {
    const old = { ...DEFAULT_QUICK_COMMANDS["windows-ps"], commands: [{ id: "mine", label: "x", cmd: "x\r" }] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ "windows-ps": old }));
    loadQuickCommandsConfig();
    // The user then removes claude.
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    saved["windows-ps"].commands = saved["windows-ps"].commands.filter((c: { id: string }) => c.id !== "wps-ai-1");
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    expect(ids("windows-ps")).not.toContain("wps-ai-1");
  });

  it("leave older defaults alone", () => {
    const old = { ...DEFAULT_QUICK_COMMANDS.linux, commands: [] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ linux: old }));
    expect(ids("linux")).toEqual([]);
  });

  it("are not re-added after a fresh install deletes one", () => {
    loadQuickCommandsConfig(); // nothing saved yet: every default counts as seen
    const cfg = { ...DEFAULT_QUICK_COMMANDS, darwin: { ...DEFAULT_QUICK_COMMANDS.darwin, commands: [] } };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    expect(ids("darwin")).toEqual([]);
  });
});
