import { describe, it, expect } from "vitest";
import { localShellKind, quotePaths, remoteDropPath, toCssPoint, toWslPath } from "./dropPaths";

describe("dropped file paths", () => {
  it("picks the quoting style from the shell", () => {
    expect(localShellKind("", true)).toBe("windows");
    expect(localShellKind("pwsh", true)).toBe("windows");
    expect(localShellKind("cmd", true)).toBe("cmd");
    expect(localShellKind("wsl", true)).toBe("wsl");
    expect(localShellKind("git-bash", true)).toBe("posix");
    expect(localShellKind(undefined, false)).toBe("posix");
  });

  it("quotes for PowerShell/cmd only when needed", () => {
    expect(quotePaths(["C:\\shots\\a.png"], "windows")).toBe("C:\\shots\\a.png ");
    expect(quotePaths(["C:\\My Shots\\a (1).png", "D:\\b.png"], "windows")).toBe("'C:\\My Shots\\a (1).png' D:\\b.png ");
    expect(quotePaths(["C:\\My Shots\\a (1).png"], "cmd")).toBe('"C:\\My Shots\\a (1).png" ');
  });

  it("never lets PowerShell expand a dropped file name", () => {
    expect(quotePaths(["C:\\dl\\a$(Start-Process calc).txt"], "windows")).toBe("'C:\\dl\\a$(Start-Process calc).txt' ");
    expect(quotePaths(["C:\\dl\\it's.txt"], "windows")).toBe("'C:\\dl\\it''s.txt' ");
  });

  it("single-quotes for POSIX shells and maps drives for WSL", () => {
    expect(quotePaths(["/home/me/it's.png"], "posix")).toBe("'/home/me/it'\\''s.png' ");
    expect(toWslPath("C:\\Users\\me\\a.png")).toBe("/mnt/c/Users/me/a.png");
    expect(quotePaths(["C:\\My Shots\\a.png"], "wsl")).toBe("'/mnt/c/My Shots/a.png' ");
  });

  it("uploads to /tmp under a name that needs no quoting", () => {
    expect(remoteDropPath("C:\\My Shots\\bug (2).png", 123)).toBe("/tmp/subterm-drop-123-bug__2_.png");
    expect(remoteDropPath("/x/'; rm -rf ~.png", 1)).toBe("/tmp/subterm-drop-1-___rm_-rf__.png");
  });

  it("converts Tauri's physical drop position to CSS pixels", () => {
    expect(toCssPoint({ x: 300, y: 150 }, 1.5)).toEqual({ x: 200, y: 100 });
  });
});
