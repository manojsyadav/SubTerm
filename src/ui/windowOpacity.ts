import type { ITheme } from "xterm";

// Settings > Appearance > Window opacity / blur. The window is created transparent
// (tauri.conf.json); below 100% the app background and the terminal background let
// the desktop (or the blur effect) show through, while text stays solid.

export const OPACITY_KEY = "subterm-window-opacity";
export const BLUR_KEY = "subterm-window-blur";

export const clampOpacity = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? Math.min(100, Math.max(30, Math.round(n))) : 100;
};

export const readOpacity = (): number =>
  typeof localStorage !== "undefined" ? clampOpacity(localStorage.getItem(OPACITY_KEY) ?? 100) : 100;

/** "none", or a Windows backdrop: "acrylic" (blurred), "mica" (tinted wallpaper), or "tabbed" (Mica Alt). */
export const normalizeBlur = (v: string | null | undefined): "none" | "acrylic" | "mica" | "tabbed" =>
  v === "acrylic" || v === "mica" || v === "tabbed" ? v : "none";

export const readBlur = (): "none" | "acrylic" | "mica" | "tabbed" =>
  typeof localStorage !== "undefined" ? normalizeBlur(localStorage.getItem(BLUR_KEY)) : "none";

const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** The theme with its background made `pct`% opaque (xterm needs allowTransparency for this). */
export function withBackgroundOpacity(
  theme: ITheme,
  pct: number = readOpacity(),
  blur: string = readBlur()
): ITheme {
  const m = HEX6.exec(theme.background ?? "");
  if (!m) return theme;
  // When a blur/Mica backdrop is active, the terminal background must allow the effect to show through.
  const effectivePct = blur !== "none" && pct >= 100
    ? (blur === "acrylic" ? 80 : 65)
    : pct;
  if (effectivePct >= 100) return theme;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  return { ...theme, background: `rgba(${r}, ${g}, ${b}, ${(effectivePct / 100).toFixed(2)})` };
}
