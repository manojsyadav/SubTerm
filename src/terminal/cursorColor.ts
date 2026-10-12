import type { ITheme } from "xterm";

const HEX = /^#[0-9a-f]{6}$/i;

/** Applies the user's cursor colour override (Settings > Appearance) on top of a theme. */
export function withCursorColor(theme: ITheme, color: string | null = localStorage.getItem("subterm-cursor-color")): ITheme {
  if (!color || !HEX.test(color)) return theme;
  return { ...theme, cursor: color };
}
