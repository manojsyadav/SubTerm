/** "system" follows the OS preference; "on" and "off" override it. */
export type ReduceMotionMode = "system" | "on" | "off";

export const normalizeReduceMotion = (v: string | null | undefined): ReduceMotionMode =>
  v === "on" || v === "off" ? v : "system";

export function shouldReduceMotion(mode: ReduceMotionMode, systemPrefersReduced: boolean): boolean {
  return mode === "on" || (mode === "system" && systemPrefersReduced);
}
