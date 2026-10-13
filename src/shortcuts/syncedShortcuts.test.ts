// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const vault: Record<string, string> = {};
const invokeMock = vi.fn(async (cmd: string, args?: { map?: Record<string, string> }) => {
  if (cmd === "get_synced_shortcuts") return { ...vault };
  if (cmd === "set_synced_shortcuts") {
    for (const k of Object.keys(vault)) delete vault[k];
    Object.assign(vault, args?.map ?? {});
  }
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: { map?: Record<string, string> }) => invokeMock(cmd, args) }));

const { pullSyncedShortcuts, getCustomShortcuts, saveCustomShortcuts } = await import("./useShortcutsStore");

beforeEach(() => {
  localStorage.clear();
  for (const k of Object.keys(vault)) delete vault[k];
  invokeMock.mockClear();
});

describe("synced shortcuts", () => {
  it("uploads this device's shortcuts the first time a profile has none", async () => {
    saveCustomShortcuts({ find: "Ctrl+Shift+F" }, { sync: false });
    await pullSyncedShortcuts("work");
    expect(vault).toEqual({ find: "Ctrl+Shift+F" });
    expect(getCustomShortcuts()).toEqual({ find: "Ctrl+Shift+F" });
  });

  it("afterwards takes the vault's copy, including a reset done elsewhere", async () => {
    saveCustomShortcuts({ find: "Ctrl+Shift+F" }, { sync: false });
    await pullSyncedShortcuts("work"); // first pull imports
    for (const k of Object.keys(vault)) delete vault[k]; // another device reset everything
    await pullSyncedShortcuts("work");
    expect(getCustomShortcuts()).toEqual({});
    vault.copy = "Ctrl+Alt+C";
    await pullSyncedShortcuts("work");
    expect(getCustomShortcuts()).toEqual({ copy: "Ctrl+Alt+C" });
  });

  it("writes every save through to the vault", async () => {
    saveCustomShortcuts({ paste: "Ctrl+Alt+V" });
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith("set_synced_shortcuts", expect.objectContaining({ map: { paste: "Ctrl+Alt+V" } }));
  });
});
