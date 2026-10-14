// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { TerminalTabMenu, TAB_COLORS } from "./TerminalTabMenu";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; });

function render(over: Record<string, unknown> = {}) {
  const props = {
    x: 0, y: 0, title: "pwsh", canMoveLeft: false, canMoveRight: true, canClose: true, canCloseRight: true,
    onAction: vi.fn(), onRename: vi.fn(), onColor: vi.fn(), onDismiss: vi.fn(), ...over,
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(TerminalTabMenu, props)));
  return props;
}
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;

describe("TerminalTabMenu", () => {
  it("runs plain actions and dismisses", () => {
    const p = render();
    act(() => button("Duplicate tab").click());
    expect(p.onAction).toHaveBeenCalledWith("duplicate");
    expect(p.onDismiss).toHaveBeenCalled();
  });

  it("renames through the inline box", () => {
    const p = render();
    act(() => button("Rename tab").click());
    const input = document.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("pwsh");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "build");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(p.onRename).toHaveBeenCalledWith("build");
  });

  it("picks and resets a colour", () => {
    const p = render();
    act(() => button("Change tab color").click());
    act(() => (document.querySelector(`[aria-label="Color ${TAB_COLORS[0]}"]`) as HTMLButtonElement).click());
    expect(p.onColor).toHaveBeenCalledWith(TAB_COLORS[0]);
  });

  it("opens submenus and respects disabled moves", () => {
    const p = render();
    act(() => button("Move tab").click());
    expect(button("Move up / left").disabled).toBe(true);
    act(() => button("Move down / right").click());
    expect(p.onAction).toHaveBeenCalledWith("moveRight");
  });

  it("disables closing the last tab", () => {
    render({ canClose: false, canCloseRight: false });
    expect(button("Close tab").disabled).toBe(true);
  });

  it("handles split, export text, and find actions", () => {
    const p = render();
    act(() => button("Split tab").click());
    expect(p.onAction).toHaveBeenCalledWith("split");

    act(() => button("Export text").click());
    expect(p.onAction).toHaveBeenCalledWith("export");

    act(() => button("Find").click());
    expect(p.onAction).toHaveBeenCalledWith("find");
  });

  it("handles close submenus for other tabs and tabs below/right", () => {
    const p = render({ canClose: true, canCloseRight: true });
    act(() => button("Close").click());
    expect(button("Close other tabs").disabled).toBe(false);
    expect(button("Close tabs below / right").disabled).toBe(false);

    act(() => button("Close tabs below / right").click());
    expect(p.onAction).toHaveBeenCalledWith("closeRight");
  });

  it("disables close tabs below/right when canCloseRight is false", () => {
    const p = render({ canClose: true, canCloseRight: false });
    act(() => button("Close").click());
    expect(button("Close tabs below / right").disabled).toBe(true);

    act(() => button("Close other tabs").click());
    expect(p.onAction).toHaveBeenCalledWith("closeOthers");
  });

  it("handles pinning and unpinning", () => {
    const p1 = render({ isPinned: false });
    act(() => button("Pin tab").click());
    expect(p1.onAction).toHaveBeenCalledWith("pin");

    const p2 = render({ isPinned: true });
    act(() => button("Unpin tab").click());
    expect(p2.onAction).toHaveBeenCalledWith("pin");
  });
});

