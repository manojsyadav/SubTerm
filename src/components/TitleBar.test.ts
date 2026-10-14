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

  it("handles window controls (minimize, maximize/restore, close)", () => {
    const minBtn = host.querySelector('button[title="Minimize"]') as HTMLButtonElement;
    expect(minBtn).toBeDefined();
    act(() => minBtn.click());
    expect(props.appWindow.minimize).toHaveBeenCalled();

    const maxBtn = host.querySelector('button[title="Maximize"]') as HTMLButtonElement;
    expect(maxBtn).toBeDefined();
    act(() => maxBtn.click());
    expect(props.toggleMaximize).toHaveBeenCalled();

    const closeBtn = host.querySelector('button.hover\\:bg-red-500') as HTMLButtonElement;
    expect(closeBtn).toBeDefined();
    act(() => closeBtn.click());
    expect(props.appWindow.close).toHaveBeenCalled();
  });

  it("toggles command palette from the search/palette trigger", () => {
    const paletteBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Palette"));
    expect(paletteBtn).toBeDefined();
    act(() => paletteBtn?.click());
    expect(props.setIsCommandPaletteOpen).toHaveBeenCalledWith(true);
  });

  it("toggles the broadcast menu", () => {
    const broadcastBtn = host.querySelector('button[aria-label="Broadcast input"]') as HTMLButtonElement;
    expect(broadcastBtn).toBeDefined();
    act(() => broadcastBtn.click());
    expect(props.setBroadcastMenuOpen).toHaveBeenCalled();
  });

  it("renders Wall button when wallEnabled and toggles wall view", () => {
    rerender({
      wallEnabled: true,
      wallItems: [{ serverId: 1, serverName: "web-1", terminalId: "term-1" } as any],
    });
    const wallBtn = host.querySelector('button[aria-label="Wall pinboard"]') as HTMLButtonElement;
    expect(wallBtn).toBeDefined();
    expect(wallBtn.textContent).toContain("1");
    act(() => wallBtn.click());
    expect(props.setActiveView).toHaveBeenCalledWith("wall");
    expect(props.setMergedSessionIds).toHaveBeenCalledWith([]);
  });

  it("renders mobile session picker on mobile viewports and interacts with sessions", () => {
    rerender({
      isMobile: true,
      mobileSessionPickerOpen: false,
    });
    const mobilePickerBtn = host.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement;
    expect(mobilePickerBtn).toBeDefined();
    expect(mobilePickerBtn.textContent).toContain("web-1");

    act(() => mobilePickerBtn.click());
    expect(props.setMobileSessionPickerOpen).toHaveBeenCalled();

    rerender({
      isMobile: true,
      mobileSessionPickerOpen: true,
    });
    const listbox = host.querySelector('div[role="listbox"]');
    expect(listbox).toBeDefined();
    expect(listbox?.textContent).toContain("web-1");
    expect(listbox?.textContent).toContain("db-1");

    const optionBtn = listbox?.querySelector('button[role="option"]:nth-of-type(1)') as HTMLButtonElement;
    act(() => optionBtn?.click());
    expect(props.setActiveView).toHaveBeenCalledWith("session-a");
  });

  it("toggles maximize on double clicking title bar drag region", () => {
    const titleBarDiv = host.firstElementChild as HTMLDivElement;
    expect(titleBarDiv).toBeDefined();
    act(() => {
      titleBarDiv.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(props.toggleMaximize).toHaveBeenCalled();
  });
});


