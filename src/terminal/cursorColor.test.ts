import { describe, it, expect } from "vitest";
import { withCursorColor } from "./cursorColor";

describe("withCursorColor", () => {
  const theme = { background: "#000000", cursor: "#ffffff" };

  it("overrides the cursor with a valid hex colour", () => {
    expect(withCursorColor(theme, "#ff8800")).toEqual({ background: "#000000", cursor: "#ff8800" });
  });

  it("keeps the theme cursor for empty or invalid values", () => {
    expect(withCursorColor(theme, "")).toBe(theme);
    expect(withCursorColor(theme, null)).toBe(theme);
    expect(withCursorColor(theme, "red")).toBe(theme);
    expect(withCursorColor(theme, "#fff")).toBe(theme);
  });
});
