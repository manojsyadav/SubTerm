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
    activeView: "session-a", appWindow: { minimize: fn(), close: fn() } as unknown as Props["appWindow"],
    broadcast: { enabled: false, selected: new Set(), toggleEnabled: fn(), toggle: fn(), selectAll: fn(), clear: fn(), removeSession: fn() } as unknown as Props["broadcast"],
    broadcastMenuOpen: false, isMaximized: false, isMobile: false, isUnlocked: true,
    mergedSessionIds: [], mobileSessionPickerOpen: false, pinTerminalToWall: fn(),
    sessionActiveTerm: {},
    sessionStatuses: { "session-a": "connected", "session-b": "connected" },
    sessions: [
      { id: "session-a", serverId: 1, serverName: "web-1" },
      { id: "session-b", serverId: 2, serverName: "db-1" },
    ],
    setActiveView: fn(), setBroadcastMenuOpen: fn(), setIsCommandPaletteOpen: fn(),     setMergedSessionIds: fn(), setMobileSessionPickerOpen: fn(), setSessionStatuses: fn(), setSessions: fn(),
    setTabMenu: fn(), renameSession: fn(), sessionMenu: { keyOf: () => null, meta: { names: {}, pinned: [], groups: {}, collapsed: [] }, togglePin: fn(), setGroup: fn(), newGroup: fn() }, sshKeys: [], tabMenu: null, tabNames: {},
    toggleMaximize: fn(), unpinSessionFromWall: fn(), unpinTerminalFromWall: fn(), wallEnabled: false, wallHasTerminal: () => false, wallItems: [],
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(TitleBar, props)));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function rerender(extra: Partial<Props>) {
  props = { ...props, ...extra };
  act(() => root.render(createElement(TitleBar, props)));
}

describe("TitleBar", () => {
  it("no longer shows a session tab strip on desktop (sessions live in the sidebar)", () => {
    expect(host.textContent).not.toContain("web-1");
    expect(host.textContent).not.toContain("db-1");
  });

  it("session menu renames, pins and groups a saved-server session", () => {
    const togglePin = vi.fn(), setGroup = vi.fn(), newGroup = vi.fn();
    rerender({
      tabMenu: { x: 10, y: 10, sessionId: "session-b" },
      sessionMenu: { keyOf: () => "ssh:2", meta: { names: {}, pinned: [], groups: { "ssh:1": "Prod" }, collapsed: [] }, togglePin, setGroup, newGroup },
    });
    const btn = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
    act(() => btn("Pin session").click());
    expect(togglePin).toHaveBeenCalledWith("ssh:2");
    rerender({ tabMenu: { x: 10, y: 10, sessionId: "session-b" } });
    act(() => btn("Prod").click());
    expect(setGroup).toHaveBeenCalledWith("ssh:2", "Prod");
    rerender({ tabMenu: { x: 10, y: 10, sessionId: "session-b" } });
    act(() => btn("+ New group").click());
    expect(newGroup).toHaveBeenCalledWith("ssh:2");
  });

  it("hides pin and group for sessions without a saved server", () => {
    rerender({ tabMenu: { x: 10, y: 10, sessionId: "session-b" } }); // keyOf returns null
    expect(host.textContent).not.toContain("Pin session");
    expect(host.textContent).toContain("Rename tab");
  });
});
