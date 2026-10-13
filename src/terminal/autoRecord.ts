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
