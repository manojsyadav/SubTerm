import { describe, it, expect, vi } from "vitest";
import {
  stripAnsi, parsePromptCwd, parseOsc7, setTerminalCwd, getTerminalCwd, onTerminalCwdChange, shellQuote,
} from "./cwd";

// The exact prompt a stock Debian 12 bash prints: title OSC, coloured user@host, coloured path.
const DEBIAN_PROMPT =
  "\x1b]0;manoj@indra: ~/git_temp/Deployments\x07\x1b[01;32mmanoj@indra\x1b[00m:\x1b[01;34m~/git_temp/Deployments\x1b[00m$ ";

describe("parsePromptCwd", () => {
  it("reads the cwd from a coloured Debian/Ubuntu prompt (regression)", () => {
    expect(parsePromptCwd(DEBIAN_PROMPT)).toBe("~/git_temp/Deployments");
  });

  it("reads plain prompts, absolute paths and root prompts", () => {
    expect(parsePromptCwd("\r\nmanoj@indra:~$ ")).toBe("~");
    expect(parsePromptCwd("\nroot@web-01:/etc/nginx# ")).toBe("/etc/nginx");
  });

  it("copes with a virtualenv prefix", () => {
    expect(parsePromptCwd("\n(venv) dev@box:~/app$ ")).toBe("~/app");
  });

  it("uses the LAST prompt in a chunk (after cd)", () => {
    const chunk = "a@b:~$ cd /var/log\r\n" + "\x1b[32ma@b\x1b[0m:\x1b[34m/var/log\x1b[0m$ ";
    expect(parsePromptCwd("\n" + chunk)).toBe("/var/log");
  });

  it("ignores output that merely looks path-like", () => {
    expect(parsePromptCwd("modified:   Homepage/homepage.yaml\n")).toBeNull();
    expect(parsePromptCwd("user@host is unreachable")).toBeNull();
  });
});

describe("stripAnsi / parseOsc7 / shellQuote", () => {
  it("strips CSI and OSC sequences", () => {
    expect(stripAnsi("\x1b[01;34mhi\x1b[0m\x1b]0;title\x07!")).toBe("hi!");
  });
  it("parses OSC 7 payloads", () => {
    expect(parseOsc7("file://indra/home/manoj/my%20dir")).toBe("/home/manoj/my dir");
    expect(parseOsc7("/tmp")).toBe("/tmp");
    expect(parseOsc7("   ")).toBeNull();
  });
  it("quotes single quotes safely", () => {
    expect(shellQuote("it's here")).toBe(`'it'\\''s here'`);
  });
});

describe("cwd store", () => {
  it("stores per terminal and notifies only on change", () => {
    const fn = vi.fn();
    const off = onTerminalCwdChange(fn);
    setTerminalCwd("t1", "/a");
    setTerminalCwd("t1", "/a"); // same value: no event
    setTerminalCwd("t1", "/b");
    setTerminalCwd("t2", "/c");
    off();
    setTerminalCwd("t1", "/d"); // unsubscribed
    expect(fn.mock.calls).toEqual([["t1", "/a"], ["t1", "/b"], ["t2", "/c"]]);
    expect(getTerminalCwd("t1")).toBe("/d");
    expect(getTerminalCwd("nope")).toBeUndefined();
  });
});
