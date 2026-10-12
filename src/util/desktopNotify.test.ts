import { describe, it, expect } from "vitest";
import { shouldNotifyLongCommand } from "./desktopNotify";

describe("shouldNotifyLongCommand", () => {
  it("is off at 0 and below the threshold", () => {
    expect(shouldNotifyLongCommand(120_000, 0)).toBe(false);
    expect(shouldNotifyLongCommand(29_999, 30)).toBe(false);
  });

  it("fires at and above the threshold", () => {
    expect(shouldNotifyLongCommand(30_000, 30)).toBe(true);
    expect(shouldNotifyLongCommand(600_000, 30)).toBe(true);
  });
});
