// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";

interface ServerSession {
  kind: "server";
  id: number;
}

interface LocalSession {
  kind: "local";
  shell?: string;
}

type LastSession = ServerSession | LocalSession;

function resolveStartupAction(
  mode: string,
  lastSessionRaw: string | null,
  isMobile: boolean,
  servers: { id: number; name: string }[]
): { action: "local" | "server" | "servers"; target?: string | { id: number; name: string } } {
  if (mode === "local" && !isMobile) {
    return { action: "local" };
  }
  if (mode === "last") {
    try {
      const last = JSON.parse(lastSessionRaw || "null") as LastSession | null;
      if (last?.kind === "local" && !isMobile) {
        return { action: "local", target: last.shell };
      }
      if (last?.kind === "server") {
        const srv = servers.find((s) => s.id === last.id);
        if (srv) return { action: "server", target: srv };
      }
    } catch {
      // unreadable value: stay on servers view
    }
  }
  return { action: "servers" };
}

function persistLastSession(
  session: { id: string; serverId: number; isLocal?: boolean; localShell?: string; quickAuth?: boolean } | null
): void {
  if (!session || session.quickAuth) return;
  const last: LastSession | null = session.isLocal
    ? { kind: "local", shell: session.localShell }
    : session.serverId > 0
    ? { kind: "server", id: session.serverId }
    : null;
  if (last) {
    localStorage.setItem("subterm-last-session", JSON.stringify(last));
  }
}

describe("Startup View & Reopen Last Session", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists and restores a saved server session", () => {
    persistLastSession({ id: "session-42", serverId: 42, isLocal: false });
    const saved = localStorage.getItem("subterm-last-session");
    expect(saved).toBe(JSON.stringify({ kind: "server", id: 42 }));

    const servers = [{ id: 42, name: "prod-db" }, { id: 10, name: "staging" }];
    const result = resolveStartupAction("last", saved, false, servers);
    expect(result).toEqual({ action: "server", target: { id: 42, name: "prod-db" } });
  });

  it("persists and restores a local shell session", () => {
    persistLastSession({ id: "session-local", serverId: 0, isLocal: true, localShell: "pwsh" });
    const saved = localStorage.getItem("subterm-last-session");
    expect(saved).toBe(JSON.stringify({ kind: "local", shell: "pwsh" }));

    const result = resolveStartupAction("last", saved, false, []);
    expect(result).toEqual({ action: "local", target: "pwsh" });
  });

  it("never persists quick-connect sessions with inline credentials", () => {
    persistLastSession({ id: "session-quick", serverId: 99, quickAuth: true });
    expect(localStorage.getItem("subterm-last-session")).toBeNull();
  });

  it("falls back to servers view when saved server no longer exists or JSON is corrupt", () => {
    const missing = resolveStartupAction("last", JSON.stringify({ kind: "server", id: 999 }), false, [{ id: 1, name: "web" }]);
    expect(missing).toEqual({ action: "servers" });

    const corrupt = resolveStartupAction("last", "invalid-json{", false, [{ id: 1, name: "web" }]);
    expect(corrupt).toEqual({ action: "servers" });
  });

  it("handles mobile restrictions: skips local shell and falls back to servers", () => {
    const result = resolveStartupAction("local", null, true, []);
    expect(result).toEqual({ action: "servers" });

    const lastLocal = resolveStartupAction("last", JSON.stringify({ kind: "local" }), true, []);
    expect(lastLocal).toEqual({ action: "servers" });
  });
});
