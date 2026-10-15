// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
}));

const { default: BrowserView } = await import("./BrowserView");

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({
    port: 47823,
    token: "testtoken",
    running: true,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("BrowserView", () => {
  it("renders with navigation controls, address bar, and iframe", async () => {
    await act(async () => {
      root.render(
        createElement(BrowserView, {
          initialUrl: "https://192.168.1.100:8006",
          serverName: "pve-01",
        })
      );
    });

    const input = host.querySelector("input[type=text]") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("https://192.168.1.100:8006");

    const iframe = host.querySelector("iframe");
    expect(iframe).toBeTruthy();
  });

  it("updates input and navigates when typing a new URL and submitting", async () => {
    await act(async () => {
      root.render(
        createElement(BrowserView, {
          initialUrl: "http://localhost:3000",
        })
      );
    });

    const input = host.querySelector("input[type=text]") as HTMLInputElement;
    const form = host.querySelector("form") as HTMLFormElement;

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "192.168.1.1:8080");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(input.value).toBe("http://192.168.1.1:8080");
  });

  it("toggles proxy mode button", async () => {
    await act(async () => {
      root.render(
        createElement(BrowserView, {
          initialUrl: "http://localhost:3000",
        })
      );
    });

    const proxyBtn = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Proxy") || b.textContent?.includes("Direct")
    );
    expect(proxyBtn).toBeTruthy();
    expect(proxyBtn?.textContent).toContain("Proxy: ON");

    await act(async () => {
      proxyBtn?.click();
    });

    expect(proxyBtn?.textContent).toContain("Direct");
  });
});
