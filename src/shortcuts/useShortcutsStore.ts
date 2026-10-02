import { useState, useEffect, useCallback } from "react";
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

export function saveCustomShortcuts(map: CustomShortcutMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: map }));
  } catch (e) {
    console.warn("Failed to save custom shortcuts to storage:", e);
  }
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
    const handler = (e: any) => {
      setCustomShortcuts(e.detail || getCustomShortcuts());
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
    try {
      localStorage.removeItem(STORAGE_KEY);
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: {} }));
    } catch {}
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
