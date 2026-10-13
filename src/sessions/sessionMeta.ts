import { useCallback, useEffect, useState } from "react";
import type { Session } from "../hooks/useSessionManager";

// Names, pins and groups for open sessions, shown in the sidebar session lists.
// Keyed by what a session IS (`ssh:12`, `sftp:12`, `rdp:7`, `local`), not by its
// runtime id, so they survive reconnects and restarts. Stored per workspace,
// because server ids restart in every workspace's database.

export type SessionKind = "local" | "ssh" | "sftp" | "rdp";

export interface SessionMeta {
  names: Record<string, string>;
  pinned: string[];
  groups: Record<string, string>;
  collapsed: string[];
}

const EMPTY: SessionMeta = { names: {}, pinned: [], groups: {}, collapsed: [] };
const CHANGED = "subterm-session-meta-changed";
export const metaStorageKey = (profile = "default") => `subterm-session-meta:${profile}`;

/** Which sidebar list a session belongs to. SFTP = opened as the full-width file browser. */
export function sessionKind(s: Session): SessionKind {
  if (s.isLocal) return "local";
  if (s.protocol === "rdp") return "rdp";
  return s.initialTool === "sftp" && s.toolFull ? "sftp" : "ssh";
}

/** Stable identity for meta; null for sessions without a saved server (quick connect). */
export function metaKeyOf(s: Session): string | null {
  const kind = sessionKind(s);
  if (kind === "local") return "local";
  return s.serverId > 0 ? `${kind}:${s.serverId}` : null;
}

/** `ssh:12` -> { kind: "ssh", serverId: 12 }. */
export function parseMetaKey(key: string): { kind: SessionKind; serverId: number } | null {
  if (key === "local") return { kind: "local", serverId: -1 };
  const m = /^(ssh|sftp|rdp):(\d+)$/.exec(key);
  return m ? { kind: m[1] as SessionKind, serverId: Number(m[2]) } : null;
}

export function readMeta(profile?: string): SessionMeta {
  try {
    const v = JSON.parse(localStorage.getItem(metaStorageKey(profile)) || "null");
    return v && typeof v === "object" ? { ...EMPTY, ...v } : EMPTY;
  } catch {
    return EMPTY;
  }
}

function writeMeta(profile: string | undefined, meta: SessionMeta) {
  try { localStorage.setItem(metaStorageKey(profile), JSON.stringify(meta)); } catch { /* quota — ignore */ }
  window.dispatchEvent(new CustomEvent(CHANGED));
}

/** Sessions of one list in display order: pinned first, then each group, then the rest. */
export function orderSessions(sessions: Session[], meta: SessionMeta): { group: string | null; sessions: Session[] }[] {
  const key = (s: Session) => metaKeyOf(s) ?? s.id;
  const pinned = sessions.filter((s) => meta.pinned.includes(key(s)));
  const rest = sessions.filter((s) => !meta.pinned.includes(key(s)));
  const groups = [...new Set(rest.map((s) => meta.groups[key(s)]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const out: { group: string | null; sessions: Session[] }[] = [];
  if (pinned.length) out.push({ group: null, sessions: pinned });
  for (const g of groups) out.push({ group: g, sessions: rest.filter((s) => meta.groups[key(s)] === g) });
  const loose = rest.filter((s) => !meta.groups[key(s)]);
  if (loose.length) out.push({ group: null, sessions: loose });
  return out;
}

/** Session meta for the active workspace, kept in step across components. */
export function useSessionMeta(profile?: string) {
  const [meta, setMeta] = useState<SessionMeta>(() => readMeta(profile));
  useEffect(() => {
    setMeta(readMeta(profile));
    const sync = () => setMeta(readMeta(profile));
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, [profile]);

  const update = useCallback((fn: (m: SessionMeta) => SessionMeta) => writeMeta(profile, fn(readMeta(profile))), [profile]);

  const rename = useCallback((key: string, name: string | null) => update((m) => {
    const names = { ...m.names };
    if (name) names[key] = name; else delete names[key];
    return { ...m, names };
  }), [update]);
  const togglePin = useCallback((key: string) => update((m) => ({
    ...m, pinned: m.pinned.includes(key) ? m.pinned.filter((k) => k !== key) : [...m.pinned, key],
  })), [update]);
  const setGroup = useCallback((key: string, group: string | null) => update((m) => {
    const groups = { ...m.groups };
    if (group) groups[key] = group; else delete groups[key];
    return { ...m, groups };
  }), [update]);
  const toggleCollapsed = useCallback((group: string) => update((m) => ({
    ...m, collapsed: m.collapsed.includes(group) ? m.collapsed.filter((g) => g !== group) : [...m.collapsed, group],
  })), [update]);

  return { meta, rename, togglePin, setGroup, toggleCollapsed };
}
