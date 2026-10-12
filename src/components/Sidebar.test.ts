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
const setActiveTab = vi.fn();

const mount = (props: Record<string, unknown> = {}) =>
  act(() => { root.render(createElement(Sidebar as never, { activeTab: "nodes", setActiveTab, enableMonitoring: false, ...props })); });
const titles = () => [...host.querySelectorAll("nav button")].map((b) => b.getAttribute("title"));

beforeEach(() => {
  setActiveTab.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("Sidebar", () => {
  it("lists the pages in order with the renamed entries", () => {
    mount();
    expect(titles()).toEqual(["Local", "Servers", "SFTP", "RDP", "Credentials", "Snippets", "Network Tools"]);
  });

  it("hides RDP when the feature is off", () => {
    mount({ showRdp: false });
    expect(titles()).not.toContain("RDP");
  });

  it("reports the clicked page id", () => {
    mount();
    const sftp = [...host.querySelectorAll("nav button")].find((b) => b.getAttribute("title") === "SFTP")!;
    act(() => { sftp.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(setActiveTab).toHaveBeenCalledWith("sftp");
  });
});
