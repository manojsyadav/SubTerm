// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { TerminalContextMenu, type ContextMenuState } from "./TerminalContextMenu";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(menu: ContextMenuState | null, extra: Record<string, unknown> = {}) {
  const props = {
    menu,
    onClose: vi.fn(),
    onCopy: vi.fn(),
    onPaste: vi.fn(),
    onSelectAll: vi.fn(),
    onFind: vi.fn(),
    onClear: vi.fn(),
    onReset: vi.fn(),
    onExport: vi.fn(),
    recording: false,
    onStartRecording: vi.fn(),
    onStopRecording: vi.fn(),
    alwaysRecord: false,
    onToggleAlwaysRecord: vi.fn(),
    onPasteSavedPassword: vi.fn(),
    ...extra,
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(TerminalContextMenu, props)));
  return props;
}

const buttonByText = (text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

describe("TerminalContextMenu", () => {
  it("renders null when menu is null", () => {
    render(null);
    expect(host.querySelector("button")).toBeNull();
  });

  it("renders actions and respects selection state for copy", () => {
    render({ x: 100, y: 100, hasSelection: false, hasSavedPassword: false });
    const copyBtn1 = buttonByText("Copy");
    expect(copyBtn1?.disabled).toBe(true);

    const p2 = render({ x: 100, y: 100, hasSelection: true, hasSavedPassword: false });
    const copyBtn2 = buttonByText("Copy");
    expect(copyBtn2?.disabled).toBe(false);
    act(() => copyBtn2?.click());
    expect(p2.onCopy).toHaveBeenCalled();
    expect(p2.onClose).toHaveBeenCalled();
  });

  it("handles paste, select all, find, and export", () => {
    const p = render({ x: 100, y: 100, hasSelection: true, hasSavedPassword: false });

    act(() => buttonByText("Paste")?.click());
    expect(p.onPaste).toHaveBeenCalled();

    act(() => buttonByText("Select All")?.click());
    expect(p.onSelectAll).toHaveBeenCalled();

    act(() => buttonByText("Find")?.click());
    expect(p.onFind).toHaveBeenCalled();

    act(() => buttonByText("Export Buffer")?.click());
    expect(p.onExport).toHaveBeenCalled();
  });

  it("shows paste saved password only when hasSavedPassword is true", () => {
    render({ x: 100, y: 100, hasSelection: false, hasSavedPassword: false });
    expect(buttonByText("Paste Saved Password")).toBeUndefined();

    const p = render({ x: 100, y: 100, hasSelection: false, hasSavedPassword: true });
    const pwdBtn = buttonByText("Paste Saved Password");
    expect(pwdBtn).toBeDefined();
    act(() => pwdBtn?.click());
    expect(p.onPasteSavedPassword).toHaveBeenCalled();
    expect(p.onClose).toHaveBeenCalled();
  });

  it("dismisses on Escape key", () => {
    const p = render({ x: 100, y: 100, hasSelection: false, hasSavedPassword: false });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(p.onClose).toHaveBeenCalled();
  });
});
