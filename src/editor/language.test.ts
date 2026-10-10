import { describe, it, expect } from "vitest";
import { detectLanguage } from "./language";

describe("detectLanguage", () => {
  it("maps common extensions", () => {
    expect(detectLanguage("deploy.sh")).toBe("shell");
    expect(detectLanguage("config.yml")).toBe("yaml");
    expect(detectLanguage("package.json")).toBe("json");
    expect(detectLanguage("main.rs")).toBe("rust");
    expect(detectLanguage("app.tsx")).toBe("tsx");
  });
  it("handles dotfiles and special names", () => {
    expect(detectLanguage(".bashrc")).toBe("shell");
    expect(detectLanguage(".env.production")).toBe("shell");
    expect(detectLanguage("Dockerfile")).toBe("dockerfile");
    expect(detectLanguage("Dockerfile.dev")).toBe("dockerfile");
  });
  it("tells nginx configs apart from generic .conf", () => {
    expect(detectLanguage("default.conf", "/etc/nginx/conf.d/default.conf")).toBe("nginx");
    expect(detectLanguage("nginx.conf")).toBe("nginx");
    expect(detectLanguage("sysctl.conf", "/etc/sysctl.conf")).toBe("properties");
  });
  it("is case-insensitive and falls back to plain", () => {
    expect(detectLanguage("README.MD")).toBe("markdown");
    expect(detectLanguage("notes.xyz")).toBe("plain");
    expect(detectLanguage("noext")).toBe("plain");
  });
});
