import { useSyncExternalStore } from "react";

/** A terminal session as far as the file views need to know. Published by DesktopApp. */
export interface OpenSession {
  id: string;
  name: string;
  connected: boolean;
  /** Local shells have no SFTP connection. */
  isLocal: boolean;
}

let current: OpenSession[] = [];
const listeners = new Set<() => void>();

/** Replace the list; listeners only fire when something actually changed. */
export function publishOpenSessions(list: OpenSession[]): void {
  const same =
    list.length === current.length &&
    list.every((s, i) => {
      const c = current[i];
      return c.id === s.id && c.name === s.name && c.connected === s.connected && c.isLocal === s.isLocal;
    });
  if (same) return;
  current = list;
  listeners.forEach((l) => l());
}

export const getOpenSessions = (): OpenSession[] => current;

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useOpenSessions(): OpenSession[] {
  return useSyncExternalStore(subscribe, getOpenSessions, getOpenSessions);
}

/** Sessions that can be a source or target of an SFTP copy. */
export const remoteConnected = (list: readonly OpenSession[]): OpenSession[] =>
  list.filter((s) => s.connected && !s.isLocal);
