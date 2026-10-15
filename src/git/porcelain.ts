export interface GitFile {
  path: string;
  /** Source path of a rename or copy. */
  orig?: string;
  /** VS Code-style letter: M, A, D, R, C, U (untracked or unmerged). */
  code: string;
}

export interface GitStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitFile[];
  changes: GitFile[];
}

export interface GitCommit {
  hash: string;
  subject: string;
  author: string;
  refs: string[];
  parents?: string[];
  date?: string;
}

/** Parse `git status --porcelain=v1 -b -z`. */
export function parseStatusZ(out: string): GitStatus {
  const st: GitStatus = { branch: "", upstream: null, ahead: 0, behind: 0, staged: [], changes: [] };
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 3) continue;
    if (p.startsWith("## ")) {
      let h = p.slice(3);
      const track = h.match(/\s*\[(.*)\]$/);
      if (track) {
        st.ahead = Number(track[1].match(/ahead (\d+)/)?.[1] ?? 0);
        st.behind = Number(track[1].match(/behind (\d+)/)?.[1] ?? 0);
        h = h.slice(0, track.index);
      }
      h = h.replace(/^(No commits yet on|Initial commit on) /, "");
      const [branch, upstream] = h.split("...");
      st.branch = branch;
      st.upstream = upstream || null;
      continue;
    }
    const x = p[0], y = p[1], path = p.slice(3);
    // -z puts a rename's source path in the next field.
    const orig = x === "R" || x === "C" ? parts[++i] : undefined;
    if (x === "?") { st.changes.push({ path, code: "U" }); continue; }
    if (x === "!") continue;
    if (x !== " ") st.staged.push({ path, orig, code: x });
    if (y !== " ") st.changes.push({ path, code: y });
  }
  return st;
}

export const LOG_FORMAT = "%h%x1f%s%x1f%an%x1f%D%x1f%p%x1f%cr";

/** Parse `git log --format=<LOG_FORMAT>`. */
export function parseLog(out: string): GitCommit[] {
  return out.split("\n").filter((l) => l.includes("\x1f")).map((l) => {
    const [hash, subject, author, refs, parents, date] = l.split("\x1f");
    return {
      hash,
      subject,
      author,
      refs: refs ? refs.split(", ").filter(Boolean) : [],
      parents: parents ? parents.trim().split(/\s+/).filter(Boolean) : [],
      date: date || undefined,
    };
  });
}

export interface GitBranch {
  name: string;
  isCurrent: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  hash: string;
  subject: string;
}

export function parseBranches(out: string): GitBranch[] {
  return out.split("\n").filter((l) => l.trim().length > 0).map((l) => {
    const [name, head, upstream, track, hash, subject] = l.split("\t");
    let ahead = 0;
    let behind = 0;
    if (track) {
      ahead = Number(track.match(/ahead (\d+)/)?.[1] ?? 0);
      behind = Number(track.match(/behind (\d+)/)?.[1] ?? 0);
    }
    return {
      name: (name || "").trim(),
      isCurrent: (head || "").trim() === "*",
      upstream: (upstream || "").trim() || null,
      ahead,
      behind,
      hash: (hash || "").trim(),
      subject: (subject || "").trim(),
    };
  });
}

export interface CommitFileChange {
  code: string;
  path: string;
}

export function parseDiffTree(out: string): CommitFileChange[] {
  return out.split("\n").filter((l) => l.trim().length > 0).map((l) => {
    const parts = l.split("\t");
    const code = (parts[0] || "").trim();
    const path = parts.slice(1).join("\t").trim();
    return { code, path };
  });
}

