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
  group: "Editor" | "Terminal" | "Panels" | "AI";
  label: string;
  desc: string;
}

export const FEATURES = [
  {
    key: "editorSyntaxHighlight",
    group: "Editor",
    label: "Editor syntax highlighting",
    desc: "Colour code in the Quick Editor (CodeMirror). When off, a plain text editor is used and the highlighting engine is never downloaded or started.",
  },
  {
    key: "terminalFileLinks",
    group: "Terminal",
    label: "Open file in editor on click",
    desc: "Click a file path or file name in terminal output to open it in the editor, including relative paths (looked up in the shell's folder, your home folder, or by search on the server). When off, no path scanning or lookup runs.",
  },
  {
    key: "terminalCommandBlocks",
    group: "Terminal",
    label: "Command blocks and quick actions",
    desc: "Track each command's output and exit status and show the floating Copy Output / Explain bar. When off, no per-command tracking runs on terminal output.",
  },
  {
    key: "commandHistory",
    group: "Terminal",
    label: "Command history capture",
    desc: "Record the commands you type (per server) for Ctrl+R history search. When off, nothing you type is saved. The production-server destructive-command warning still works.",
  },
  {
    key: "fleetWall",
    group: "Panels",
    label: "Session Wall",
    desc: "Multi-terminal pinboard view. When off, the Wall tab, its command-palette entry and its terminal tiles are not created.",
  },
  {
    key: "networkTools",
    group: "Panels",
    label: "Network Tools",
    desc: "Ping / DNS / port-check tools modal on the server list. When off, the tool code is not loaded.",
  },
  {
    key: "panelTunnels",
    group: "Panels",
    label: "Ports panel",
    desc: "Port-forwarding tab in the session toolbar.",
  },
  {
    key: "panelDocker",
    group: "Panels",
    label: "Docker panel",
    desc: "Containers and images tab. When off, the panel code is not loaded and nothing polls Docker.",
  },
  {
    key: "panelProcesses",
    group: "Panels",
    label: "Processes panel",
    desc: "Task-manager tab. When off, the panel code is not loaded and no process polling runs.",
  },
  {
    key: "panelServices",
    group: "Panels",
    label: "Services panel",
    desc: "System-services tab. When off, the panel code is not loaded.",
  },
  {
    key: "panelSystem",
    group: "Panels",
    label: "System panel",
    desc: "Hardware, network and OS info tab. When off, the panel code is not loaded.",
  },
  {
    key: "panelLibrary",
    group: "Panels",
    label: "Library panel",
    desc: "Saved commands and notes tab in the session toolbar.",
  },
  {
    key: "panelGit",
    group: "Panels",
    label: "Git status pill and drawer",
    desc: "Git branch pill and drawer. When off, no git status command is run on the server after connecting.",
  },
  {
    key: "aiCopilot",
    group: "AI",
    label: "AI Shell Copilot",
    desc: "Copilot button, Ctrl+I shortcut and the \"Explain\" action after a failed command. When off, the copilot code is never loaded and no data can be sent to an AI service.",
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
