import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_SHORTCUTS } from "./defaults";
import { CustomShortcutMap } from "./types";
import { normalizeKeyCombo } from "./keyUtils";

const STORAGE_KEY = "subterm-custom-shortcuts";
const EVENT_NAME = "subterm-shortcuts-changed";

export function getCustomShortcuts(): CustomShortcutMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn("Failed to parse custom shortcuts from storage:", e);
  }
  return {};
}

/** Cmd and Ctrl differ, so Mac shortcuts sync only between Macs, and the rest between each other. */
export const SHORTCUT_PLATFORM: "mac" | "pc" =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent) ? "mac" : "pc";

/**
 * localStorage is the working copy every shortcut lookup reads synchronously; the
 * unlocked vault holds the synced copy. A save writes both (the vault write fails
 * quietly while locked and is caught up by the next pull).
 */
export function saveCustomShortcuts(map: CustomShortcutMap, opts: { sync?: boolean } = {}) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: map }));
  } catch (e) {
    console.warn("Failed to save custom shortcuts to storage:", e);
  }
  if (opts.sync !== false) {
    invoke("set_synced_shortcuts", { platform: SHORTCUT_PLATFORM, map }).catch(() => { /* vault locked */ });
  }
}

/** Upload the working copy, e.g. after a preferences import wrote it directly. */
export const pushSyncedShortcuts = (): Promise<void> =>
  invoke<void>("set_synced_shortcuts", { platform: SHORTCUT_PLATFORM, map: getCustomShortcuts() }).catch(() => { /* vault locked */ });

const importedKey = (profile: string) => `subterm-shortcuts-imported:${profile}`;

const sameMap = (a: CustomShortcutMap, b: CustomShortcutMap) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

/**
 * Bring the vault's shortcuts into the working copy (after unlock and after each
 * sync). The first time a profile is seen on this device, shortcuts customised
 * here before syncing existed are uploaded instead of being replaced by nothing.
 */
export async function pullSyncedShortcuts(profile: string): Promise<void> {
  const synced = await invoke<CustomShortcutMap>("get_synced_shortcuts", { platform: SHORTCUT_PLATFORM });
  const local = getCustomShortcuts();
  if (!localStorage.getItem(importedKey(profile))) {
    localStorage.setItem(importedKey(profile), "1");
    if (Object.keys(synced).length === 0 && Object.keys(local).length > 0) {
      await invoke("set_synced_shortcuts", { platform: SHORTCUT_PLATFORM, map: local });
      return;
    }
  }
  if (!sameMap(synced, local)) saveCustomShortcuts(synced, { sync: false });
}

export function getActiveShortcut(actionId: string, customMap?: CustomShortcutMap): string {
  const map = customMap || getCustomShortcuts();
  if (map[actionId]) {
    return map[actionId];
  }
  const def = DEFAULT_SHORTCUTS.find((a) => a.id === actionId);
  return def?.defaultKey || "";
}

export function useShortcutsStore() {
  const [customShortcuts, setCustomShortcuts] = useState<CustomShortcutMap>(getCustomShortcuts);

  useEffect(() => {
    const handler = (e: Event) => {
      setCustomShortcuts((e as CustomEvent<CustomShortcutMap>).detail || getCustomShortcuts());
    };
    window.addEventListener(EVENT_NAME, handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener(EVENT_NAME, handler);
      window.removeEventListener("storage", handler);
    };
  }, []);

  const getShortcut = useCallback(
    (actionId: string): string => {
      return getActiveShortcut(actionId, customShortcuts);
    },
    [customShortcuts]
  );

  const updateShortcut = useCallback(
    (actionId: string, combo: string) => {
      const normalized = normalizeKeyCombo(combo);
      const next = { ...customShortcuts, [actionId]: normalized };
      setCustomShortcuts(next);
      saveCustomShortcuts(next);
    },
    [customShortcuts]
  );

  const resetShortcut = useCallback(
    (actionId: string) => {
      const next = { ...customShortcuts };
      delete next[actionId];
      setCustomShortcuts(next);
      saveCustomShortcuts(next);
    },
    [customShortcuts]
  );

  const resetAll = useCallback(() => {
    setCustomShortcuts({});
    saveCustomShortcuts({});
  }, []);

  const isCustomized = useCallback(
    (actionId: string): boolean => {
      return Boolean(customShortcuts[actionId]);
    },
    [customShortcuts]
  );

  const getConflict = useCallback(
    (targetActionId: string, newCombo: string): string | null => {
      const normalizedNew = normalizeKeyCombo(newCombo);
      if (!normalizedNew) return null;

      for (const action of DEFAULT_SHORTCUTS) {
        if (action.id === targetActionId) continue;
        const currentCombo = getActiveShortcut(action.id, customShortcuts);
        if (normalizeKeyCombo(currentCombo) === normalizedNew) {
          return action.name;
        }
      }
      return null;
    },
    [customShortcuts]
  );

  return {
    customShortcuts,
    getShortcut,
    updateShortcut,
    resetShortcut,
    resetAll,
    isCustomized,
    getConflict,
  };
}
