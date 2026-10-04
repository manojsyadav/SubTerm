import { describe, it, expect } from "vitest";
import { computeDiff } from "./diff";

describe("computeDiff", () => {
  it("reports no changes for identical text", () => {
    const text = "line1\nline2\nline3";
    const diff = computeDiff(text, text);
    expect(diff.every((l) => l.type === "same")).toBe(true);
    expect(diff).toHaveLength(3);
  });

  it("detects a pure addition", () => {
    const diff = computeDiff("a\nb", "a\nb\nc");
    const added = diff.filter((l) => l.type === "add");
    expect(added).toHaveLength(1);
    expect(added[0].text).toBe("c");
  });

  it("detects a pure deletion", () => {
    const diff = computeDiff("a\nb\nc", "a\nc");
    const deleted = diff.filter((l) => l.type === "del");
    expect(deleted).toHaveLength(1);
    expect(deleted[0].text).toBe("b");
  });

  it("detects a single-line modification as a delete+add pair", () => {
    const diff = computeDiff("hello world", "hello there");
    expect(diff.some((l) => l.type === "del" && l.text === "hello world")).toBe(true);
    expect(diff.some((l) => l.type === "add" && l.text === "hello there")).toBe(true);
  });

  it("handles two empty files", () => {
    expect(computeDiff("", "")).toEqual([{ type: "same", text: "", oldNum: 1, newNum: 1 }]);
  });

  it("numbers lines independently per side", () => {
    // Deleting the first line should not perturb the new-side line numbers
    // for everything after it.
    const diff = computeDiff("x\ny\nz", "y\nz");
    const kept = diff.filter((l) => l.type === "same");
    expect(kept.map((l) => l.newNum)).toEqual([1, 2]);
  });
});
