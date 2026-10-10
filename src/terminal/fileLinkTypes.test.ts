import { describe, it, expect, beforeEach, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

const m = await import("./fileLinkTypes");

const matches = (re: RegExp | null, line: string) => (re ? [...line.matchAll(re)].map((x) => x[1]) : []);

describe("normalizers", () => {
  it("cleans extensions and rejects junk", () => {
    expect(m.normalizeExtension("*.YAML")).toBe("yaml");
    expect(m.normalizeExtension(" .c++ ")).toBe("c++");
    expect(m.normalizeExtension("")).toBeNull();
    expect(m.normalizeExtension("a b")).toBeNull();
    expect(m.normalizeExtension("x/y")).toBeNull();
    expect(m.normalizeExtension("a".repeat(40))).toBeNull();
  });
  it("accepts plain file names only", () => {
    expect(m.normalizeFileName("Dockerfile")).toBe("Dockerfile");
    expect(m.normalizeFileName("docker-compose.yml")).toBe("docker-compose.yml");
    expect(m.normalizeFileName("a/b")).toBeNull();
    expect(m.normalizeFileName("has space")).toBeNull();
  });
});

describe("settings storage", () => {
  beforeEach(() => store.clear());

  it("falls back to defaults and includes the certificate types", () => {
    expect(m.loadFileLinkExtensions()).toEqual([...m.DEFAULT_FILE_LINK_EXTENSIONS]);
    expect(m.loadFileLinkExtensions()).toContain("crt");
    expect(m.loadFileLinkNames()).toEqual(["Dockerfile", "Makefile"]);
  });

  it("saves, de-duplicates and normalizes", () => {
    m.saveFileLinkExtensions(["YAML", "*.yaml", "tpl", "bad ext"]);
    expect(m.loadFileLinkExtensions()).toEqual(["yaml", "tpl"]);
  });

  it("keeps an explicitly emptied list empty (does not silently restore defaults)", () => {
    m.saveFileLinkExtensions([]);
    expect(m.loadFileLinkExtensions()).toEqual([]);
  });

  it("recovers from corrupt data and can reset", () => {
    store.set("subterm-file-link-extensions", "{not json");
    expect(m.loadFileLinkExtensions()).toEqual([...m.DEFAULT_FILE_LINK_EXTENSIONS]);
    m.saveFileLinkExtensions(["only"]);
    m.resetFileLinkTypes();
    expect(m.loadFileLinkExtensions()).toEqual([...m.DEFAULT_FILE_LINK_EXTENSIONS]);
  });
});

describe("buildFileLinkRegex", () => {
  const re = () => m.buildFileLinkRegex(["yml", "yaml", "js", "jsx", "c++"], ["Dockerfile"]);

  it("matches configured names and ignores others", () => {
    expect(matches(re(), "see docker-compose.yml and notes.txt now")).toEqual(["docker-compose.yml"]);
    expect(matches(re(), "-rw-r--r-- app.jsx Dockerfile main.c++")).toEqual(["app.jsx", "Dockerfile", "main.c++"]);
  });

  it("only matches after a boundary, so it does not grab the middle of a path", () => {
    expect(matches(re(), "src/app.js")).toEqual([]);
    expect(matches(re(), '"quoted.yml"')).toEqual(["quoted.yml"]);
  });

  it("returns null when nothing is configured", () => {
    expect(m.buildFileLinkRegex([], [])).toBeNull();
  });

  it("escapes regex characters in user input", () => {
    const r = m.buildFileLinkRegex(["c++"], [])!;
    expect(matches(r, "a.c++")).toEqual(["a.c++"]);
    expect(matches(r, "a.cc")).toEqual([]);
  });
});

describe("live regex and picker helper follow the saved settings", () => {
  beforeEach(() => store.clear());

  it("getFileLinkRegex uses defaults, then follows user changes, then reset", () => {
    expect(matches(m.getFileLinkRegex(), "x.crt y.tpl")).toEqual(["x.crt"]);
    m.saveFileLinkExtensions(["tpl"]);
    expect(matches(m.getFileLinkRegex(), "x.crt y.tpl")).toEqual(["y.tpl"]);
    m.saveFileLinkExtensions([]);
    m.saveFileLinkNames([]);
    expect(m.getFileLinkRegex()).toBeNull();
    m.resetFileLinkTypes();
    expect(matches(m.getFileLinkRegex(), "x.crt y.tpl")).toEqual(["x.crt"]);
  });

  it("isClickableFileName honours extensions and special names", () => {
    expect(m.isClickableFileName("server.CRT")).toBe(true);
    expect(m.isClickableFileName("Dockerfile")).toBe(true);
    expect(m.isClickableFileName("photo.png")).toBe(false);
    m.saveFileLinkExtensions(["png"]);
    expect(m.isClickableFileName("photo.png")).toBe(true);
    expect(m.isClickableFileName("server.crt")).toBe(false);
  });
});
