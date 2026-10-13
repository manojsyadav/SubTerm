// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { captureFrames, framesToSvg, paletteColor } from "./svgExport";

describe("paletteColor", () => {
  it("maps ANSI, cube and grey entries", () => {
    expect(paletteColor(1)).toBe("#cd3131");
    expect(paletteColor(16)).toBe("#000000");
    expect(paletteColor(196)).toBe("#ff0000");
    expect(paletteColor(232)).toBe("#080808");
  });
});

describe("captureFrames", () => {
  it("captures coloured text and skips identical screens", async () => {
    const frames = await captureFrames(
      { version: 2, width: 20, height: 2, timestamp: 0 },
      [[0.5, "o", "\x1b[31mred\x1b[0m ok"], [1.5, "o", ""], [2.5, "o", "\r\nnext"]],
    );
    // empty screen, after "red ok", after "next" (the empty write changes nothing)
    expect(frames.map((f) => f.t)).toEqual([0, 0.5, 2.5]);
    expect(frames[1].lines[0]).toEqual([{ text: "red", fg: "#cd3131" }, { text: " ok", fg: "#e4e4e7" }]);
    expect(frames[2].lines[1]).toEqual([{ text: "next", fg: "#e4e4e7" }]);
  });
});

describe("framesToSvg", () => {
  it("lays frames side by side with one keyframe each and escapes text", () => {
    const svg = framesToSvg(
      [{ t: 0, lines: [[{ text: "a<b", fg: "#fff" }]] }, { t: 1, lines: [[{ text: "x", fg: "#fff", bg: "#f00", bold: true }]] }],
      10, 1,
    );
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("a&lt;b");
    expect(svg).toContain("0.000%{transform:translateX(0px)}");
    expect(svg).toMatch(/33\.333%\{transform:translateX\(-\d+px\)\}/); // 1s of 3s total (2s hold)
    expect(svg).toContain('fill="#f00"');
    expect(svg).toContain('font-weight="bold"');
    expect(svg).toContain("animation:play 3.00s");
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.getElementsByTagName("parsererror").length).toBe(0);
    expect(doc.querySelectorAll("g[transform]").length).toBe(2);
  });
});
