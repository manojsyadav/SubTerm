import { describe, it, expect } from "vitest";
import { looksLikePasswordPrompt, looksLikeSudoPrompt, probeWasEchoed } from "./passwordPrompt";

describe("looksLikeSudoPrompt", () => {
  it("matches sudo's prompt at the end of output, colours stripped", () => {
    expect(looksLikeSudoPrompt("$ sudo apt update\r\n[sudo] password for manoj: ")).toBe(true);
    expect(looksLikeSudoPrompt("\x1b[1m[sudo] password for root:\x1b[0m ")).toBe(true);
  });
  it("ignores other password prompts and answered prompts", () => {
    expect(looksLikeSudoPrompt("Password: ")).toBe(false);
    expect(looksLikeSudoPrompt("Enter password: ")).toBe(false);
    expect(looksLikeSudoPrompt("[sudo] password for manoj: \r\nok\r\n$ ")).toBe(false);
    expect(looksLikePasswordPrompt("Password: ")).toBe(true);
  });
});

describe("probeWasEchoed", () => {
  it("is quiet at a no-echo prompt, also with pwfeedback stars", () => {
    expect(probeWasEchoed("")).toBe(false);
    expect(probeWasEchoed("*\b \b")).toBe(false);
  });
  it("flags a prompt that shows what is typed", () => {
    expect(probeWasEchoed("x\b \b")).toBe(true);
    expect(probeWasEchoed("x\b\x1b[K")).toBe(true);
  });
});
