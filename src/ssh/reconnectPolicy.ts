/** Auto-reconnect pacing (Settings > Terminal > SSH Connection). Pure so it can be tested. */
const BASE_MS = 2000;

export interface ReconnectSettings {
  /** 0 = retry forever (the default). */
  maxAttempts: number;
  /** Ceiling for the backoff delay, in seconds. */
  maxDelaySec: number;
}

export function readReconnectSettings(storage: Pick<Storage, "getItem"> = localStorage): ReconnectSettings {
  const attempts = parseInt(storage.getItem("subterm-reconnect-max-attempts") || "0", 10);
  const delay = parseInt(storage.getItem("subterm-reconnect-max-delay-sec") || "30", 10);
  return {
    maxAttempts: Number.isFinite(attempts) && attempts > 0 ? attempts : 0,
    maxDelaySec: Number.isFinite(delay) ? Math.min(300, Math.max(2, delay)) : 30,
  };
}

/** 2s, 4s, 8s ... doubling per attempt, capped at the configured ceiling. */
export function reconnectDelayMs(attempt: number, s: ReconnectSettings): number {
  return Math.min(BASE_MS * 2 ** Math.max(0, attempt - 1), s.maxDelaySec * 1000);
}

export function shouldGiveUp(attempt: number, s: ReconnectSettings): boolean {
  return s.maxAttempts > 0 && attempt > s.maxAttempts;
}
