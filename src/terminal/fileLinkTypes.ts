/**
 * Which file names in terminal output become clickable ("open in editor").
 * User-editable in Settings -> Clickable file types; defaults below.
 */
export const DEFAULT_FILE_LINK_EXTENSIONS: readonly string[] = [
  "yaml", "yml", "json", "toml", "ini", "conf", "cfg", "txt", "md", "sh", "bash", "zsh", "env",
  "py", "js", "jsx", "ts", "tsx", "html", "htm", "css", "scss", "xml", "sql", "rs", "go", "c",
  "cpp", "h", "hpp", "log", "properties", "lock", "service", "timer",
  "crt", "cer", "pem", "csr", "key", "pub", "cnf", "j2", "tf", "tfvars", "csv",
];

/** Well-known files that have no (useful) extension. */
export const DEFAULT_FILE_LINK_NAMES: readonly string[] = ["Dockerfile", "Makefile"];

let cache: { exts: string[]; names: string[]; source: string | null } | null = null;

const EXT_KEY = "subterm-file-link-extensions";
const NAMES_KEY = "subterm-file-link-names";
export const FILE_LINK_TYPES_CHANGED_EVENT = "subterm-file-link-types-changed";

/** "*.YAML", ".yaml " -> "yaml". Returns null when the input isn't a usable extension. */
export function normalizeExtension(input: string): string | null {
  const ext = input.trim().replace(/^[*.\s]+/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9_+-]{0,15}$/.test(ext) ? ext : null;
}

/** Plain file names such as `Dockerfile` (no path separators or spaces). */
export function normalizeFileName(input: string): string | null {
  const name = input.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ? name : null;
}

function readList(key: string, fallback: readonly string[], clean: (s: string) => string | null): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return [...fallback];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...fallback];
    const seen = new Set<string>();
    for (const item of parsed) {
      const v = typeof item === "string" ? clean(item) : null;
      if (v) seen.add(v);
    }
    return [...seen]; // an explicitly saved empty list stays empty
  } catch {
    return [...fallback];
  }
}

function writeList(key: string, values: string[]): void {
  cache = null;
  try { localStorage.setItem(key, JSON.stringify(values)); } catch { /* storage unavailable */ }
  try { window.dispatchEvent(new CustomEvent(FILE_LINK_TYPES_CHANGED_EVENT)); } catch { /* no window (tests) */ }
}

export const loadFileLinkExtensions = () => readList(EXT_KEY, DEFAULT_FILE_LINK_EXTENSIONS, normalizeExtension);
export const loadFileLinkNames = () => readList(NAMES_KEY, DEFAULT_FILE_LINK_NAMES, normalizeFileName);

export function saveFileLinkExtensions(list: string[]): void {
  writeList(EXT_KEY, [...new Set(list.map(normalizeExtension).filter((x): x is string => !!x))]);
}
export function saveFileLinkNames(list: string[]): void {
  writeList(NAMES_KEY, [...new Set(list.map(normalizeFileName).filter((x): x is string => !!x))]);
}

export function resetFileLinkTypes(): void {
  cache = null;
  try { localStorage.removeItem(EXT_KEY); localStorage.removeItem(NAMES_KEY); } catch { /* ignore */ }
  try { window.dispatchEvent(new CustomEvent(FILE_LINK_TYPES_CHANGED_EVENT)); } catch { /* no window */ }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Regex matching `name.ext` (any of `exts`) or an exact file name from `names`, preceded by a
 * boundary (start, whitespace, quote, backtick, "("). Group 1 is the file name. Null when both lists are empty.
 */
export function buildFileLinkRegex(exts: readonly string[], names: readonly string[]): RegExp | null {
  const parts: string[] = [];
  if (exts.length) {
    const alt = [...exts].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
    parts.push(`[a-zA-Z0-9_.-]+\\.(?:${alt})`);
  }
  for (const n of names) parts.push(escapeRe(n));
  if (!parts.length) return null;
  // `(?![A-Za-z0-9_])` instead of `\b`: \b needs a word char before it, so extensions like `c++` could never match.
  return new RegExp("(?:^|[\\s\"'`(])(" + parts.join("|") + ")(?![A-Za-z0-9_])", "gi");
}

// Compiled once per change rather than per terminal line.
if (typeof window !== "undefined") {
  window.addEventListener(FILE_LINK_TYPES_CHANGED_EVENT, () => { cache = null; });
}

/** A fresh (stateful `g`) regex for the current settings, or null when nothing is clickable. */
export function getFileLinkRegex(): RegExp | null {
  if (!cache) {
    const exts = loadFileLinkExtensions();
    const names = loadFileLinkNames();
    cache = { exts, names, source: buildFileLinkRegex(exts, names)?.source ?? null };
  }
  return cache.source === null ? null : new RegExp(cache.source, "gi");
}

/** Whether `fileName` should be offered as an editable text/code file (used by the quick-open picker). */
export function isClickableFileName(fileName: string): boolean {
  const exts = loadFileLinkExtensions();
  const names = loadFileLinkNames().map((n) => n.toLowerCase());
  const lower = fileName.toLowerCase();
  if (names.includes(lower)) return true;
  const dot = lower.lastIndexOf(".");
  return dot > 0 && exts.includes(lower.slice(dot + 1));
}
