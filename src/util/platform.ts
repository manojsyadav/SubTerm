// Runtime platform detection. Tauri v2 has no synchronous OS query on the JS
// side, so we sniff the user agent — the WebView UA on Android always contains
// "Android" and on desktop Tauri never does. Kept as module constants so
// components read them once at import time and don't burn cycles on every render.
//
// Why not `useIsNarrow`? A small desktop window is still desktop — folder
// pickers, "Open with default app", and ~/.ssh/config all work on a 400px-wide
// Windows build. Only the mobile platforms truly lack these capabilities.

interface Sniff {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
}

export const detectAndroid = (n: Sniff): boolean => /Android/i.test(n.userAgent ?? "");

/**
 * iPhone/iPod say so in the user agent. iPadOS 13+ deliberately reports "Macintosh",
 * so a Mac-looking agent with a multi-touch screen is an iPad (no Mac has one).
 */
export const detectIos = (n: Sniff): boolean =>
  /iPhone|iPad|iPod/i.test(n.userAgent ?? "") ||
  ((n.platform === "MacIntel" || /Macintosh/i.test(n.userAgent ?? "")) && (n.maxTouchPoints ?? 0) > 1);

export const detectWindows = (n: Sniff): boolean =>
  /Win/i.test(n.platform ?? "") || /Windows/i.test(n.userAgent ?? "");

const nav: Sniff = typeof navigator !== "undefined" ? navigator : {};

export const IS_ANDROID: boolean = detectAndroid(nav);
export const IS_IOS: boolean = detectIos(nav);
export const IS_WINDOWS: boolean = detectWindows(nav);

/** Phones and tablets: no native folder picker, no "open with default app", no local shell. */
export const IS_MOBILE_OS: boolean = IS_ANDROID || IS_IOS;

// True when we're inside a Tauri WebView (desktop or mobile). Kept for future
// use — some UI may want to differentiate a browser preview from packaged app.
export const IS_TAURI: boolean =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
