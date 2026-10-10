import type { LanguageId } from "./language";

interface CommentSyntax {
  /** Prefixes that make the rest of a line a comment. */
  line: string[];
  // Block comment [open, close] delimiters.
  block?: [string, string];
}

const SLASH: CommentSyntax = { line: ["//"], block: ["/*", "*/"] };

const SYNTAX: Record<LanguageId, CommentSyntax | null> = {
  shell: { line: ["#"] },
  nginx: { line: ["#"] },
  properties: { line: ["#", ";"] },
  toml: { line: ["#"] },
  dockerfile: { line: ["#"] },
  yaml: { line: ["#"] },
  python: { line: ["#"] },
  json: { line: ["//"], block: ["/*", "*/"] }, // JSONC
  javascript: SLASH, typescript: SLASH, jsx: SLASH, tsx: SLASH,
  rust: SLASH, go: SLASH, cpp: SLASH,
  css: { line: [], block: ["/*", "*/"] },
  sql: { line: ["--"], block: ["/*", "*/"] },
  html: { line: [], block: ["<!--", "-->"] },
  xml: { line: [], block: ["<!--", "-->"] },
  markdown: null,
  // Unknown file type: most config-like files use "#".
  plain: { line: ["#"] },
};

/** Whether comments can be hidden for this language at all. */
export function supportsCommentHiding(lang: LanguageId): boolean {
  return SYNTAX[lang] !== null;
}

export interface CommentRun {
  /** 0-based first/last line of the run (inclusive). */
  startLine: number;
  endLine: number;
  /** Number of actual comment lines inside the run (blank lines in between don't count). */
  count: number;
}

/**
 * Per-line "this line is only a comment" flags. Trailing comments after code
 * (`x = 1  # note`) are NOT comment-only and stay visible, as does a shebang.
 */
export function commentOnlyLines(text: string, lang: LanguageId): boolean[] {
  const syn = SYNTAX[lang];
  const lines = text.split("\n");
  if (!syn) return lines.map(() => false);
  let inBlock = false;
  return lines.map((raw, i) => {
    const t = raw.trim();
    if (inBlock) {
      const close = syn.block![1];
      const idx = t.indexOf(close);
      if (idx < 0) return true;
      inBlock = false;
      return t.slice(idx + close.length).trim() === "";
    }
    if (t === "") return false;
    if (i === 0 && t.startsWith("#!")) return false;
    if (syn.block && t.startsWith(syn.block[0])) {
      const idx = t.indexOf(syn.block[1], syn.block[0].length);
      if (idx < 0) { inBlock = true; return true; }
      return t.slice(idx + syn.block[1].length).trim() === "";
    }
    return syn.line.some((p) => t.startsWith(p));
  });
}

/**
 * Group comment-only lines into runs. Blank lines sitting between two comment
 * lines belong to the run (so a commented section collapses to one marker);
 * blank lines before/after a run stay visible.
 */
export function commentRuns(text: string, lang: LanguageId): CommentRun[] {
  const lines = text.split("\n");
  const flags = commentOnlyLines(text, lang);
  const runs: CommentRun[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!flags[i]) { i++; continue; }
    let end = i;
    let count = 1;
    let j = i + 1;
    while (j < lines.length) {
      if (flags[j]) { end = j; count++; j++; continue; }
      if (lines[j].trim() === "") { j++; continue; } // tentatively skip blanks
      break;
    }
    runs.push({ startLine: i, endLine: end, count });
    i = end + 1;
  }
  return runs;
}

export function hiddenCommentLineCount(text: string, lang: LanguageId): number {
  return commentRuns(text, lang).reduce((n, r) => n + (r.endLine - r.startLine + 1), 0);
}
