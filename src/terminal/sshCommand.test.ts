import { describe, it, expect } from "vitest";
import { parseSshCommand, parseSshFromScreen, SSH_ENDED_RE, endsWithWindowsShellPrompt } from "./sshCommand";

describe("parseSshCommand", () => {
  it("parses user@host", () => {
    expect(parseSshCommand("ssh root@10.0.0.5")).toEqual({
      kind: "ssh", host: "10.0.0.5", username: "root", port: undefined, identityFile: undefined,
    });
  });

  it("parses port, login name and identity file in several spellings", () => {
    const a = parseSshCommand("ssh -p 2222 -i ~/.ssh/id_ed25519 bob@box");
    expect(a).toMatchObject({ host: "box", username: "bob", port: 2222, identityFile: "~/.ssh/id_ed25519" });
    expect(parseSshCommand("ssh -p2200 box")).toMatchObject({ host: "box", port: 2200 });
    expect(parseSshCommand("ssh -l alice box")).toMatchObject({ host: "box", username: "alice" });
    expect(parseSshCommand("ssh -vv -4 -i \"C:\\keys\\my key\" box")).toMatchObject({
      host: "box", identityFile: "C:\\keys\\my key",
    });
  });

  it("keeps a bare alias", () => {
    expect(parseSshCommand("ssh prod-db")).toMatchObject({ host: "prod-db", username: undefined });
  });

  it("handles sftp with -P and host:path", () => {
    expect(parseSshCommand("sftp -P 2022 me@files:/var/www")).toMatchObject({
      kind: "sftp", host: "files", username: "me", port: 2022,
    });
  });

  it("accepts a full path or .exe for the binary", () => {
    expect(parseSshCommand("C:\\Windows\\System32\\OpenSSH\\ssh.exe me@h")).toMatchObject({ host: "h" });
  });

  it("ignores non-interactive or complex invocations", () => {
    expect(parseSshCommand("ssh host ls -la")).toBeNull();
    expect(parseSshCommand("ssh -J jump host")).toBeNull();
    expect(parseSshCommand("ssh -L 8080:localhost:80 host")).toBeNull();
    expect(parseSshCommand("ssh -o ProxyCommand=nc host")).toBeNull();
    expect(parseSshCommand("ssh host | tee log")).toBeNull();
    expect(parseSshCommand("ssh")).toBeNull();
    expect(parseSshCommand("ssh -p abc host")).toBeNull();
    expect(parseSshCommand("scp a b:c")).toBeNull();
    expect(parseSshCommand("echo ssh host")).toBeNull();
  });
});

describe("SSH_ENDED_RE", () => {
  it("recognises the client returning to the local shell", () => {
    for (const t of [
      "Connection to 10.0.0.5 closed.\r\n",
      "ssh: connect to host x port 22: Connection refused",
      "ssh: Could not resolve hostname nope",
      "user@h: Permission denied (publickey).",
      "logout\r\n",
    ]) expect(SSH_ENDED_RE.test(t), t).toBe(true);
    expect(SSH_ENDED_RE.test("total 8\r\ndrwxr-xr-x  2 root root")).toBe(false);
  });
});

describe("parseSshFromScreen", () => {
  it("skips the prompt and reads the command as shown", () => {
    expect(parseSshFromScreen("PS C:\\Users\\me> ssh 10.0.0.11", "ssh 10.0.0.11", false)).toMatchObject({ host: "10.0.0.11" });
    expect(parseSshFromScreen("PS C:\\> C:\\Windows\\System32\\OpenSSH\\ssh.exe me@h", "C:\\Windows\\System32\\OpenSSH\\ssh.exe me@h", false)).toMatchObject({ host: "h" });
    expect(parseSshFromScreen("me@box:~$ ssh -p 2222 bob@srv", "ssh -p 2222 bob@srv", false)).toMatchObject({ host: "srv", username: "bob", port: 2222 });
  });

  it("uses the completed host when Tab changed the line", () => {
    // typed "ssh 10.0." then Tab completed it
    expect(parseSshFromScreen("$ ssh 10.0.0.11", "ssh 10.0.", true)).toMatchObject({ host: "10.0.0.11" });
    // typed "ss" then Tab completed the command name too
    expect(parseSshFromScreen("$ ssh prod-db", "ss", true)).toMatchObject({ host: "prod-db" });
  });

  it("handles a command recalled from history (nothing typed)", () => {
    expect(parseSshFromScreen("PS> ssh me@files", "", true)).toMatchObject({ host: "files", username: "me" });
    expect(parseSshFromScreen("PS> ssh me@files", "", false)).toMatchObject({ host: "files" });
  });

  it("does not read ssh out of another command", () => {
    expect(parseSshFromScreen("$ echo ssh box", "echo ssh box", false)).toBeNull();
    expect(parseSshFromScreen("$ git log", "git log", false)).toBeNull();
  });

  it("still rejects complex invocations", () => {
    expect(parseSshFromScreen("$ ssh host ls", "ssh host ls", false)).toBeNull();
  });
});

describe("endsWithWindowsShellPrompt", () => {
  it("sees PowerShell and cmd prompts at the end of output", () => {
    expect(endsWithWindowsShellPrompt("\r\nPS C:\\Users\\me> ")).toBe(true);
    expect(endsWithWindowsShellPrompt("\x1b[32mPS D:\\REPO>\x1b[0m ")).toBe(true);
    expect(endsWithWindowsShellPrompt("Microsoft Windows\r\nC:\\Windows\\System32>")).toBe(true);
  });
  it("ignores remote prompts and prompts that are not last", () => {
    expect(endsWithWindowsShellPrompt("user@host:~$ ")).toBe(false);
    expect(endsWithWindowsShellPrompt("PS C:\\> ssh box\r\nuser@box:~$ ")).toBe(false);
    expect(endsWithWindowsShellPrompt("echo C:\\a > b")).toBe(false);
  });
});
