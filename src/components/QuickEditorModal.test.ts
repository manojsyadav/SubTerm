// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const files: Record<string, string> = { "/r/README.md": "# Hello\n\nworld", "/r/a.conf": "port=1" };
const writes: string[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, a: { localPath: string }) => {
    if (cmd === "local_write_file_text") { writes.push(a.localPath); return Promise.resolve(); }
    if (a.localPath === "/r/huge.log") return Promise.reject("File is too large (6120000 bytes, limit is 2097152 bytes)");
    return Promise.resolve(files[a.localPath]);
  }),
}));
// Plain textarea instead of CodeMirror, which jsdom cannot lay out.
vi.mock("../featureFlags", () => ({ useFeatureFlag: () => false }));
const { QuickEditorModal } = await import("./QuickEditorModal");

let root: Root;
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; });

async function open(path: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const entry = { name: path.split("/").pop()!, path, isDir: false };
  await act(async () => {
    root.render(createElement(QuickEditorModal, { isOpen: true, onClose: () => {}, entry: entry as never, provider: { id: "local", label: "Local" } }));
  });
  // Wait for the file read (Edit enables) or its error, and for the lazy Markdown view; a fixed
  // number of ticks was not enough when the whole suite runs in parallel.
  const ready = () =>
    (btn(host, "Edit")?.disabled === false && (!/\.md$/i.test(path) || !!host.querySelector("h1"))) ||
    /too large/.test(host.textContent ?? "");
  for (let i = 0; i < 200 && !ready(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host;
}
const btn = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

describe("QuickEditorModal viewer mode", () => {
  it("opens a file read-only with no Save button, and Edit makes it editable", async () => {
    const host = await open("/r/a.conf");
    const ta = host.querySelector("textarea")!;
    expect(ta.readOnly).toBe(true);
    expect(btn(host, "Save")).toBeUndefined();
    act(() => btn(host, "Edit")!.click());
    expect(host.querySelector("textarea")!.readOnly).toBe(false);
    expect(btn(host, "Save")).toBeDefined();
  });

  it("cannot edit or save a file that failed to load, so it is never overwritten", async () => {
    const host = await open("/r/huge.log");
    expect(host.textContent).toContain("too large");
    expect(btn(host, "Edit")!.disabled).toBe(true);
    act(() => btn(host, "Edit")!.click());
    expect(host.querySelector("textarea")!.readOnly).toBe(true);
    expect(btn(host, "Save")).toBeUndefined();
    host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(writes).toEqual([]);
  });

  it("renders Markdown in the viewer and shows the source in Edit", async () => {
    const host = await open("/r/README.md");
    expect(host.querySelector("h1")?.textContent).toBe("Hello");
    expect(host.querySelector("textarea")).toBeNull();
    act(() => btn(host, "Edit")!.click());
    expect(host.querySelector("textarea")!.value).toBe("# Hello\n\nworld");
  });
});
