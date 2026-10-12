import { describe, it, expect } from "vitest";
import { buildBackup, parseBackup, applyBackup, isPreferenceKey, BACKUP_APP } from "./settingsBackup";

const makeStorage = (init: Record<string, string> = {}): Storage => {
  const m = new Map(Object.entries(init));
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  } as Storage;
};

describe("isPreferenceKey", () => {
  it("accepts preference keys and rejects machine-bound or sensitive ones", () => {
    for (const k of ["subterm-terminal-theme", "subterm-feature-sshDetect", "submarine-sftp-bookmarks:default:x", "subterm-custom-terminal-themes"]) {
      expect(isPreferenceKey(k), k).toBe(true);
    }
    for (const k of ["subterm-master-bio", "submarine-bio-abc", "subterm_last_workspace", "subterm-last-session", "subterm-quick-access-servers",
      "submarine-quick-history", "subterm-cloud-token", "subterm-api-secret", "other-key"]) {
      expect(isPreferenceKey(k), k).toBe(false);
    }
  });
});

describe("backup round trip", () => {
  it("exports only preference keys", () => {
    const s = makeStorage({ "subterm-terminal-theme": "dracula", "subterm-master-bio": "handle", "unrelated": "x" });
    const b = buildBackup(s, new Date("2026-01-02T03:04:05Z"));
    expect(b).toMatchObject({ app: BACKUP_APP, version: 1, exportedAt: "2026-01-02T03:04:05.000Z", prefs: { "subterm-terminal-theme": "dracula" } });
    expect(Object.keys(b.prefs)).toEqual(["subterm-terminal-theme"]);
  });

  it("imports into another storage", () => {
    const parsed = parseBackup(JSON.stringify(buildBackup(makeStorage({ "subterm-startup-view": "local" }))));
    expect(parsed.ok).toBe(true);
    const target = makeStorage();
    if (parsed.ok) expect(applyBackup(parsed.backup, target)).toEqual({ applied: 1, skipped: 0 });
    expect(target.getItem("subterm-startup-view")).toBe("local");
  });
});

describe("untrusted files", () => {
  it("rejects non-JSON, foreign JSON and newer versions", () => {
    expect(parseBackup("not json")).toMatchObject({ ok: false });
    expect(parseBackup(JSON.stringify({ hello: 1 }))).toMatchObject({ ok: false });
    expect(parseBackup(JSON.stringify({ app: BACKUP_APP, version: 99, prefs: {} }))).toMatchObject({ ok: false });
    expect(parseBackup("null")).toMatchObject({ ok: false });
  });

  it("skips disallowed keys and oversized or non-string values", () => {
    const target = makeStorage();
    const r = applyBackup({
      app: BACKUP_APP, version: 1, exportedAt: "",
      prefs: { "subterm-master-bio": "x", "evil": "y", "subterm-terminal-theme": "nord", "subterm-big": "z".repeat(300_000), "subterm-num": 5 as unknown as string },
    }, target);
    expect(r).toEqual({ applied: 1, skipped: 4 });
    expect(target.getItem("subterm-terminal-theme")).toBe("nord");
    expect(target.getItem("subterm-master-bio")).toBeNull();
  });
});
