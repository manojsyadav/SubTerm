import { useEffect, useState } from "react";

/**
 * User-controllable feature switches (Settings -> Feature Toggles).
 *
 * Every flag defaults to ON and is stored in localStorage, so it is readable
 * synchronously from anywhere (including xterm callbacks) without prop drilling.
 * Code behind a disabled flag must not load or run: gate the registration /
 * dynamic import, not just the UI.
 */
export interface FeatureDef {
  key: string;
  label: string;
  desc: string;
}

export const FEATURES = [
  {
    key: "editorSyntaxHighlight",
    label: "Editor syntax highlighting",
    desc: "Colour code in the Quick Editor (CodeMirror). When off, a plain text editor is used and the highlighting engine is never downloaded or started.",
  },
  {
    key: "terminalFileLinks",
    label: "Open files on click in terminal",
    desc: "Make file paths and file names in terminal output clickable to open them in the editor. When off, no path scanning runs on terminal output.",
  },
  {
    key: "smartPathResolve",
    label: "Smart relative-path lookup",
    desc: "Resolve relative paths against the shell's folder, your home folder, or a search on the server. When off, clicked relative paths are joined to the last known folder only.",
  },
] as const satisfies readonly FeatureDef[];

export type FeatureKey = (typeof FEATURES)[number]["key"];

const storageKey = (key: FeatureKey) => `subterm-feature-${key}`;
const CHANGED_EVENT = "subterm-feature-flags-changed";

export function isFeatureEnabled(key: FeatureKey): boolean {
  try {
    return localStorage.getItem(storageKey(key)) !== "false";
  } catch {
    return true;
  }
}

export function setFeatureEnabled(key: FeatureKey, enabled: boolean): void {
  try {
    localStorage.setItem(storageKey(key), enabled ? "true" : "false");
  } catch {
    /* storage unavailable: flag stays at its default */
  }
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { key, enabled } }));
}

/** Reactive read for components; re-renders when the flag is toggled in Settings. */
export function useFeatureFlag(key: FeatureKey): boolean {
  const [on, setOn] = useState(() => isFeatureEnabled(key));
  useEffect(() => {
    const sync = () => setOn(isFeatureEnabled(key));
    window.addEventListener(CHANGED_EVENT, sync);
    return () => window.removeEventListener(CHANGED_EVENT, sync);
  }, [key]);
  return on;
}

export { CHANGED_EVENT as FEATURE_FLAGS_CHANGED_EVENT };
