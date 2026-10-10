import { describe, it, expect } from "vitest";
import { detectAndroid, detectIos } from "./platform";

const UA = {
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
  ipadAsMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
};

describe("platform detection", () => {
  it("recognises Android only on Android", () => {
    expect(detectAndroid({ userAgent: UA.android })).toBe(true);
    expect(detectAndroid({ userAgent: UA.iphone })).toBe(false);
    expect(detectAndroid({ userAgent: UA.windows })).toBe(false);
    expect(detectAndroid({})).toBe(false);
  });

  it("recognises iPhone and iPad user agents", () => {
    expect(detectIos({ userAgent: UA.iphone })).toBe(true);
    expect(detectIos({ userAgent: UA.ipad })).toBe(true);
  });

  it("recognises iPadOS, which poses as a Mac but has a touch screen", () => {
    expect(detectIos({ userAgent: UA.ipadAsMac, platform: "MacIntel", maxTouchPoints: 5 })).toBe(true);
  });

  it("does not mistake a real Mac, Windows or Android for iOS", () => {
    expect(detectIos({ userAgent: UA.mac, platform: "MacIntel", maxTouchPoints: 0 })).toBe(false);
    expect(detectIos({ userAgent: UA.mac, platform: "MacIntel" })).toBe(false);
    expect(detectIos({ userAgent: UA.windows, platform: "Win32", maxTouchPoints: 10 })).toBe(false);
    expect(detectIos({ userAgent: UA.android, platform: "Linux armv8l", maxTouchPoints: 5 })).toBe(false);
  });
});
