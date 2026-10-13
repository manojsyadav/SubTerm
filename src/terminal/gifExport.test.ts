// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { framePalette, nearestIndex } from "./gifExport";

describe("gif palette", () => {
  it("collects the background and every run colour once", () => {
    const pal = framePalette([
      { t: 0, lines: [[{ text: "a", fg: "#ffffff" }, { text: "b", fg: "#cd3131", bg: "#000000" }]] },
      { t: 1, lines: [[{ text: "c", fg: "#ffffff" }]] },
    ]);
    expect(pal).toEqual([0x0b0b0f, 0xffffff, 0xcd3131, 0x000000]);
  });

  it("maps anti-aliased shades to the nearest used colour", () => {
    const pal = [0x0b0b0f, 0xffffff, 0xcd3131];
    const cache = new Map<number, number>();
    expect(nearestIndex(pal, cache, 0xf0f0f0)).toBe(1);
    expect(nearestIndex(pal, cache, 0x202020)).toBe(0);
    expect(nearestIndex(pal, cache, 0xc03030)).toBe(2);
    expect(cache.size).toBe(3);
  });
});
