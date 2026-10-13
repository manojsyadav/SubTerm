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

export const readOpacity = (): number => clampOpacity(localStorage.getItem(OPACITY_KEY) ?? 100);

/** "none", or a Windows backdrop: "acrylic" (blurred) or "mica" (tinted wallpaper). */
export const normalizeBlur = (v: string | null | undefined): "none" | "acrylic" | "mica" =>
  v === "acrylic" || v === "mica" ? v : "none";

const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** The theme with its background made `pct`% opaque (xterm needs allowTransparency for this). */
export function withBackgroundOpacity(theme: ITheme, pct: number = readOpacity()): ITheme {
  const m = HEX6.exec(theme.background ?? "");
  if (pct >= 100 || !m) return theme;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  return { ...theme, background: `rgba(${r}, ${g}, ${b}, ${(pct / 100).toFixed(2)})` };
}
