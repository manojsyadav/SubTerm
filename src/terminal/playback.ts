import type { CastEvent } from "./recorder";

/** Caps every gap between consecutive events at `maxGap` seconds so long idle stretches don't stall playback. */
export function compressIdle(events: readonly CastEvent[], maxGap: number): CastEvent[] {
  const out: CastEvent[] = [];
  let shift = 0;
  let prev = 0;
  for (const [t, code, data] of events) {
    const gap = t - prev;
    if (gap > maxGap) shift += gap - maxGap;
    prev = t;
    out.push([t - shift, code, data]);
  }
  return out;
}

/** Index of the first event with time > `t` (so events[0..result) are the ones already played). */
export function countPlayed(events: readonly CastEvent[], t: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid][0] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function parseResize(data: string): { cols: number; rows: number } | null {
  const m = /^(\d+)x(\d+)$/.exec(data);
  if (!m) return null;
  const cols = Number(m[1]);
  const rows = Number(m[2]);
  return cols > 0 && rows > 0 ? { cols, rows } : null;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
