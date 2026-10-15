// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeUrl,
  buildProxiedUrl,
  loadBookmarks,
  saveBookmarks,
  DEFAULT_BOOKMARKS,
  type ProxyInfo,
  type Bookmark,
} from "./browserService";

describe("browserService", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("normalizeUrl", () => {
    it("handles already-qualified URLs", () => {
      expect(normalizeUrl("https://192.168.1.1:8006")).toBe("https://192.168.1.1:8006");
      expect(normalizeUrl("http://localhost:3000")).toBe("http://localhost:3000");
    });

    it("defaults local/private IPs and localhost to http://", () => {
      expect(normalizeUrl("localhost:8080")).toBe("http://localhost:8080");
      expect(normalizeUrl("192.168.1.1")).toBe("http://192.168.1.1");
      expect(normalizeUrl("10.0.0.1:80")).toBe("http://10.0.0.1:80");
      expect(normalizeUrl("127.0.0.1:9090")).toBe("http://127.0.0.1:9090");
    });

    it("defaults domain names to https://", () => {
      expect(normalizeUrl("proxmox.lan:8006")).toBe("https://proxmox.lan:8006");
      expect(normalizeUrl("grafana.homelab.local")).toBe("https://grafana.homelab.local");
    });

    it("handles empty or blank input", () => {
      expect(normalizeUrl("")).toBe("about:blank");
      expect(normalizeUrl("   ")).toBe("about:blank");
    });
  });

  describe("buildProxiedUrl", () => {
    const proxy: ProxyInfo = {
      port: 47823,
      token: "testtoken123",
      running: true,
    };

    it("constructs proper proxy URL with query params", () => {
      const target = "https://192.168.1.100:8006/";
      const result = buildProxiedUrl(proxy, target);
      expect(result).toBe("http://127.0.0.1:47823/proxy?token=testtoken123&url=https%3A%2F%2F192.168.1.100%3A8006%2F");
    });

    it("returns target URL unchanged if proxy is not running", () => {
      const inactive: ProxyInfo = { port: 0, token: "", running: false };
      expect(buildProxiedUrl(inactive, "https://example.com")).toBe("https://example.com");
    });
  });

  describe("bookmarks", () => {
    it("returns default bookmarks when localStorage is empty", () => {
      expect(loadBookmarks()).toEqual(DEFAULT_BOOKMARKS);
    });

    it("saves and loads custom bookmarks", () => {
      const custom: Bookmark[] = [
        { id: "b1", title: "My NAS", url: "https://192.168.1.50:5001" },
      ];
      saveBookmarks(custom);
      expect(loadBookmarks()).toEqual(custom);
    });
  });
});
