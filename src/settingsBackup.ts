/**
 * Export / import of app preferences (everything SubTerm keeps in localStorage).
 *
 * Only preference keys travel. Anything tied to this machine or this vault is left out on export
 * and refused on import: biometric unlock handles, the last workspace/session, pinned server ids,
 * connection history and anything that looks like a credential. An imported file is untrusted, so
 * import applies the same filter instead of writing whatever keys it contains.
 */
export const BACKUP_APP = "subterm-preferences";
export const BACKUP_VERSION = 1;

const INCLUDE = /^(subterm|submarine)[-_]/;
const EXCLUDE = /bio|always-record|shortcuts-imported|quick-history|last-session|last_workspace|quick-access-servers|token|secret|password|passphrase|auth|credential|private/i;
const MAX_VALUE_CHARS = 200_000;

export interface PreferencesBackup {
  app: typeof BACKUP_APP;
  version: number;
  exportedAt: string;
  prefs: Record<string, string>;
}

export const isPreferenceKey = (key: string) => INCLUDE.test(key) && !EXCLUDE.test(key);

export function buildBackup(storage: Storage = localStorage, now: Date = new Date()): PreferencesBackup {
  const prefs: Record<string, string> = {};
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key || !isPreferenceKey(key)) continue;
    const value = storage.getItem(key);
    if (value !== null) prefs[key] = value;
  }
  return { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: now.toISOString(), prefs };
}

export type ParseResult = { ok: true; backup: PreferencesBackup } | { ok: false; error: string };

export function parseBackup(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file is not valid JSON." };
  }
  const d = data as Partial<PreferencesBackup> | null;
  if (!d || d.app !== BACKUP_APP || typeof d.prefs !== "object" || d.prefs === null) {
    return { ok: false, error: "That is not a SubTerm preferences backup." };
  }
  if (typeof d.version !== "number" || d.version > BACKUP_VERSION) {
    return { ok: false, error: "This backup comes from a newer SubTerm. Update the app and try again." };
  }
  return { ok: true, backup: d as PreferencesBackup };
}

/** Writes the allowed, well-formed entries of `backup`; returns how many were applied and skipped. */
export function applyBackup(backup: PreferencesBackup, storage: Storage = localStorage): { applied: number; skipped: number } {
  let applied = 0;
  let skipped = 0;
  for (const [key, value] of Object.entries(backup.prefs)) {
    if (typeof value !== "string" || value.length > MAX_VALUE_CHARS || !isPreferenceKey(key)) {
      skipped++;
      continue;
    }
    storage.setItem(key, value);
    applied++;
  }
  return { applied, skipped };
}
