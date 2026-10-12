import { describe, it, expect } from "vitest";
import { parseSshCommand } from "./sshCommand";

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
