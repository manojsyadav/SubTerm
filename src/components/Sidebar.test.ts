// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const { Sidebar } = await import("./Sidebar");

let host: HTMLDivElement;
let root: Root;
afterEach(() => { act(() => root.unmount()); host.remove(); });

function render(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(Sidebar, { activeTab: "nodes", setActiveTab: () => {}, enableMonitoring: false, ...props })));
}
const localButton = () => [...host.querySelectorAll("button")].find((b) => b.title.startsWith("Local"))!;

describe("Sidebar Local shell menu", () => {
  let onOpenLocalShell: ReturnType<typeof vi.fn>;
  beforeEach(() => { onOpenLocalShell = vi.fn(); });

  it("opens the chosen shell from a right-click menu", () => {
    render({ localShells: [{ id: "pwsh", name: "PowerShell" }, { id: "wsl", name: "WSL" }], onOpenLocalShell });
    act(() => { localButton().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    const wsl = [...host.querySelectorAll("[role=menuitem]")].find((b) => b.textContent?.includes("WSL")) as HTMLElement;
    act(() => wsl.click());
    expect(onOpenLocalShell).toHaveBeenCalledWith("wsl");
    expect(host.querySelector("[role=menu]")).toBeNull();
  });

  it("keeps the browser menu when no shells are known", () => {
    render({ localShells: [], onOpenLocalShell });
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => { localButton().dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(false);
    expect(host.querySelector("[role=menu]")).toBeNull();
  });
});

describe("Sidebar workspace button", () => {
  it("shows the active workspace's icon and name and opens the switcher", () => {
    const onSwitchProfile = vi.fn();
    render({ workspaceName: "work", workspaceIcon: "🚀", onSwitchProfile });
    const btn = host.querySelector('[aria-label^="Workspace: work"]') as HTMLButtonElement;
    expect(btn.textContent).toBe("🚀");
    act(() => btn.click());
    expect(onSwitchProfile).toHaveBeenCalled();
  });
});

describe("Sidebar Local shell list", () => {
  it("lists the Local tab's shells under Local and selects, closes and adds them", () => {
    const onSelectLocalTab = vi.fn(), onCloseLocalTab = vi.fn(), onNewLocalTab = vi.fn();
    render({
      localTabs: [{ id: "t1", label: "PWSH", title: "pwsh (tab 1)" }, { id: "t2", label: "WSL", title: "wsl (tab 2)" }],
      activeLocalTab: "t2", onSelectLocalTab, onCloseLocalTab, onNewLocalTab,
    });
    const tabs = [...host.querySelectorAll('[role="tablist"][aria-label="Local shells"] [role="tab"]')] as HTMLButtonElement[];
    expect(tabs.map((t) => t.textContent)).toEqual(["PWSH", "WSL"]);
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    act(() => tabs[0].click());
    expect(onSelectLocalTab).toHaveBeenCalledWith("t1");
    act(() => (host.querySelector('[aria-label="Close wsl (tab 2)"]') as HTMLButtonElement).click());
    expect(onCloseLocalTab).toHaveBeenCalledWith("t2");
    act(() => (host.querySelector('[aria-label="New local shell"]') as HTMLButtonElement).click());
    expect(onNewLocalTab).toHaveBeenCalled();
  });

  it("opens a shell's tab menu on right-click", () => {
    const onLocalTabMenu = vi.fn();
    render({ localTabs: [{ id: "t1", label: "PWSH", title: "pwsh (tab 1)" }], onLocalTabMenu });
    const tab = host.querySelector('[role="tab"]') as HTMLButtonElement;
    act(() => { tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 20 })); });
    expect(onLocalTabMenu).toHaveBeenCalledWith("t1", 10, 20);
  });

  it("shows nothing extra without a Local tab", () => {
    render({ localTabs: [] });
    expect(host.querySelector('[aria-label="Local shells"]')).toBeNull();
  });
});

describe("Sidebar Local click asks which shell", () => {
  it("opens the shell picker on a plain click, with the default shell first", () => {
    const onOpenLocalShell = vi.fn();
    const setActiveTab = vi.fn();
    render({ localShells: [{ id: "wsl", name: "WSL" }], onOpenLocalShell, setActiveTab });
    act(() => localButton().click());
    expect(setActiveTab).not.toHaveBeenCalled();
    const items = [...host.querySelectorAll("[role=menuitem]")] as HTMLElement[];
    expect(items.map((b) => b.textContent)).toEqual(["Default shellSettings", "WSLwsl"]);
    act(() => items[0].click());
    expect(onOpenLocalShell).toHaveBeenCalledWith(undefined);
  });
});

describe("Sidebar mobile layout", () => {
  it("renders a bottom navigation strip across full width on mobile", () => {
    const setActiveTab = vi.fn();
    render({ isMobile: true, activeTab: "nodes", setActiveTab });
    const aside = host.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside?.className).toContain("w-full");
    expect(aside?.className).toContain("border-t");
    const nav = host.querySelector("nav");
    expect(nav?.className).toContain("flex-row");
    const buttons = host.querySelectorAll("nav button");
    expect(buttons.length).toBeGreaterThanOrEqual(4);
  });
});

