/**
 * Tracks each terminal's current working directory.
 *
 * The cwd is learned from (a) OSC 7 reports and (b) the shell prompt text. The
 * prompt path is needed on stock Debian/Ubuntu shells, which colour the prompt
 * and don't emit OSC 7. Several features depend on it: opening a clicked
 * relative path, and the Git panel (whose commands run on a separate SSH channel
 * that starts in $HOME, not in the shell's folder).
 */

// CSI (colours etc.), OSC (window title, hyperlinks...) and 2-char escapes.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

// `user@host:path$` / `#`, optionally preceded by a venv/conda marker like `(venv) ` and
// followed by the git segment SubTerm's local bash integration adds (` [repo:main ●2]`).
const PROMPT_RE = /(?:^|[\r\n])(?:\([^)\r\n]*\)\s*)?[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:([/~][^$#\s)]*)(?: \[[^\]\r\n]*\])?[$#]/g;

/** The cwd shown by the LAST shell prompt in `chunk` (raw terminal output), or null. */
export function parsePromptCwd(chunk: string): string | null {
  const text = stripAnsi(chunk);
  let last: string | null = null;
  for (const m of text.matchAll(PROMPT_RE)) last = m[1];
  return last;
}

/** Turn an OSC 7 payload (`file://host/path` or a bare path) into a plain path. */
export function parseOsc7(data: string): string | null {
  let p = data.trim();
  if (p.startsWith("file://")) {
    try { p = decodeURIComponent(new URL(p).pathname); } catch { /* keep raw */ }
  }
  return p || null;
}

// ---- tiny shared store so features outside TerminalView can read the cwd ----
const cwdByTerminal = new Map<string, string>();
const listeners = new Set<(terminalId: string, cwd: string) => void>();

/** Record a terminal's cwd; listeners fire only when it actually changed. */
export function setTerminalCwd(terminalId: string, cwd: string): void {
  if (!cwd || cwdByTerminal.get(terminalId) === cwd) return;
  cwdByTerminal.set(terminalId, cwd);
  listeners.forEach((fn) => fn(terminalId, cwd));
}

export function getTerminalCwd(terminalId: string): string | undefined {
  return cwdByTerminal.get(terminalId);
}

export function forgetTerminalCwd(terminalId: string): void {
  cwdByTerminal.delete(terminalId);
}

export function onTerminalCwdChange(fn: (terminalId: string, cwd: string) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Single-quote a value for a POSIX shell (also valid in fish). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
