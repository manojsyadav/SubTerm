import { describe, it, expect } from "vitest";
import { normalizeReduceMotion, shouldReduceMotion } from "./reduceMotion";

describe("reduce motion", () => {
  it("normalizes unknown values to system", () => {
    expect(normalizeReduceMotion(null)).toBe("system");
    expect(normalizeReduceMotion("junk")).toBe("system");
    expect(normalizeReduceMotion("on")).toBe("on");
    expect(normalizeReduceMotion("off")).toBe("off");
  });

  it("system follows the OS; on and off override it", () => {
    expect(shouldReduceMotion("system", true)).toBe(true);
    expect(shouldReduceMotion("system", false)).toBe(false);
    expect(shouldReduceMotion("on", false)).toBe(true);
    expect(shouldReduceMotion("off", true)).toBe(false);
  });
});
