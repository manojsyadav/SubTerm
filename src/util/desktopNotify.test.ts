// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { shouldNotifyLongCommand, notifyDesktop } from "./desktopNotify";

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

describe("notifyDesktop", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not notify when document is focused", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    expect(await notifyDesktop("Test", "Body")).toBe(false);
  });

  it("attempts notification when document is not focused and permission granted", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const mockNotification = vi.fn();
    (mockNotification as unknown as { permission: string }).permission = "granted";
    vi.stubGlobal("Notification", mockNotification);

    const result = await notifyDesktop("Done", "Command finished");
    expect(result).toBe(true);
    expect(mockNotification).toHaveBeenCalledWith("Done", { body: "Command finished", silent: false });
  });

  it("returns false if Notification permission is denied", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const mockNotification = vi.fn();
    (mockNotification as unknown as { permission: string }).permission = "denied";
    vi.stubGlobal("Notification", mockNotification);

    const result = await notifyDesktop("Done", "Command finished");
    expect(result).toBe(false);
  });
});

