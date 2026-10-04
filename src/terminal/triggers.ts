/**
 * Terminal Triggers & Alert Keywords.
 *
 * User-defined regex/keyword patterns matched against live terminal output.
 * A match fires one of four actions: a toast notification, the existing
 * bell chime, the existing bell visual flash, or an Activity Log entry.
 *
 * Deliberately does NOT use a native OS push notification (no new Tauri
 * plugin/permission surface added) — `capabilities/default.json` already
 * documents this app's policy of keeping the webview's permission set as
 * narrow as possible, and the existing in-app toast + visual flash + chime
 * cover the same "notice it even if you're not staring at this tab" need
 * for a desktop app where the window is usually just one alt-tab away.
 */

export type TriggerAction = "notify" | "chime" | "highlight" | "log";

export interface TerminalTrigger {
  id: string;
  pattern: string;
  isRegex: boolean;
  caseSensitive: boolean;
  action: TriggerAction;
  enabled: boolean;
}

const STORAGE_KEY = "subterm-terminal-triggers";
// Fired whenever the trigger list is saved, so already-mounted TerminalView
// instances refresh their compiled cache instead of needing a restart.
export const TRIGGERS_CHANGED_EVENT = "subterm-triggers-changed";

export function getTerminalTriggers(): TerminalTrigger[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveTerminalTriggers(triggers: TerminalTrigger[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(triggers));
  window.dispatchEvent(new Event(TRIGGERS_CHANGED_EVENT));
}

export function newTrigger(): TerminalTrigger {
  return {
    id: `trig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    pattern: "",
    isRegex: false,
    caseSensitive: false,
    action: "notify",
    enabled: true,
  };
}

interface CompiledTrigger {
  trigger: TerminalTrigger;
  regex: RegExp;
}

// Compiled once per trigger-list change (not per output chunk) so the hot
// terminal-output path stays cheap — see TerminalView's outputChannel
// onmessage handler.
export function compileTriggers(triggers: TerminalTrigger[]): CompiledTrigger[] {
  const compiled: CompiledTrigger[] = [];
  for (const t of triggers) {
    if (!t.enabled || !t.pattern.trim()) continue;
    try {
      const flags = t.caseSensitive ? "" : "i";
      const source = t.isRegex ? t.pattern : t.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      compiled.push({ trigger: t, regex: new RegExp(source, flags) });
    } catch {
      // Invalid user-supplied regex — skip it rather than crash the
      // terminal's output path over a bad pattern.
    }
  }
  return compiled;
}

// Scans one decoded output chunk (not the full scrollback) against every
// compiled trigger. Chunk-scoped rather than buffer-scoped is a deliberate
// trade: it can miss a keyword split exactly across two flush batches (rare
// — batches are only ~8ms of output), but avoids re-firing the same trigger
// on every subsequent batch while the match lingers in a sliding buffer.
export function matchTriggers(chunkText: string, compiled: CompiledTrigger[]): TerminalTrigger[] {
  const matched: TerminalTrigger[] = [];
  for (const { trigger, regex } of compiled) {
    regex.lastIndex = 0;
    if (regex.test(chunkText)) {
      matched.push(trigger);
    }
  }
  return matched;
}
