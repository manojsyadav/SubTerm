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

export const LOG_FORMAT = "%h%x1f%s%x1f%an%x1f%D";

/** Parse `git log --format=<LOG_FORMAT>`. */
export function parseLog(out: string): GitCommit[] {
  return out.split("\n").filter((l) => l.includes("\x1f")).map((l) => {
    const [hash, subject, author, refs] = l.split("\x1f");
    return { hash, subject, author, refs: refs ? refs.split(", ").filter(Boolean) : [] };
  });
}
