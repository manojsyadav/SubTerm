import { describe, it, expect } from "vitest";
import { parseQuickTarget } from "./quickTarget";

describe("parseQuickTarget", () => {
  it("reads an IPv4 address with the default port and no user", () => {
    expect(parseQuickTarget("10.0.0.11")).toEqual({ host: "10.0.0.11", port: 22, username: "" });
  });

  it("reads user@host, host:port and both", () => {
    expect(parseQuickTarget("root@10.0.0.11")).toEqual({ host: "10.0.0.11", port: 22, username: "root" });
    expect(parseQuickTarget("box.example.com:2222")).toEqual({ host: "box.example.com", port: 2222, username: "" });
    expect(parseQuickTarget("bob@box.example.com:2200")).toEqual({ host: "box.example.com", port: 2200, username: "bob" });
  });

  it("accepts localhost, IPv6 and a single-label host only with an explicit user", () => {
    expect(parseQuickTarget("localhost")).toMatchObject({ host: "localhost" });
    expect(parseQuickTarget("::1")).toMatchObject({ host: "::1", port: 22 });
    expect(parseQuickTarget("me@[2001:db8::5]:2222")).toEqual({ host: "2001:db8::5", port: 2222, username: "me" });
    expect(parseQuickTarget("deploy@web")).toEqual({ host: "web", port: 22, username: "deploy" });
  });

  it("treats a bare word as a search, not a target", () => {
    expect(parseQuickTarget("web")).toBeNull();
    expect(parseQuickTarget("prod-db")).toBeNull();
    expect(parseQuickTarget("")).toBeNull();
  });

  it("rejects malformed input", () => {
    for (const t of ["10.0.0.999", "10.0.0", "a b", "host:abc", "host.com:70000", "host.com:0", "@host.com", "us er@host.com", "web-*", "10.0.0.1:"]) {
      expect(parseQuickTarget(t), t).toBeNull();
    }
  });
});
