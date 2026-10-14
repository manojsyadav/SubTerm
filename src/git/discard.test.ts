import { describe, it, expect } from "vitest";

function getDiscardCommands(file: { path: string; code: string }): string[][] {
  const top = (p: string) => `:(top,literal)${p}`;
  if (file.code === "U" || file.code === "?") {
    return [["clean", "-f", "--", top(file.path)]];
  }
  return [["restore", "--", top(file.path)]];
}

function getDiscardAllCommands(): string[][] {
  return [["restore", "."], ["clean", "-fd"]];
}

describe("Git discard command generator", () => {
  it("generates git clean for untracked files", () => {
    const untracked = { path: "new-file.txt", code: "U" };
    expect(getDiscardCommands(untracked)).toEqual([["clean", "-f", "--", ":(top,literal)new-file.txt"]]);
  });

  it("generates git restore for modified and deleted files", () => {
    const modified = { path: "src/index.ts", code: "M" };
    expect(getDiscardCommands(modified)).toEqual([["restore", "--", ":(top,literal)src/index.ts"]]);

    const deleted = { path: "old.txt", code: "D" };
    expect(getDiscardCommands(deleted)).toEqual([["restore", "--", ":(top,literal)old.txt"]]);
  });

  it("generates restore and clean for batch discard of all changes", () => {
    expect(getDiscardAllCommands()).toEqual([["restore", "."], ["clean", "-fd"]]);
  });
});
