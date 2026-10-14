import { describe, it, expect } from "vitest";
import { clampOpacity, normalizeBlur, withBackgroundOpacity } from "./windowOpacity";

describe("window opacity", () => {
  it("clamps to 30-100 and falls back to opaque", () => {
    expect(clampOpacity("85")).toBe(85);
    expect(clampOpacity(5)).toBe(30);
    expect(clampOpacity(250)).toBe(100);
    expect(clampOpacity("junk")).toBe(100);
    expect(clampOpacity(null)).toBe(100);
  });

  it("fades only the terminal background", () => {
    const theme = { background: "#0b0b0f", foreground: "#ffffff" };
    expect(withBackgroundOpacity(theme, 80)).toEqual({ background: "rgba(11, 11, 15, 0.80)", foreground: "#ffffff" });
    expect(withBackgroundOpacity(theme, 100, "none")).toBe(theme);
    expect(withBackgroundOpacity(theme, 100, "acrylic")).toEqual({ background: "rgba(11, 11, 15, 0.80)", foreground: "#ffffff" });
    expect(withBackgroundOpacity(theme, 100, "mica")).toEqual({ background: "rgba(11, 11, 15, 0.65)", foreground: "#ffffff" });
    expect(withBackgroundOpacity({ background: "transparent" }, 50)).toEqual({ background: "transparent" });
  });

  it("accepts only known blur effects", () => {
    expect(normalizeBlur("mica")).toBe("mica");
    expect(normalizeBlur("acrylic")).toBe("acrylic");
    expect(normalizeBlur("tabbed")).toBe("tabbed");
    expect(normalizeBlur("vibrancy")).toBe("none");
  });
});
