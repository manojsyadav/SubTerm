import { invoke } from "@tauri-apps/api/core";
import { stopRecording } from "./recorder";

// "Always record this server": saved server ids, per profile (ids restart in every
// profile's database, so the profile is part of the key). Recordings started this
// way capture output only and are saved without a dialog when the tab closes.

const key = (profile = "default") => `subterm-always-record:${profile}`;

function read(profile?: string): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(key(profile)) || "[]");
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

export const isAlwaysRecorded = (profile: string | undefined, serverId: number): boolean =>
  serverId > 0 && read(profile).includes(serverId);

export function setAlwaysRecorded(profile: string | undefined, serverId: number, on: boolean): void {
  const ids = read(profile).filter((id) => id !== serverId);
  if (on) ids.push(serverId);
  try { localStorage.setItem(key(profile), JSON.stringify(ids)); } catch { /* quota — ignore */ }
}

/** File name for an automatic recording, e.g. `web-1-2026-10-13T19-40-00.cast`. */
export const autoRecordingName = (serverName: string, at = new Date()) =>
  `${serverName || "server"}-${at.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "")}.cast`;

// Recordings started by "always record", by terminal id -> server name. Saved when
// their tab closes, or all at once when the app quits (DesktopApp's close handler).
const autoRecordings = new Map<string, string>();

export const markAutoRecording = (terminalId: string, serverName: string) => { autoRecordings.set(terminalId, serverName); };
export const unmarkAutoRecording = (terminalId: string) => { autoRecordings.delete(terminalId); };
export const isAutoRecording = (terminalId: string) => autoRecordings.has(terminalId);

/** Stop and save one automatic recording (no-op for manual ones). */
export async function saveAutoRecording(terminalId: string): Promise<void> {
  const serverName = autoRecordings.get(terminalId);
  if (serverName === undefined) return;
  autoRecordings.delete(terminalId);
  const rec = stopRecording(terminalId);
  if (!rec || rec.events.length === 0) return;
  await invoke("save_recording", { content: rec.toCast(), filename: autoRecordingName(serverName) });
}

export const saveAllAutoRecordings = () =>
  Promise.allSettled([...autoRecordings.keys()].map(saveAutoRecording));
