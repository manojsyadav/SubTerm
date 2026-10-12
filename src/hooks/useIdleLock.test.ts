// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { useIdleLock, useLockOnHidden } from "./useIdleLock";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const onIdle = vi.fn();

function Probe({ enabled, minutes, hidden }: { enabled: boolean; minutes: number; hidden?: boolean }) {
  useIdleLock({ enabled, minutes, onIdle });
  useLockOnHidden(!!hidden, onIdle);
  return null;
}
const mount = (props: { enabled: boolean; minutes: number; hidden?: boolean }) => act(() => { root.render(createElement(Probe, props)); });

beforeEach(() => {
  vi.useFakeTimers();
  onIdle.mockReset();
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

describe("useIdleLock", () => {
  it("fires once after the idle time", () => {
    mount({ enabled: true, minutes: 1 });
    act(() => { vi.advanceTimersByTime(59_000); });
    expect(onIdle).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(onIdle).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("input resets the timer", () => {
    mount({ enabled: true, minutes: 1 });
    act(() => { vi.advanceTimersByTime(50_000); });
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown")); });
    act(() => { vi.advanceTimersByTime(50_000); });
    expect(onIdle).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("does nothing when disabled or set to 0", () => {
    mount({ enabled: false, minutes: 1 });
    act(() => { vi.advanceTimersByTime(600_000); });
    mount({ enabled: true, minutes: 0 });
    act(() => { vi.advanceTimersByTime(600_000); });
    expect(onIdle).not.toHaveBeenCalled();
  });
});

describe("useLockOnHidden", () => {
  it("fires when the window becomes hidden", () => {
    mount({ enabled: false, minutes: 0, hidden: true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(onIdle).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
});
