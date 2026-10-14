import { promptTail } from "./passwordPrompt";

/**
 * Detect an interactive `ssh` / `sftp` command typed in a local shell so the
 * app can offer to save the target as a server and open it natively.
 *
 * Deliberately conservative: anything that is not a plain "connect to one host"
 * (remote command, jump host, proxy command, port forwarding, ...) returns null.
 */
export interface SshTarget {
  kind: "ssh" | "sftp";
  /** Host or `~/.ssh/config` alias exactly as typed. */
  host: string;
  username?: string;
  port?: number;
  identityFile?: string;
}

// Options that consume the next argument, per client.
const SSH_ARG_OPTS = new Set("bcDEeFIiJLlmOopQRSWw".split(""));
const SFTP_ARG_OPTS = new Set("BbcDFiJloPRSs".split(""));
// Options that make the session non-plain: skip the offer entirely.
const SSH_SKIP_OPTS = new Set(["J", "D", "L", "R", "W", "w", "O", "N", "f", "M", "S"]);
const SFTP_SKIP_OPTS = new Set(["J", "b", "S"]);

function tokenize(line: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else if (";|&<>`$()".includes(ch)) {
      return null; // pipes, chaining, substitution: not a plain command
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) return null;
  if (has || cur) out.push(cur);
  return out;
}

export function parseSshCommand(line: string): SshTarget | null {
  const toks = tokenize(line.trim());
  if (!toks || toks.length < 2) return null;
  const bin = toks[0].replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
  if (bin !== "ssh" && bin !== "sftp") return null;
  const kind = bin as "ssh" | "sftp";
  const argOpts = kind === "ssh" ? SSH_ARG_OPTS : SFTP_ARG_OPTS;
  const skipOpts = kind === "ssh" ? SSH_SKIP_OPTS : SFTP_SKIP_OPTS;
  const portOpt = kind === "ssh" ? "p" : "P";

  let username: string | undefined;
  let port: number | undefined;
  let identityFile: string | undefined;
  const positional: string[] = [];

  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    if (t === "--") {
      positional.push(...toks.slice(i + 1));
      break;
    }
    if (t.length > 1 && t.startsWith("-")) {
      // Walk clustered flags (-vv, -4A, -p22).
      for (let j = 1; j < t.length; j++) {
        const o = t[j];
        if (skipOpts.has(o)) return null;
        if (argOpts.has(o)) {
          const attached = t.slice(j + 1);
          const val = attached || toks[++i];
          if (val === undefined) return null;
          if (o === portOpt) {
            const p = Number(val);
            if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
            port = p;
          } else if (o === "l" && kind === "ssh") {
            username = val;
          } else if (o === "i") {
            identityFile = val;
          } else if (o === "o") {
            if (/^\s*(proxycommand|proxyjump|localforward|remoteforward|dynamicforward)/i.test(val)) return null;
          }
          break; // the rest of the cluster was the value
        }
      }
      continue;
    }
    positional.push(t);
  }

  // ssh: <host> [command...] ; a trailing command means it is not an interactive login.
  // sftp: <host>[:path] only.
  if (positional.length !== 1) return null;
  let dest = positional[0];
  if (kind === "sftp") dest = dest.replace(/^sftp:\/\//i, "");
  else if (/^ssh:\/\//i.test(dest)) dest = dest.replace(/^ssh:\/\//i, "");

  let host = dest;
  const at = host.lastIndexOf("@");
  if (at >= 0) {
    const u = host.slice(0, at);
    if (u && !username) username = u;
    host = host.slice(at + 1);
  }
  // Strip sftp `:path` / URL `:port`; bracketed IPv6 is out of scope.
  const colon = host.indexOf(":");
  if (colon >= 0) {
    const rest = host.slice(colon + 1);
    host = host.slice(0, colon);
    if (/^\d+$/.test(rest) && port === undefined) port = Number(rest);
  }
  host = host.replace(/\/.*$/, "");
  if (!host || /[\s*?!]/.test(host) || host.startsWith("-")) return null;

  return { kind, host, username, port, identityFile };
}

/** Stable identity for "already offered / dismissed" bookkeeping. */
export function sshTargetKey(t: SshTarget): string {
  return `${t.username ?? ""}@${t.host}:${t.port ?? ""}`;
}

/** Output that means the ssh/sftp client has returned to the local shell. */
export const SSH_ENDED_RE =
  /Connection to .+ closed|Connection closed by|Connection (?:refused|reset|timed out)|Could not resolve hostname|Permission denied|No route to host|Host key verification failed|Network is unreachable|^logout$/im;

const isSshBinary = (tok: string) => /^(?:.*[/\\])?(?:ssh|sftp)(?:\.exe)?$/i.test(tok);

/**
 * Detect ssh/sftp from the command line as the shell actually shows it, not as
 * keystrokes were seen: Tab completion and history recall (Up arrow) change the
 * line without a matching keystroke, so the typed buffer alone yields partial or
 * stale hosts. `screenLine` is the visible command line up to the cursor
 * (prompt included); `typed` is the keystroke buffer; `edited` is true when the
 * line used Tab or an escape sequence (completion, history, cursor keys).
 *
 * The prompt is skipped by taking the first token boundary from which a plain
 * ssh/sftp command parses. To avoid reading `echo ssh host` as ssh, the typed
 * buffer must start like ssh/sftp (or be absent/edited, where it cannot be trusted).
 */
export function parseSshFromScreen(screenLine: string, typed: string, edited: boolean): SshTarget | null {
  const t = typed.trim();
  if (t && !edited) {
    const first = t.split(/\s+/)[0];
    if (!isSshBinary(first)) return null;
  }
  const text = screenLine.replace(/\s+$/, "");
  for (let i = 0; i < text.length; i++) {
    if (i > 0 && !/[\s>$#%]/.test(text[i - 1])) continue;
    if (/\s/.test(text[i])) continue;
    const target = parseSshCommand(text.slice(i));
    if (target) return target;
  }
  return null;
}

/**
 * Fallback for an ssh that ends without printing anything SSH_ENDED_RE knows
 * (`~.`, a killed client): the screen ends in PowerShell's or cmd's own prompt
 * (`PS C:\Users\me>` / `C:\Users\me>`), which a Linux remote does not print.
 * shortcut: Windows shells only; local bash/WSL prompts look like remote ones.
 */
export const endsWithWindowsShellPrompt = (out: string): boolean =>
  /(?:^|\n)(?:PS )?[A-Za-z]:\[^\n<>|]*> ?$/.test(promptTail(out));
