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

const { default: SettingsPanel, SETTINGS_INDEX } = await import("./SettingsPanel");
const { FEATURES } = await import("../featureFlags");

let host: HTMLDivElement;
let root: Root;

const setSettings = vi.fn();
let settings: Record<string, unknown> = { primaryColor: "#60a5fa", backgroundColor: "#0a0a0c" };

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  setSettings.mockReset();
  localStorage.clear();
  settings = { primaryColor: "#60a5fa", backgroundColor: "#0a0a0c" };
  render();
});

function render() {
  act(() => {
    root.render(createElement(SettingsPanel as never, { settings, setSettings, isUnlocked: true }));
  });
}

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

  it("indexes every settings row and section so search can find it", () => {
    const known = new Set([...SETTINGS_INDEX.map((e) => e.id), ...FEATURES.map((f) => f.key as string)]);
    const missing: string[] = [];
    for (const label of ["General", "Appearance", "Terminal", "Features"]) {
      click(nav(label));
      host.querySelectorAll("[data-setting]").forEach((el) => {
        const id = el.getAttribute("data-setting")!;
        if (!known.has(id)) missing.push(`${label}:${id}`);
      });
    }
    expect(missing).toEqual([]);
  });

  it("marks a changed setting and offers to reset it", () => {
    settings = { ...settings, rightClickAction: "menu" };
    render();
    click(nav("Terminal"));
    const row = host.querySelector('[data-setting="right-click"]')!;
    const dot = row.querySelector('button[aria-label="Reset to default"]');
    click(dot);
    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ rightClickAction: "smart" }));
  });

  it("shows no dots and no page reset when everything is at default", () => {
    click(nav("Terminal"));
    expect(host.querySelector('button[aria-label="Reset to default"]')).toBeNull();
    expect(host.textContent).not.toContain("Reset this page to defaults");
  });

  it("resets a whole page", () => {
    settings = { ...settings, rightClickAction: "menu", linkOpenMode: "click" };
    render();
    click(nav("Terminal"));
    vi.stubGlobal("confirm", () => true);
    window.confirm = () => true;
    click([...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Reset this page")));
    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ rightClickAction: "smart", linkOpenMode: "ctrl-click" }));
  });

  it("merges pinned servers, quick commands and keyboard shortcuts into one Quick Access page", () => {
    const labels = [...host.querySelectorAll("nav button")].map((b) => b.textContent);
    expect(labels.some((l) => l?.includes("Quick Access"))).toBe(true);
    expect(labels.some((l) => l?.includes("Quick Commands"))).toBe(false);
    expect(labels.some((l) => l?.includes("Keyboard Shortcuts"))).toBe(false);
    click(nav("Quick Access"));
    const tabs = [...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(["Pinned Servers", "Quick Commands", "Keyboard Shortcuts"]);
  });

  it("keeps the shortcuts tab usable while the vault is locked", () => {
    act(() => { root.render(createElement(SettingsPanel as never, { settings, setSettings, isUnlocked: false })); });
    click(nav("Quick Access"));
    const selected = host.querySelector('[role="tab"][aria-selected="true"]');
    expect(selected?.textContent).toContain("Keyboard Shortcuts");
    click([...host.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.includes("Pinned")));
    expect(host.textContent).toContain("Vault is locked");
  });
});
