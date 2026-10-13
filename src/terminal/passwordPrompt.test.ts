import { describe, it, expect } from "vitest";
import { looksLikePasswordPrompt, looksLikeSudoPrompt } from "./passwordPrompt";

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
