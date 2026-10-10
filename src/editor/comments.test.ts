import { describe, it, expect } from "vitest";
import { commentOnlyLines, commentRuns, hiddenCommentLineCount, supportsCommentHiding } from "./comments";

describe("commentOnlyLines", () => {
  it("flags hash comments but not trailing comments or code", () => {
    const text = "# top\nkey: 1  # trailing\n  # indented\nother: 2";
    expect(commentOnlyLines(text, "yaml")).toEqual([true, false, true, false]);
  });

  it("keeps a shebang visible", () => {
    expect(commentOnlyLines("#!/bin/bash\n# note\necho hi", "shell")).toEqual([false, true, false]);
  });

  it("handles multi-line block comments", () => {
    const text = "/* a\n b\n */\nint x;\n/* one */\nint y; /* t */";
    expect(commentOnlyLines(text, "cpp")).toEqual([true, true, true, false, true, false]);
  });

  it("does not treat code after a block close as comment-only", () => {
    expect(commentOnlyLines("/* c */ int x;", "cpp")).toEqual([false]);
  });

  it("handles html comments and sql dashes", () => {
    expect(commentOnlyLines("<!-- a\nb -->\n<p/>", "html")).toEqual([true, true, false]);
    expect(commentOnlyLines("-- c\nselect 1;", "sql")).toEqual([true, false]);
  });

  it("treats unknown files as hash-commented and markdown as unsupported", () => {
    expect(commentOnlyLines("# x\ny", "plain")).toEqual([true, false]);
    expect(supportsCommentHiding("markdown")).toBe(false);
    expect(commentOnlyLines("# heading", "markdown")).toEqual([false]);
  });
});

describe("commentRuns", () => {
  it("merges comment lines separated by blanks but leaves outer blanks alone", () => {
    const text = "a\n\n# one\n\n# two\n\nb";
    expect(commentRuns(text, "shell")).toEqual([{ startLine: 2, endLine: 4, count: 2 }]);
  });

  it("splits runs that are separated by code", () => {
    const text = "# a\nx=1\n# b\n# c";
    expect(commentRuns(text, "shell")).toEqual([
      { startLine: 0, endLine: 0, count: 1 },
      { startLine: 2, endLine: 3, count: 2 },
    ]);
  });

  it("counts hidden lines including inner blanks", () => {
    expect(hiddenCommentLineCount("# a\n\n# b\ncode", "shell")).toBe(3);
  });
});
