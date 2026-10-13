import type { Frame } from "./svgExport";
import { BG, FONT_SIZE, LINE_H, PAD } from "./svgExport";
import { encodeGif, type GifFrame } from "./gifEncoder";

// Animated GIF of captured frames (see svgExport.captureFrames): each frame is drawn
// on a canvas with the same layout as the SVG, then every pixel is mapped to the
// nearest colour the recording actually uses (anti-aliased text edges included).

/** GIFs hold full frames, so they get fewer than the SVG's 600. */
export const GIF_MAX_FRAMES = 300;

const toInt = (hex: string) => parseInt(hex.slice(1), 16);

/** Every colour the frames use, background first, at most 256. */
export function framePalette(frames: readonly Frame[]): number[] {
  const set = new Set<number>([toInt(BG)]);
  for (const f of frames) for (const line of f.lines) for (const r of line) {
    set.add(toInt(r.fg));
    if (r.bg) set.add(toInt(r.bg));
  }
  return [...set].slice(0, 256);
}

/** Index of the palette colour nearest to `rgb`, memoised per colour. */
export function nearestIndex(palette: readonly number[], cache: Map<number, number>, rgb: number): number {
  const hit = cache.get(rgb);
  if (hit !== undefined) return hit;
  const r = rgb >> 16, g = (rgb >> 8) & 255, b = rgb & 255;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const c = palette[i];
    const d = (r - (c >> 16)) ** 2 + (g - ((c >> 8) & 255)) ** 2 + (b - (c & 255)) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  cache.set(rgb, best);
  return best;
}

export function framesToGif(frames: readonly Frame[], cols: number, rows: number, holdSeconds = 2): Uint8Array {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas is not available");
  const font = `${FONT_SIZE}px "JetBrains Mono", Menlo, Consolas, monospace`;
  ctx.font = font;
  const charW = ctx.measureText("M").width || FONT_SIZE * 0.6;
  canvas.width = Math.ceil(cols * charW + PAD * 2);
  canvas.height = Math.ceil(rows * LINE_H + PAD * 2);
  const palette = framePalette(frames);
  const cache = new Map<number, number>();

  const out: GifFrame[] = frames.map((f, i) => {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = font;
    ctx.textBaseline = "alphabetic";
    f.lines.forEach((runs, y) => {
      let col = 0;
      for (const r of runs) {
        const x = PAD + col * charW;
        if (r.bg) { ctx.fillStyle = r.bg; ctx.fillRect(x, PAD + y * LINE_H, r.text.length * charW, LINE_H); }
        ctx.fillStyle = r.fg;
        ctx.font = r.bold ? `bold ${font}` : font;
        // Character by character, so the grid stays exact whatever the font's real advance.
        for (let c = 0; c < r.text.length; c++) {
          if (r.text[c] !== " ") ctx.fillText(r.text[c], x + c * charW, PAD + y * LINE_H + FONT_SIZE);
        }
        col += r.text.length;
      }
    });
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const indices = new Uint8Array(canvas.width * canvas.height);
    for (let p = 0, q = 0; q < indices.length; p += 4, q++) {
      indices[q] = nearestIndex(palette, cache, (data[p] << 16) | (data[p + 1] << 8) | data[p + 2]);
    }
    const next = frames[i + 1];
    return { indices, delayCs: ((next ? next.t - f.t : holdSeconds) * 100) };
  });
  return encodeGif(canvas.width, canvas.height, palette, out);
}
