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
const { ConfirmProvider } = await import("../ui/confirm");

// Some tabs (Known Hosts) use the app-wide confirm dialog.
const panel = (props: Record<string, unknown>) =>
  createElement(ConfirmProvider as never, null, createElement(SettingsPanel as never, { settings, setSettings, ...props }));

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
    root.render(panel({ isUnlocked: true }));
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

  it("shows pinned servers, quick commands and keyboard shortcuts as cards on one Quick Access page", () => {
    const labels = [...host.querySelectorAll("nav button")].map((b) => b.textContent ?? "");
    expect(labels.some((l) => l.includes("Quick Access"))).toBe(true);
    expect(labels.some((l) => l.includes("Quick Commands"))).toBe(false);
    expect(labels.some((l) => l.includes("Keyboard Shortcuts"))).toBe(false);
    click(nav("Quick Access"));
    expect(host.querySelector('[role="tab"]')).toBeNull();
    for (const text of ["Pinned Servers", "Quick Commands by OS", "Keyboard Shortcuts"]) {
      expect(host.textContent, text).toContain(text);
    }
  });

  it("keeps keyboard shortcuts usable and asks to unlock the rest while the vault is locked", () => {
    act(() => { root.render(panel({ isUnlocked: false })); });
    click(nav("Quick Access"));
    expect(host.textContent).toContain("Keyboard Shortcuts");
    expect(host.textContent).toContain("need the vault unlocked");
    expect(host.textContent).not.toContain("Quick Commands by OS");
  });

  it("shows known hosts, maintenance and the activity log as cards on one System page", () => {
    const labels = [...host.querySelectorAll("nav button")].map((b) => b.textContent ?? "");
    expect(labels.some((l) => l.includes("System"))).toBe(true);
    for (const old of ["Known Hosts", "Maintenance", "Activity Log"]) expect(labels.some((l) => l.includes(old)), old).toBe(false);
    click(nav("System"));
    expect(host.querySelector('[role="tab"]')).toBeNull();
    for (const text of ["Reset Preferences", "Export Server List", "Activity Log"]) {
      expect(host.textContent, text).toContain(text);
    }
  });

  it("locks the whole System page while the vault is locked", () => {
    act(() => { root.render(panel({ isUnlocked: false })); });
    click(nav("System"));
    expect(host.textContent).toContain("Vault is locked");
    expect(host.querySelector('[role="tab"]')).toBeNull();
  });

  it("has seven pages: monitoring, profile and cloud no longer stand alone", () => {
    const labels = [...host.querySelectorAll("nav button")].map((b) => (b.textContent ?? "").trim());
    expect(labels).toEqual(["General", "Appearance", "Terminal", "Features", "Quick Access", "Accounts & Sync", "System"]);
  });

  it("puts the monitoring switch on General and the SSH keep-alive under SSH Connection", () => {
    expect(host.querySelector('[data-setting="enable-monitoring"]')).toBeTruthy();
    click(nav("Terminal"));
    const ssh = host.querySelector('[data-setting="ssh-connection"]')!;
    expect(ssh.querySelector('[data-setting="keepalive"]')).toBeTruthy();
  });

  it("shows profiles and cloud sync together on Accounts & Sync", () => {
    click(nav("Accounts & Sync"));
    expect(host.querySelector('[role="tab"]')).toBeNull();
    expect(host.textContent).toContain("Profile & Workspace Management");
    expect(host.textContent).toContain("Cloud Sync & Collaboration");
  });

  it("uses the same wide multi-column layout on every page", () => {
    for (const label of ["General", "Appearance", "Terminal", "Features", "Quick Access", "Accounts & Sync", "System"]) {
      click(nav(label));
      const container = host.querySelector("main > div") as HTMLElement;
      expect(container.className, label).toContain("max-w-[2000px]");
      expect(container.querySelector(".xl\\:columns-2"), label).toBeTruthy();
    }
  });
});
