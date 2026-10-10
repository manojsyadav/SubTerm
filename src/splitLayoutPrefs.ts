/**
 * Remembers HOW the user likes to split terminals (orientation and pane sizes)
 * across restarts. Which terminals were split is deliberately not persisted:
 * terminal ids are runtime-only and sessions aren't restored on launch.
 */
const ORIENTATION_KEY = "subterm-split-orientation";
const ratiosKey = (paneCount: number) => `subterm-split-ratios-${paneCount}`;

export type SplitOrientation = "h" | "v";

export function loadSplitOrientation(): SplitOrientation {
  try {
    return localStorage.getItem(ORIENTATION_KEY) === "v" ? "v" : "h";
  } catch {
    return "h";
  }
}

export function saveSplitOrientation(o: SplitOrientation): void {
  try { localStorage.setItem(ORIENTATION_KEY, o); } catch { /* storage unavailable */ }
}

/** Equal share for every pane. */
export function equalRatios(paneCount: number): number[] {
  return Array.from({ length: paneCount }, () => 1);
}

/** Sizes saved for a split with `paneCount` panes, or null when none/invalid. */
export function loadSplitRatios(paneCount: number): number[] | null {
  try {
    const raw = localStorage.getItem(ratiosKey(paneCount));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === paneCount &&
      parsed.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
    ) {
      return parsed as number[];
    }
  } catch { /* corrupt entry: ignore */ }
  return null;
}

/** Save sizes for a split of ratios.length panes. Ignores non-splits and all-equal layouts (nothing to remember). */
export function saveSplitRatios(ratios: number[]): void {
  if (ratios.length < 2) return;
  try {
    const key = ratiosKey(ratios.length);
    const allEqual = ratios.every((r) => Math.abs(r - ratios[0]) < 1e-9);
    if (allEqual) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(ratios));
  } catch { /* storage unavailable */ }
}

/** Sizes to use for a brand-new split of `paneCount` panes. */
export function initialSplitRatios(paneCount: number): number[] {
  return loadSplitRatios(paneCount) ?? equalRatios(paneCount);
}

/**
 * Next focus target when cycling panes. `ids` is the ordered list to cycle
 * through (split members, or all terminals when not split).
 */
export function cyclePaneId(ids: string[], current: string, direction: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const i = ids.indexOf(current);
  if (i < 0) return ids[0];
  return ids[(i + direction + ids.length) % ids.length];
}
