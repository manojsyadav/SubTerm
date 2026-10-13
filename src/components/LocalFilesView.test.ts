// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const invokeMock = vi.fn(async (cmd: string, _args?: unknown) => {
  if (cmd === "local_desktop_dir") return "/home/me";
  if (cmd === "local_list_dir") return [{ name: "notes.txt", path: "/home/me/notes.txt", is_dir: false, is_symlink: false, size: 12, modified: 0 }];
  return [];
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));
vi.mock("../ui/confirm", () => ({ useConfirm: () => vi.fn(), useOverwritePrompt: () => vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const { default: LocalFilesView } = await import("./LocalFilesView");

let host: HTMLDivElement;
let root: Root;
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("LocalFilesView", () => {
  it("lists this computer's files with no server and offers no upload", async () => {
    const onBack = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root.render(createElement(LocalFilesView, { onBack })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(invokeMock).toHaveBeenCalledWith("local_list_dir", { path: "/home/me" });
    expect(host.textContent).toContain("notes.txt");
    expect([...host.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Upload")).toBe(false);
    act(() => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Servers"))!.click());
    expect(onBack).toHaveBeenCalled();
  });
});
