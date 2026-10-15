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
    if (cmd === "local_read_file_base64") return Promise.resolve("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
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
    /too large/.test(host.textContent ?? "") ||
    !!host.querySelector("img");
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

  it("opens the in-viewer find bar on Ctrl+F and counts search matches", async () => {
    const host = await open("/r/README.md");
    expect(host.querySelector("input[placeholder='Find in document…']")).toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    });

    const searchInput = host.querySelector("input[placeholder='Find in document…']") as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();

    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      nativeSetter?.call(searchInput, "world");
      searchInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(host.textContent).toContain("1 of 1");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(host.querySelector("input[placeholder='Find in document…']")).toBeNull();
  });

  it("renders image preview with zoom controls and no edit/save buttons for image files", async () => {
    const host = await open("/r/logo.png");
    const img = host.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.src).toContain("data:image/png;base64,");
    expect(btn(host, "Edit")).toBeUndefined();
    expect(btn(host, "Save")).toBeUndefined();
    expect(host.textContent).toContain("100%");
  });
});
