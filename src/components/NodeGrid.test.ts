// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const { NodeGrid } = await import("./NodeGrid");
const { ConfirmProvider } = await import("../ui/confirm");

const servers = [
  { id: 1, name: "web", host: "10.0.0.11", port: 22, username: "root", protocol: "ssh", folder_id: null },
  { id: 2, name: "db", host: "10.0.0.12", port: 22, username: "root", protocol: "ssh", folder_id: null },
  { id: 3, name: "db-replica", host: "10.0.0.13", port: 22, username: "root", protocol: "ssh", folder_id: null },
];

let host: HTMLDivElement;
let root: Root;
const cb = {
  onOpenServer: vi.fn(), onAddClick: vi.fn(), onQuickConnect: vi.fn(), onQuickConnectTarget: vi.fn(),
  onImportSSHConfig: vi.fn(), onEditServer: vi.fn(), onRemoveServer: vi.fn(), onRemoveFolder: vi.fn(),
};

const mount = () => act(() => {
  root.render(createElement(ConfirmProvider as never, null, createElement(NodeGrid as never, { servers, folders: [], ...cb })));
});
const searchBox = () => host.querySelector('input[aria-label="Search servers or connect to a host"]') as HTMLInputElement;
const type = (value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => { setter.call(searchBox(), value); searchBox().dispatchEvent(new Event("input", { bubbles: true })); });
};
const enter = () => act(() => { searchBox().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
const click = (el: Element | null | undefined) => { expect(el).toBeTruthy(); act(() => { (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })); }); };

beforeEach(() => {
  Object.values(cb).forEach((f) => f.mockReset());
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  mount();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("Servers page header", () => {
  it("no longer offers Local Shell or Network Tools buttons", () => {
    expect(host.textContent).not.toContain("Local Shell");
    expect(host.textContent).not.toContain("Network Tools");
    expect(host.textContent).not.toContain("Quick connect");
  });

  it("puts Add server and a menu with Import SSH config beside the search", () => {
    const add = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Add server"));
    click(add);
    expect(cb.onAddClick).toHaveBeenCalled();
    expect(host.textContent).not.toContain("Import SSH config");
    click(host.querySelector('button[aria-label="More ways to add servers"]'));
    click([...host.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent?.includes("Import SSH config")));
    expect(cb.onImportSSHConfig).toHaveBeenCalled();
  });

  it("renders the SFTP/RDP-like header with title and subtitle", () => {
    const heading = host.querySelector("header h2");
    expect(heading).toBeTruthy();
    expect(heading?.textContent).toContain("Servers");
    expect(host.textContent).toContain("Connect to saved SSH servers, open terminal sessions, or organize into folders.");
  });

  it("the lightning button in the search box opens Quick Connect", () => {
    click(host.querySelector('button[aria-label="Quick connect"]'));
    expect(cb.onQuickConnect).toHaveBeenCalled();
  });
});

describe("Enter in the search box", () => {
  it("connects to an address that matches no saved server", () => {
    type("10.9.9.9");
    enter();
    expect(cb.onQuickConnectTarget).toHaveBeenCalledWith({ host: "10.9.9.9", port: 22, username: "" });
    expect(searchBox().value).toBe("");
  });

  it("reads user@ip and a port", () => {
    type("admin@10.9.9.9:2222");
    enter();
    expect(cb.onQuickConnectTarget).toHaveBeenCalledWith({ host: "10.9.9.9", port: 2222, username: "admin" });
  });

  it("opens the saved server when exactly one matches", () => {
    type("10.0.0.11");
    enter();
    expect(cb.onOpenServer).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(cb.onQuickConnectTarget).not.toHaveBeenCalled();
  });

  it("does nothing when several servers match, or the text is just a word", () => {
    type("db");
    enter();
    expect(cb.onOpenServer).not.toHaveBeenCalled();
    type("nomatchword");
    enter();
    expect(cb.onQuickConnectTarget).not.toHaveBeenCalled();
  });
});
