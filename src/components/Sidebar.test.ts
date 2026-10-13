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
