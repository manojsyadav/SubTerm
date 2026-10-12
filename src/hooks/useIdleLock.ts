import { useEffect, useRef } from "react";

const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "wheel", "touchstart"] as const;
const CHECK_EVERY_MS = 10_000;

interface Options {
  enabled: boolean;
  /** Minutes without input before `onIdle` fires; 0 disables the timer. */
  minutes: number;
  onIdle: () => void;
}

/**
 * Fires `onIdle` once after `minutes` without mouse, keyboard, wheel or touch input anywhere in
 * the window. Re-arms when `enabled` or `minutes` change. Output arriving in a terminal does not
 * count as activity: only the user's own input keeps the app unlocked.
 */
export function useIdleLock({ enabled, minutes, onIdle }: Options) {
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  useEffect(() => {
    if (!enabled || !minutes || minutes <= 0) return;
    let last = Date.now();
    const bump = () => { last = Date.now(); };
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, bump, { passive: true, capture: true }));
    const timer = window.setInterval(() => {
      if (Date.now() - last >= minutes * 60_000) {
        window.clearInterval(timer);
        onIdleRef.current();
      }
    }, CHECK_EVERY_MS);
    return () => {
      window.clearInterval(timer);
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, bump, { capture: true }));
    };
  }, [enabled, minutes]);
}

/** Fires `onHidden` whenever the window becomes hidden (minimised, or covered by the OS). */
export function useLockOnHidden(enabled: boolean, onHidden: () => void) {
  const ref = useRef(onHidden);
  ref.current = onHidden;
  useEffect(() => {
    if (!enabled) return;
    const handler = () => { if (document.visibilityState === "hidden") ref.current(); };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [enabled]);
}
