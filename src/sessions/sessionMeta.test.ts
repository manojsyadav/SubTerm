// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { metaKeyOf, orderSessions, parseMetaKey, sessionKind, useSessionMeta, type SessionMeta } from "./sessionMeta";
import { isPreferenceKey } from "../settingsBackup";
import type { Session } from "../hooks/useSessionManager";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const s = (id: string, extra: Partial<Session> = {}): Session => ({ id, serverId: 1, serverName: id, ...extra });

describe("session meta keys", () => {
  it("files each session under its list and keys it by server", () => {
    expect(sessionKind(s("a", { isLocal: true }))).toBe("local");
    expect(sessionKind(s("b", { protocol: "rdp" }))).toBe("rdp");
    expect(sessionKind(s("c", { initialTool: "sftp", toolFull: true }))).toBe("sftp");
    expect(sessionKind(s("d", { initialTool: "sftp" }))).toBe("ssh");
    expect(metaKeyOf(s("e", { serverId: 12 }))).toBe("ssh:12");
    expect(metaKeyOf(s("f", { serverId: 0 }))).toBeNull(); // quick connect
    expect(parseMetaKey("sftp:12")).toEqual({ kind: "sftp", serverId: 12 });
    expect(parseMetaKey("local")).toEqual({ kind: "local", serverId: -1 });
    expect(parseMetaKey("nope:1")).toBeNull();
  });

  it("orders pinned first, then groups alphabetically, then the rest", () => {
    const list = [s("a", { serverId: 1 }), s("b", { serverId: 2 }), s("c", { serverId: 3 }), s("d", { serverId: 4 })];
    const meta: SessionMeta = { names: {}, pinned: ["ssh:3"], groups: { "ssh:1": "Prod", "ssh:2": "Dev", "ssh:3": "Prod" }, collapsed: [] };
    expect(orderSessions(list, meta).map((g) => [g.group, g.sessions.map((x) => x.id)])).toEqual([
      [null, ["c"]], ["Dev", ["b"]], ["Prod", ["a"]], [null, ["d"]],
    ]);
  });

  it("stays out of preference backups (server ids are per workspace)", () => {
    expect(isPreferenceKey("subterm-session-meta:work")).toBe(false);
  });
});

describe("useSessionMeta", () => {
  beforeEach(() => localStorage.clear());

  it("renames, pins and groups per workspace and keeps two users of the hook in step", () => {
    let a!: ReturnType<typeof useSessionMeta>, b!: ReturnType<typeof useSessionMeta>;
    const Probe = () => { a = useSessionMeta("work"); b = useSessionMeta("work"); return null; };
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Probe)));
    act(() => { a.rename("ssh:1", "web"); a.togglePin("ssh:1"); a.setGroup("ssh:1", "Prod"); a.toggleCollapsed("Prod"); });
    expect(b.meta).toEqual({ names: { "ssh:1": "web" }, pinned: ["ssh:1"], groups: { "ssh:1": "Prod" }, collapsed: ["Prod"] });
    act(() => { a.rename("ssh:1", null); a.togglePin("ssh:1"); a.setGroup("ssh:1", null); });
    expect(b.meta).toEqual({ names: {}, pinned: [], groups: {}, collapsed: ["Prod"] });
    expect(JSON.parse(localStorage.getItem("subterm-session-meta:home") || "null")).toBeNull();
    act(() => root.unmount());
  });
});
