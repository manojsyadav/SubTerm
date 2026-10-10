// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The real TerminalView needs xterm + Tauri; the Wall only has to mount it per tile.
vi.mock("./TerminalView", () => ({
  default: (p: { sessionId: string; terminalId: string; attachOnly?: boolean }) =>
    createElement("span", { "data-testid": "term", "data-key": `${p.sessionId}/${p.terminalId}`, "data-attach": String(!!p.attachOnly) }),
}));

const { WallView } = await import("./WallView");

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const session = { id: "s1", serverName: "web-1", serverId: 1 } as never;

function render(over: Record<string, unknown> = {}) {
  const props = {
    wallItems: [],
    setWallItems: vi.fn(),
    wallCols: 2,
    setWallCols: vi.fn(),
    wallPickerOpen: false,
    setWallPickerOpen: vi.fn(),
    sessions: [session],
    sessionTerminals: { s1: [{ id: "t1", title: "bash" }] },
    sessionStatuses: { s1: "connected" },
    setActiveView: vi.fn(),
    wallHasTerminal: () => false,
    pinTerminalToWall: vi.fn(),
    unpinTerminalFromWall: vi.fn(),
    ...over,
  };
  act(() => root.render(createElement(WallView, props as never)));
  return props;
}

const buttonByTitle = (t: string) => host.querySelector(`button[title="${t}"]`) as HTMLButtonElement | null;

describe("WallView", () => {
  it("shows the empty-state hint when nothing is pinned", () => {
    render();
    expect(host.textContent).toContain("pinboard for watching multiple");
    expect(host.querySelectorAll("[data-testid=term]")).toHaveLength(0);
  });

  it("mounts an attach-only terminal for a pinned, connected terminal", () => {
    render({ wallItems: [{ id: "wall-t1", sessionId: "s1", terminalId: "t1" }] });
    const term = host.querySelector("[data-testid=term]")!;
    expect(term.getAttribute("data-key")).toBe("s1/t1");
    expect(term.getAttribute("data-attach")).toBe("true");
    expect(host.textContent).toContain("web-1");
  });

  it("does not mount a terminal while the session is not connected", () => {
    render({
      wallItems: [{ id: "wall-t1", sessionId: "s1", terminalId: "t1" }],
      sessionStatuses: { s1: "connecting" },
    });
    expect(host.querySelectorAll("[data-testid=term]")).toHaveLength(0);
    expect(host.textContent).toContain("Session connecting");
  });

  it("wires column selection, unpin, jump-to-session and clear", () => {
    const p = render({ wallItems: [{ id: "wall-t1", sessionId: "s1", terminalId: "t1" }] });
    act(() => { buttonByTitle("3 columns per row")!.click(); });
    expect(p.setWallCols).toHaveBeenCalledWith(3);
    act(() => { buttonByTitle("Unpin from Wall")!.click(); });
    expect(p.unpinTerminalFromWall).toHaveBeenCalledWith("t1");
    act(() => { buttonByTitle("Open this session in its own tab")!.click(); });
    expect(p.setActiveView).toHaveBeenCalledWith("s1");
    act(() => { buttonByTitle("Unpin everything (terminals stay open in their sessions)")!.click(); });
    expect(p.setWallItems).toHaveBeenCalledWith([]);
  });

  it("picker pins an unpinned terminal and unpins a pinned one", () => {
    const p = render({ wallPickerOpen: true });
    const box = host.querySelector("input[type=checkbox]") as HTMLInputElement;
    act(() => { box.click(); });
    expect(p.pinTerminalToWall).toHaveBeenCalledWith("s1", "t1");

    const q = render({ wallPickerOpen: true, wallHasTerminal: () => true });
    act(() => { (host.querySelector("input[type=checkbox]") as HTMLInputElement).click(); });
    expect(q.unpinTerminalFromWall).toHaveBeenCalledWith("t1");
  });
});
