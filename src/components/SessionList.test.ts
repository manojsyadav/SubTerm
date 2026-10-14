// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { SessionList } from "./SessionList";
import type { Session } from "../hooks/useSessionManager";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
afterEach(() => { act(() => root.unmount()); host.remove(); });

const sessions: Session[] = [
  { id: "session-1", serverId: 1, serverName: "web-1" },
  { id: "session-2", serverId: 2, serverName: "db-1" },
  { id: "session-3", serverId: 3, serverName: "cache" },
];

function render(extra: Record<string, unknown> = {}) {
  const props = {
    sessions, variant: "panel" as const, label: "Open servers", activeView: "session-1", mergedSessionIds: [], statuses: { "session-1": "connected" },
    meta: { names: {}, pinned: ["ssh:3"], groups: { "ssh:2": "Prod" }, collapsed: [] },
    nameOf: (s: Session) => s.serverName, onSelect: vi.fn(), onMenu: vi.fn(), onClose: vi.fn(), onToggleGroup: vi.fn(), ...extra,
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(SessionList, props)));
  return props;
}
const item = (name: string) => [...host.querySelectorAll('[role="listitem"] > button:first-child')].find((b) => b.textContent?.includes(name)) as HTMLButtonElement;

describe("SessionList", () => {
  it("shows pinned first, then groups, then the rest, and marks the active one", () => {
    render();
    expect([...host.querySelectorAll('[role="listitem"]')].map((li) => li.textContent)).toEqual(["cache", "db-1", "web-1"]);
    expect(host.textContent).toContain("Prod");
    expect(item("web-1").getAttribute("aria-current")).toBe("page");
  });

  it("selects, splits with Ctrl, opens the menu and closes", () => {
    const p = render();
    act(() => item("db-1").click());
    expect(p.onSelect).toHaveBeenLastCalledWith("session-2", false);
    act(() => { item("db-1").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })); });
    expect(p.onSelect).toHaveBeenLastCalledWith("session-2", true);
    act(() => { item("db-1").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 6 })); });
    expect(p.onMenu).toHaveBeenCalledWith("session-2", 5, 6);
    act(() => (host.querySelector('[aria-label="Close db-1"]') as HTMLButtonElement).click());
    expect(p.onClose).toHaveBeenCalledWith("session-2");
  });

  it("collapses a group", () => {
    const p = render({ meta: { names: {}, pinned: [], groups: { "ssh:2": "Prod" }, collapsed: ["Prod"] } });
    expect(host.textContent).not.toContain("db-1");
    act(() => ([...host.querySelectorAll("button")].find((b) => b.textContent === "Prod") as HTMLButtonElement).click());
    expect(p.onToggleGroup).toHaveBeenCalledWith("Prod");
  });

  it("pins and unpins from the hover button", () => {
    const onTogglePin = vi.fn();
    render({ onTogglePin });
    act(() => (host.querySelector('[aria-label="Pin web-1"]') as HTMLButtonElement).click());
    expect(onTogglePin).toHaveBeenCalledWith("ssh:1");
    act(() => (host.querySelector('[aria-label="Unpin cache"]') as HTMLButtonElement).click());
    expect(onTogglePin).toHaveBeenCalledWith("ssh:3");
  });

  it("lists pinned servers with no open session, and reconnects them on click", () => {
    const onOpenPinned = vi.fn();
    render({ sessions: [], pinnedClosed: [{ key: "ssh:9", name: "backup" }], onOpenPinned, onTogglePin: vi.fn() });
    expect(host.textContent).toContain("backup");
    act(() => item("backup").click());
    expect(onOpenPinned).toHaveBeenCalledWith("ssh:9");
    expect(host.querySelector('[aria-label="Unpin backup"]')).not.toBeNull();
  });

  it("renders nothing with no sessions and no pinned servers", () => {
    render({ sessions: [] });
    expect(host.querySelector('[role="list"]')).toBeNull();
  });
});
