// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve([])),
  Channel: class {},
}));

const { default: SettingsPanel } = await import("./SettingsPanel");

let host: HTMLDivElement;
let root: Root;

const settings = { primaryColor: "#60a5fa", backgroundColor: "#050505" } as never;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(createElement(SettingsPanel as never, { settings, setSettings: vi.fn(), isUnlocked: true }));
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const click = (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  act(() => { (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};
const nav = (label: string) => [...host.querySelectorAll("nav button")].find((b) => b.textContent?.includes(label));

describe("SettingsPanel layout", () => {
  it("starts on General with the startup setting", () => {
    expect(host.querySelector('[data-setting="startup-view"]')).toBeTruthy();
  });

  it("shows terminal behaviour rows on the Terminal page", () => {
    click(nav("Terminal"));
    for (const id of ["right-click", "open-links", "copy-on-select", "keepalive", "triggers"]) {
      expect(host.querySelector(`[data-setting="${id}"]`), id).toBeTruthy();
    }
  });

  it("nests ssh options under their feature toggle on the Features page", () => {
    click(nav("Features"));
    expect(host.querySelector('[data-setting="sshDetect"]')).toBeTruthy();
    expect(host.querySelector('[data-setting="ssh-mode"]')).toBeTruthy();
    expect(host.querySelector('[data-setting="file-types"]')).toBeTruthy();
  });

  it("keeps terminal fonts on Appearance", () => {
    click(nav("Appearance"));
    expect(host.querySelector('[data-setting="font"]')).toBeTruthy();
    expect(host.querySelector('[data-setting="accent"]')).toBeTruthy();
  });

  it("search jumps to the page that holds the setting", () => {
    const input = host.querySelector('input[placeholder="Search settings"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "paste");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const result = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Right-Click"));
    click(result);
    expect(host.querySelector('[data-setting="right-click"]')).toBeTruthy();
  });
});
