// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../ui/confirm", () => ({ useTextPrompt: () => vi.fn() }));

const { default: AddNodePanel } = await import("./AddNodePanel");

const baseNode = {
  id: null, name: "win", host: "10.0.0.9", port: 22, username: "", password: "", authType: "vault",
  credentialId: "", folderId: "", keyId: "", proxyType: "none", proxyHost: "", proxyPort: 1080,
  tunnels: [], autostart: false, mirrors: [], color: null, notes: "", runOnConnect: "", jumpHostId: "",
  editedBy: null, updatedAt: null, password_dirty: false, is_production: false, icon: "server",
  forward_agent: false, protocol: "ssh",
};

let host: HTMLDivElement;
let root: Root;
let latest: typeof baseNode;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function Harness({ initial }: { initial: typeof baseNode }) {
  const [node, setNode] = useState(initial);
  latest = node;
  return createElement(AddNodePanel, {
    isOpen: true, onClose: () => {}, newNode: node, setNewNode: setNode as never, onSave: () => {},
    credentials: [], sshKeys: [], folders: [], servers: [], isEditMode: false, formError: "",
  } as never);
}
const render = (over: Partial<typeof baseNode> = {}) =>
  act(() => root.render(createElement(Harness, { initial: { ...baseNode, ...over } })));

const text = () => document.body.textContent ?? "";
const radio = (label: string) =>
  [...document.querySelectorAll("[role=radio]")].find((b) => b.textContent?.includes(label)) as HTMLButtonElement;

describe("AddNodePanel connection type", () => {
  it("SSH servers show the SSH-only sections", () => {
    render();
    expect(text()).toContain("How to log in");
    expect(text()).toContain("Run on connect");
    expect(text()).toContain("Port forwarding");
  });

  it("RDP servers hide SSH-only sections and explain the password handling", () => {
    render({ protocol: "rdp", port: 3389, authType: "custom_pass" });
    expect(text()).not.toContain("How to log in");
    expect(text()).not.toContain("Run on connect");
    expect(text()).not.toContain("Port forwarding");
    expect(text()).toContain("password is asked there");
    expect(text()).toContain("Production"); // shared settings stay
  });

  it("switching to RDP swaps the stock port and the login mode, and back again", () => {
    render();
    act(() => { radio("Remote Desktop").click(); });
    expect(latest.protocol).toBe("rdp");
    expect(latest.port).toBe(3389);
    expect(latest.authType).toBe("custom_pass");
    act(() => { radio("SSH").click(); });
    expect(latest.protocol).toBe("ssh");
    expect(latest.port).toBe(22);
  });

  it("keeps a custom port when switching", () => {
    render({ port: 2222 });
    act(() => { radio("Remote Desktop").click(); });
    expect(latest.port).toBe(2222);
  });

  it("hides the choice when the feature is off (unless the server is already RDP)", () => {
    localStorage.setItem("subterm-feature-rdpServers", "false");
    render();
    expect(document.querySelectorAll("[role=radio]")).toHaveLength(0);
  });
});
