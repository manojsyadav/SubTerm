/**
 * Terminal session recording in the asciinema v2 (`.cast`) format:
 * one JSON header line, then one `[seconds, code, data]` JSON array per line.
 * Codes: "o" output, "i" input, "r" resize ("COLSxROWS").
 */

export interface CastHeader {
  version: 2;
  width: number;
  height: number;
  timestamp: number;
  title?: string;
}

export type CastEventCode = "o" | "i" | "r";
export type CastEvent = [number, CastEventCode, string];

/** Stop appending past this many characters so a forgotten recording can't eat all memory. */
export const MAX_RECORDING_CHARS = 50_000_000;

export interface RecorderOptions {
  cols: number;
  rows: number;
  title?: string;
  /** Typed keys can include passwords, so input is only captured when explicitly asked for. */
  captureInput?: boolean;
  now?: () => number;
}

export class CastRecorder {
  readonly header: CastHeader;
  readonly captureInput: boolean;
  readonly events: CastEvent[] = [];
  truncated = false;

  private readonly now: () => number;
  private readonly startMs: number;
  private readonly decoder = new TextDecoder("utf-8");
  private chars = 0;

  constructor(opts: RecorderOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.startMs = this.now();
    this.captureInput = !!opts.captureInput;
    this.header = {
      version: 2,
      width: Math.max(1, Math.floor(opts.cols)),
      height: Math.max(1, Math.floor(opts.rows)),
      timestamp: Math.floor(this.startMs / 1000),
      ...(opts.title ? { title: opts.title } : {}),
    };
  }

  private push(code: CastEventCode, data: string): void {
    if (this.truncated || data === "") return;
    if (this.chars + data.length > MAX_RECORDING_CHARS) {
      this.truncated = true;
      return;
    }
    this.chars += data.length;
    const seconds = Math.max(0, Math.round(this.now() - this.startMs)) / 1000;
    this.events.push([seconds, code, data]);
  }

  /** Raw bytes from the host. Streaming decode keeps multi-byte characters split across chunks intact. */
  output(bytes: Uint8Array): void {
    this.push("o", this.decoder.decode(bytes, { stream: true }));
  }

  input(text: string): void {
    if (this.captureInput) this.push("i", text);
  }

  resize(cols: number, rows: number): void {
    this.push("r", `${Math.floor(cols)}x${Math.floor(rows)}`);
  }

  get durationSeconds(): number {
    return this.events.length ? this.events[this.events.length - 1][0] : 0;
  }

  toCast(): string {
    return [JSON.stringify(this.header), ...this.events.map((e) => JSON.stringify(e))].join("\n") + "\n";
  }
}

// ---- parsing (for playback) ------------------------------------------------

export interface ParsedCast {
  header: CastHeader;
  events: CastEvent[];
}

/** Parses a v2 `.cast` file. Throws on a missing/unsupported header; skips malformed event lines. */
export function parseCast(text: string): ParsedCast {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) throw new Error("Empty recording");
  let header: CastHeader;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    throw new Error("Not an asciinema .cast file");
  }
  if (!header || header.version !== 2 || !(header.width > 0) || !(header.height > 0)) {
    throw new Error("Unsupported .cast version (need asciinema v2)");
  }
  const events: CastEvent[] = [];
  for (const line of lines.slice(1)) {
    try {
      const e: unknown = JSON.parse(line);
      if (
        Array.isArray(e) && e.length >= 3 &&
        typeof e[0] === "number" && typeof e[1] === "string" && typeof e[2] === "string" &&
        (e[1] === "o" || e[1] === "i" || e[1] === "r")
      ) {
        events.push([e[0], e[1], e[2]]);
      }
    } catch { /* skip a corrupt line rather than reject the whole recording */ }
  }
  return { header, events };
}

/** Plain text of the output stream with ANSI escapes removed, for the "raw log" export. */
export function castToPlainText(events: readonly CastEvent[]): string {
  const raw = events.filter((e) => e[1] === "o").map((e) => e[2]).join("");
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "");
}

// ---- registry: one active recording per terminal ---------------------------

const active = new Map<string, CastRecorder>();
const listeners = new Set<() => void>();
const notifyAll = () => listeners.forEach((l) => l());

export function startRecording(terminalId: string, opts: RecorderOptions): CastRecorder {
  const rec = new CastRecorder(opts);
  active.set(terminalId, rec);
  notifyAll();
  return rec;
}

/** Removes and returns the recorder (null if none was running). */
export function stopRecording(terminalId: string): CastRecorder | null {
  const rec = active.get(terminalId) ?? null;
  if (rec) {
    active.delete(terminalId);
    notifyAll();
  }
  return rec;
}

export const getRecorder = (terminalId: string): CastRecorder | undefined => active.get(terminalId);
export const isRecording = (terminalId: string): boolean => active.has(terminalId);

export function onRecordingChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
