import { describe, it, expect } from "vitest";
import { compileTriggers, matchTriggers, newTrigger, type TerminalTrigger } from "./triggers";

const trigger = (overrides: Partial<TerminalTrigger>): TerminalTrigger => ({
  ...newTrigger(),
  ...overrides,
});

describe("compileTriggers", () => {
  it("skips disabled triggers", () => {
    const compiled = compileTriggers([trigger({ pattern: "ERROR", enabled: false })]);
    expect(compiled).toHaveLength(0);
  });

  it("skips triggers with a blank pattern", () => {
    const compiled = compileTriggers([trigger({ pattern: "   " })]);
    expect(compiled).toHaveLength(0);
  });

  it("escapes a plain-keyword pattern so regex metacharacters are literal", () => {
    const compiled = compileTriggers([trigger({ pattern: "a.b(c)", isRegex: false })]);
    expect(compiled[0].regex.test("a.b(c)")).toBe(true);
    expect(compiled[0].regex.test("aXb(c)")).toBe(false); // '.' must not act as wildcard
  });

  it("compiles a regex pattern as-is when isRegex is set", () => {
    const compiled = compileTriggers([trigger({ pattern: "ERR(OR|NO)", isRegex: true })]);
    expect(compiled[0].regex.test("ERROR: disk full")).toBe(true);
    expect(compiled[0].regex.test("ERRNO: 42")).toBe(true);
  });

  it("drops an invalid user regex instead of throwing", () => {
    const compiled = compileTriggers([trigger({ pattern: "(unterminated", isRegex: true })]);
    expect(compiled).toHaveLength(0);
  });

  it("is case-insensitive unless caseSensitive is set", () => {
    const insensitive = compileTriggers([trigger({ pattern: "error", caseSensitive: false })]);
    expect(insensitive[0].regex.test("ERROR")).toBe(true);
    const sensitive = compileTriggers([trigger({ pattern: "error", caseSensitive: true })]);
    expect(sensitive[0].regex.test("ERROR")).toBe(false);
  });
});

describe("matchTriggers", () => {
  it("returns every trigger matching the chunk", () => {
    const compiled = compileTriggers([
      trigger({ pattern: "ERROR" }),
      trigger({ pattern: "WARN" }),
      trigger({ pattern: "DEBUG" }),
    ]);
    const matched = matchTriggers("2026-01-01 ERROR: connection refused", compiled);
    expect(matched.map((t) => t.pattern)).toEqual(["ERROR"]);
  });

  it("returns an empty array when nothing matches", () => {
    const compiled = compileTriggers([trigger({ pattern: "FATAL" })]);
    expect(matchTriggers("all good here", compiled)).toHaveLength(0);
  });
});
