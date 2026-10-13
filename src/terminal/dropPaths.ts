// Files dropped onto a terminal are typed as paths (Windows Terminal style), so a
// tool running in the shell (Claude Code, an editor, scp) can pick them up.

export type ShellKind = "windows" | "cmd" | "posix" | "wsl";

/** How the shell behind a local terminal wants paths written. */
export function localShellKind(shell: string | undefined, isWindowsHost: boolean): ShellKind {
  const s = (shell || "").toLowerCase();
  if (s === "wsl" || s.endsWith("wsl.exe")) return "wsl";
  if (s.includes("bash") || s.includes("zsh") || s.includes("fish") || s.endsWith("/sh")) return "posix";
  if (s === "cmd" || s.endsWith("cmd.exe")) return "cmd";
  return isWindowsHost ? "windows" : "posix";
}

const posixQuote = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;

/** `C:\Users\me\a.png` -> `/mnt/c/Users/me/a.png` (WSL's view of Windows drives). */
export const toWslPath = (p: string) =>
  p.replace(/^([A-Za-z]):[\\/]/, (_, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/");

/** Paths quoted for the shell, space-separated, with a trailing space so typing can continue. */
export function quotePaths(paths: readonly string[], kind: ShellKind): string {
  const quoted = paths.map((p) => {
    if (kind === "wsl") return posixQuote(toWslPath(p));
    if (kind === "posix") return posixQuote(p);
    // cmd has no literal quoting; Windows paths cannot contain `"`, so double quotes at least keep spaces.
    if (kind === "cmd") return /[\s&()^;,'`$%!@#[\]{}]/.test(p) ? `"${p}"` : p;
    // PowerShell (the default local shell): it runs `$(...)` inside double quotes, so a downloaded
    // `a$(Start-Process calc).txt` would execute. Single quotes are literal; `'` doubles.
    return /[\s&()^;,'`$%!@#[\]{}]/.test(p) ? `'${p.replace(/'/g, "''")}'` : p;
  });
  return quoted.join(" ") + " ";
}

/** Where a file dropped onto an SSH terminal is uploaded: `/tmp`, under a name safe to type unquoted. */
export function remoteDropPath(localPath: string, now = Date.now()): string {
  const name = (localPath.split(/[\\/]/).pop() || "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
  return `/tmp/subterm-drop-${now}-${name}`;
}

/** Tauri reports drop positions in physical pixels; hit-testing needs CSS pixels. */
export const toCssPoint = (pos: { x: number; y: number }, dpr = window.devicePixelRatio || 1) => ({ x: pos.x / dpr, y: pos.y / dpr });
