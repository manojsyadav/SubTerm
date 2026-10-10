import { describe, it, expect, beforeEach, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

const {
  loadSplitOrientation, saveSplitOrientation, loadSplitRatios, saveSplitRatios,
  initialSplitRatios, equalRatios, cyclePaneId,
} = await import("./splitLayoutPrefs");

describe("split layout preferences", () => {
  beforeEach(() => store.clear());

  it("defaults to horizontal and remembers vertical", () => {
    expect(loadSplitOrientation()).toBe("h");
    saveSplitOrientation("v");
    expect(loadSplitOrientation()).toBe("v");
    saveSplitOrientation("h");
    expect(loadSplitOrientation()).toBe("h");
  });

  it("remembers ratios per pane count and falls back to equal", () => {
    expect(initialSplitRatios(2)).toEqual([1, 1]);
    saveSplitRatios([7, 3]);
    saveSplitRatios([5, 3, 2]);
    expect(initialSplitRatios(2)).toEqual([7, 3]);
    expect(initialSplitRatios(3)).toEqual([5, 3, 2]);
    expect(initialSplitRatios(4)).toEqual(equalRatios(4));
  });

  it("forgets a layout that goes back to equal, and ignores non-splits", () => {
    saveSplitRatios([7, 3]);
    saveSplitRatios([1, 1]);
    expect(loadSplitRatios(2)).toBeNull();
    saveSplitRatios([4]);
    expect(store.size).toBe(0);
  });

  it("rejects corrupt or mismatched saved data", () => {
    store.set("subterm-split-ratios-2", "not json");
    expect(loadSplitRatios(2)).toBeNull();
    store.set("subterm-split-ratios-2", JSON.stringify([1, 2, 3]));
    expect(loadSplitRatios(2)).toBeNull();
    store.set("subterm-split-ratios-2", JSON.stringify([1, -2]));
    expect(loadSplitRatios(2)).toBeNull();
  });
});

describe("cyclePaneId", () => {
  const ids = ["a", "b", "c"];
  it("wraps in both directions", () => {
    expect(cyclePaneId(ids, "a", 1)).toBe("b");
    expect(cyclePaneId(ids, "c", 1)).toBe("a");
    expect(cyclePaneId(ids, "a", -1)).toBe("c");
    expect(cyclePaneId(ids, "b", -1)).toBe("a");
  });
  it("handles unknown current and empty lists", () => {
    expect(cyclePaneId(ids, "zzz", 1)).toBe("a");
    expect(cyclePaneId([], "a", 1)).toBeNull();
    expect(cyclePaneId(["only"], "only", 1)).toBe("only");
  });
});
