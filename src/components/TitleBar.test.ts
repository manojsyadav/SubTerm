// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const { TitleBar } = await import("./TitleBar");
type Props = Parameters<typeof TitleBar>[0];

let host: HTMLDivElement;
let root: Root;
let props: Props;

beforeEach(() => {
  const fn = () => vi.fn();
  props = {
    confirm: vi.fn(async () => true) as unknown as Props["confirm"],
    activeProfile: "work", activeView: "session-a", appWindow: { minimize: fn(), close: fn() } as unknown as Props["appWindow"],
    availableShells: [], broadcast: { enabled: false, selected: new Set(), toggleEnabled: fn(), toggle: fn(), selectAll: fn(), clear: fn(), removeSession: fn() } as unknown as Props["broadcast"],
    broadcastMenuOpen: false, closeSession: fn(), handleLockProfile: vi.fn(async () => {}), isMaximized: false, isMobile: false, isUnlocked: true,
    mergedSessionIds: [], mobileSessionPickerOpen: false, openDefaultLocal: fn(), openLocalTerminal: fn(), openServer: fn(), pinTerminalToWall: fn(),
    profileDropdownOpen: false, profileIcon: "user", quickAccessServersList: [], sessionActiveTerm: {},
    sessionStatuses: { "session-a": "connected", "session-b": "connected" },
    sessions: [
      { id: "session-a", serverId: 1, serverName: "web-1" },
      { id: "session-b", serverId: 2, serverName: "db-1" },
    ],
    setActiveView: fn(), setBroadcastMenuOpen: fn(), setIsCommandPaletteOpen: fn(), setIsUnlockModalOpen: fn(), setIsWorkspaceSwitcherOpen: fn(),
    setMergedSessionIds: fn(), setMobileSessionPickerOpen: fn(), setProfileDropdownOpen: fn(), setSessionStatuses: fn(), setSessions: fn(),
    setShellMenuOpen: fn(), setTabMenu: fn(), setTabNames: fn(), shellMenuOpen: false, sshKeys: [], tabMenu: null, tabNames: {},
    toggleMaximize: fn(), unpinSessionFromWall: fn(), unpinTerminalFromWall: fn(), wallEnabled: false, wallHasTerminal: () => false, wallItems: [],
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(TitleBar, props)));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const tab = (name: string) => [...host.querySelectorAll("div")].reverse().find((d) => d.textContent?.trim().startsWith(name) && d.querySelector('[aria-label="Close session"]'))!;

describe("TitleBar session tabs", () => {
  it("shows every session and switches on click", () => {
    expect(host.textContent).toContain("web-1");
    expect(host.textContent).toContain("db-1");
    act(() => tab("db-1").click());
    expect(props.setActiveView).toHaveBeenCalledWith("session-b");
    expect(props.setMergedSessionIds).toHaveBeenCalledWith([]);
  });

  it("asks through the app's confirm dialog before closing a connected session", async () => {
    const close = tab("db-1").querySelector('[aria-label="Close session"]') as HTMLButtonElement;
    await act(async () => { close.click(); });
    expect(props.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Close this session?" }));
    expect(props.setSessions).toHaveBeenCalled();
  });
});
