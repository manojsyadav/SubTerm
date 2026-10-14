import { describe, it, expect } from "vitest";
import { parseStatusZ, parseLog } from "./porcelain";

describe("parseStatusZ", () => {
  it("reads branch, tracking and both file lists", () => {
    const out = [
      "## feat/x...origin/feat/x [ahead 2, behind 1]",
      "M  src/a.ts",
      " M src/b c.ts",
      "MM both.ts",
      "R  new.ts", "old.ts",
      "?? notes.md",
      "",
    ].join("\0");
    const st = parseStatusZ(out);
    expect(st).toMatchObject({ branch: "feat/x", upstream: "origin/feat/x", ahead: 2, behind: 1 });
    expect(st.staged).toEqual([
      { path: "src/a.ts", code: "M", orig: undefined },
      { path: "both.ts", code: "M", orig: undefined },
      { path: "new.ts", code: "R", orig: "old.ts" },
    ]);
    expect(st.changes).toEqual([
      { path: "src/b c.ts", code: "M" },
      { path: "both.ts", code: "M" },
      { path: "notes.md", code: "U" },
    ]);
  });

  it("handles a branch with no upstream and no commits", () => {
    expect(parseStatusZ("## main\0")).toMatchObject({ branch: "main", upstream: null, ahead: 0 });
    expect(parseStatusZ("## No commits yet on dev\0").branch).toBe("dev");
  });
});

describe("parseLog", () => {
  it("splits fields, refs and parents", () => {
    const out = "abc1234\x1ffeat: x\x1fManoj\x1fHEAD -> main, origin/main\x1fd00d000 111aaaa\nd00d000\x1ffix: y\x1fManoj\x1f\x1f\n";
    expect(parseLog(out)).toEqual([
      { hash: "abc1234", subject: "feat: x", author: "Manoj", refs: ["HEAD -> main", "origin/main"], parents: ["d00d000", "111aaaa"] },
      { hash: "d00d000", subject: "fix: y", author: "Manoj", refs: [], parents: [] },
    ]);
  });
});
