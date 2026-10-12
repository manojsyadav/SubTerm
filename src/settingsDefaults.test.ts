import { describe, it, expect, beforeEach, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});
vi.stubGlobal("window", { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} });

const { SETTING_DEFAULTS, ROW_SETTING_KEY, isSettingChanged, resetSetting, pageHasChanges, resetPage } = await import("./settingsDefaults");
const flags = await import("./featureFlags");

const base: Record<string, unknown> = { ...SETTING_DEFAULTS };
const as_ = (o: Record<string, unknown>) => o as never;

beforeEach(() => store.clear());

describe("settingsDefaults", () => {
  it("every mapped row has a default", () => {
    for (const key of Object.values(ROW_SETTING_KEY)) expect(key in SETTING_DEFAULTS).toBe(true);
  });

  it("detects and resets a changed setting; unset counts as default", () => {
    expect(isSettingChanged("right-click", as_(base))).toBe(false);
    const changed = as_({ ...base, rightClickAction: "menu" });
    expect(isSettingChanged("right-click", changed)).toBe(true);
    expect((resetSetting("right-click", changed) as { rightClickAction: string }).rightClickAction).toBe("smart");
    expect(isSettingChanged("right-click", as_({ ...base, rightClickAction: undefined }))).toBe(false);
  });

  it("treats a disabled feature flag as changed and re-enables it on reset", () => {
    flags.setFeatureEnabled("sshDetect", false);
    expect(isSettingChanged("sshDetect", as_(base))).toBe(true);
    expect(pageHasChanges("features", as_(base))).toBe(true);
    resetPage("features", as_(base));
    expect(flags.isFeatureEnabled("sshDetect")).toBe(true);
    expect(pageHasChanges("features", as_(base))).toBe(false);
  });

  it("resets only the settings on that page", () => {
    const s = as_({ ...base, rightClickAction: "menu", startupView: "local" });
    const out = resetPage("terminal", s) as { rightClickAction: string; startupView: string };
    expect(out.rightClickAction).toBe("smart");
    expect(out.startupView).toBe("local");
  });
});
