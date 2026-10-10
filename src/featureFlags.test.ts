import { describe, it, expect, beforeEach, vi } from "vitest";

// The suite runs in a plain node environment, so provide minimal browser globals.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});
vi.stubGlobal("window", { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} });
vi.stubGlobal("CustomEvent", class { constructor(public type: string, public init?: unknown) {} });

const { isFeatureEnabled, setFeatureEnabled, FEATURES } = await import("./featureFlags");

describe("featureFlags", () => {
  beforeEach(() => store.clear());

  it("defaults every flag to on", () => {
    for (const f of FEATURES) expect(isFeatureEnabled(f.key)).toBe(true);
  });

  it("persists a disabled flag and re-enables it", () => {
    setFeatureEnabled("terminalFileLinks", false);
    expect(isFeatureEnabled("terminalFileLinks")).toBe(false);
    expect(isFeatureEnabled("editorSyntaxHighlight")).toBe(true);
    setFeatureEnabled("terminalFileLinks", true);
    expect(isFeatureEnabled("terminalFileLinks")).toBe(true);
  });

  it("has unique keys and a label, description and group for every flag", () => {
    const keys = FEATURES.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of FEATURES) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.desc.length).toBeGreaterThan(0);
      expect(["Editor", "Terminal", "Panels", "AI"]).toContain(f.group);
    }
  });
});
