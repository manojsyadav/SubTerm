/**
 * Normalizes and converts KeyboardEvents and key strings into standardized representations.
 */

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;

export function normalizeKey(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  // Standardize common special names
  if (key === "Escape") return "Esc";
  return key;
}

export function eventToKeyCombo(e: KeyboardEvent): string {
  // If only a modifier was pressed, return empty so we wait for the primary key
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) {
    return "";
  }

  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");

  const normalized = normalizeKey(e.key);
  parts.push(normalized);

  return parts.join("+");
}

export function normalizeKeyCombo(combo: string): string {
  if (!combo) return "";
  const rawParts = combo.split("+").map((p) => p.trim());
  const modifiers: string[] = [];
  let primaryKey = "";

  for (const part of rawParts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control") modifiers.push("Ctrl");
    else if (lower === "alt") modifiers.push("Alt");
    else if (lower === "shift") modifiers.push("Shift");
    else if (lower === "meta" || lower === "cmd" || lower === "command") modifiers.push("Meta");
    else primaryKey = normalizeKey(part);
  }

  const orderedModifiers: string[] = MODIFIER_ORDER.filter((m) => (modifiers as readonly string[]).includes(m));
  if (primaryKey) orderedModifiers.push(primaryKey);
  return orderedModifiers.join("+");
}

export function matchesKeyCombo(e: KeyboardEvent, combo: string): boolean {
  if (!combo) return false;
  const eventCombo = eventToKeyCombo(e);
  if (!eventCombo) return false;

  return normalizeKeyCombo(eventCombo) === normalizeKeyCombo(combo);
}

export function splitKeyCombo(combo: string): string[] {
  if (!combo) return [];
  return combo.split("+").map((s) => s.trim());
}
