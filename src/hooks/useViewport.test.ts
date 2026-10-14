// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { useViewportWidth, useIsNarrow, useIsCompact, useElementWidth } from "./useViewport";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

describe("useViewportWidth, useIsNarrow, useIsCompact", () => {
  it("tracks window innerWidth and derived breakpoints", () => {
    let width = 0;
    let narrow = false;
    let compact = false;

    const Probe = () => {
      width = useViewportWidth();
      narrow = useIsNarrow();
      compact = useIsCompact();
      return null;
    };

    window.innerWidth = 1280;
    act(() => root.render(createElement(Probe)));

    expect(width).toBe(1280);
    expect(narrow).toBe(false);
    expect(compact).toBe(false);

    // Resize to compact (< 900)
    act(() => {
      window.innerWidth = 800;
      window.dispatchEvent(new Event("resize"));
    });

    expect(width).toBe(800);
    expect(narrow).toBe(false);
    expect(compact).toBe(true);

    // Resize to narrow (< 640)
    act(() => {
      window.innerWidth = 500;
      window.dispatchEvent(new Event("resize"));
    });

    expect(width).toBe(500);
    expect(narrow).toBe(true);
    expect(compact).toBe(true);
  });
});

describe("useElementWidth", () => {
  it("measures element width via ResizeObserver and layout effect", () => {
    let measuredWidth = 0;

    const observeMock = vi.fn();
    const disconnectMock = vi.fn();
    class MockResizeObserver {
      observe = observeMock;
      disconnect = disconnectMock;
      unobserve = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);

    const Probe = () => {
      const elRef = useRef<HTMLDivElement>(null);
      measuredWidth = useElementWidth(elRef);
      return createElement("div", { ref: elRef });
    };

    const origGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { width: 350, height: 100, top: 0, left: 0, bottom: 100, right: 350, x: 0, y: 0, toJSON: () => {} };
    };

    try {
      act(() => root.render(createElement(Probe)));
      expect(measuredWidth).toBe(350);
      expect(observeMock).toHaveBeenCalled();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = origGetBoundingClientRect;
    }
  });
});
