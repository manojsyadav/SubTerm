import { Terminal, type IBufferCell } from "xterm";
import type { CastEvent, CastHeader } from "./recorder";
import { parseResize } from "./playback";

// Animated SVG export of a recording, for runbooks and READMEs (GitHub and
// browsers play it without a player). The cast is replayed through an
// off-screen xterm, the screen is captured as coloured text runs at most every
// `minGap` seconds, and the frames are laid side by side in one SVG that a
// stepped CSS animation slides through.

export interface Run { text: string; fg: string; bg?: string; bold?: boolean }
export interface Frame { t: number; lines: Run[][] }

const FG = "#e4e4e7";
const BG = "#0b0b0f";
const FONT_SIZE = 14;
const CHAR_W = FONT_SIZE * 0.6;
const LINE_H = FONT_SIZE * 1.25;
const PAD = 12;
/** More frames than this makes the file too large to be useful; the sampling gap grows instead. */
const MAX_FRAMES = 600;

const ANSI16 = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

/** xterm's 256-colour palette: 16 ANSI, a 6x6x6 cube, then 24 greys. */
export function paletteColor(i: number): string {
  if (i < 16) return ANSI16[i];
  if (i < 232) {
    const c = i - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return hex((level(Math.floor(c / 36)) << 16) | (level(Math.floor(c / 6) % 6) << 8) | level(c % 6));
  }
  const g = 8 + (i - 232) * 10;
  return hex((g << 16) | (g << 8) | g);
}

function cellColors(cell: IBufferCell): { fg: string; bg?: string } {
  let fg = cell.isFgDefault() ? FG : cell.isFgRGB() ? hex(cell.getFgColor()) : paletteColor(cell.getFgColor());
  let bg = cell.isBgDefault() ? undefined : cell.isBgRGB() ? hex(cell.getBgColor()) : paletteColor(cell.getBgColor());
  if (cell.isInverse()) [fg, bg] = [bg ?? BG, fg];
  return { fg, bg };
}

function captureScreen(term: Terminal): Run[][] {
  const buf = term.buffer.active;
  const lines: Run[][] = [];
  let cell: IBufferCell | undefined;
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    const runs: Run[] = [];
    if (line) {
      for (let x = 0; x < term.cols; x++) {
        cell = line.getCell(x, cell);
        if (!cell || cell.getWidth() === 0) continue; // second half of a wide character
        const { fg, bg } = cellColors(cell);
        const bold = !!cell.isBold();
        const ch = cell.getChars() || " ";
        const last = runs[runs.length - 1];
        if (last && last.fg === fg && last.bg === bg && !!last.bold === bold) last.text += ch;
        else runs.push({ text: ch, fg, ...(bg ? { bg } : {}), ...(bold ? { bold } : {}) });
      }
    }
    // Trailing default-coloured spaces carry nothing.
    const last = runs[runs.length - 1];
    if (last && !last.bg) last.text = last.text.replace(/ +$/, "");
    lines.push(runs.filter((r) => r.text !== "" || r.bg));
  }
  return lines;
}

const write = (term: Terminal, data: string) => new Promise<void>((r) => term.write(data, r));

/** Replay `events` and capture the screen as frames, at most one per `minGap` seconds. */
export async function captureFrames(header: CastHeader, events: readonly CastEvent[]): Promise<Frame[]> {
  const duration = events.length ? events[events.length - 1][0] : 0;
  const minGap = Math.max(0.1, duration / MAX_FRAMES);
  const term = new Terminal({ cols: header.width, rows: header.height, scrollback: 0, allowProposedApi: true });
  const frames: Frame[] = [];
  let lastKey = "";
  let lastT = -Infinity;
  const capture = (t: number) => {
    const lines = captureScreen(term);
    const key = JSON.stringify(lines);
    if (key === lastKey) return;
    lastKey = key;
    lastT = t;
    frames.push({ t, lines });
  };
  try {
    capture(0);
    for (let i = 0; i < events.length; i++) {
      const [t, code, data] = events[i];
      if (code === "o") await write(term, data);
      else if (code === "r") {
        const size = parseResize(data);
        if (size) term.resize(size.cols, size.rows);
      }
      const nextT = i + 1 < events.length ? events[i + 1][0] : Infinity;
      // Capture once the screen settles: before a pause, or when the gap budget is used up.
      if (nextT - t >= minGap || t - lastT >= minGap) capture(t);
    }
  } finally {
    term.dispose();
  }
  return frames;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One SVG holding every frame side by side, slid through with a stepped animation. */
export function framesToSvg(frames: readonly Frame[], cols: number, rows: number, holdSeconds = 2): string {
  const w = Math.ceil(cols * CHAR_W + PAD * 2);
  const h = Math.ceil(rows * LINE_H + PAD * 2);
  const total = Math.max(0.1, (frames.length ? frames[frames.length - 1].t : 0) + holdSeconds);
  const pct = (t: number) => ((t / total) * 100).toFixed(3);
  const keyframes = frames.map((f, i) => `${pct(f.t)}%{transform:translateX(${-i * w}px)}`).join("");

  const body = frames.map((f, i) => {
    const rects: string[] = [];
    const texts = f.lines.map((runs, y) => {
      const baseline = PAD + y * LINE_H + FONT_SIZE;
      let col = 0;
      const spans = runs.map((r) => {
        const x = PAD + col * CHAR_W;
        if (r.bg) rects.push(`<rect x="${x.toFixed(1)}" y="${(PAD + y * LINE_H).toFixed(1)}" width="${(r.text.length * CHAR_W).toFixed(1)}" height="${LINE_H.toFixed(1)}" fill="${r.bg}"/>`);
        col += r.text.length;
        return `<tspan x="${x.toFixed(1)}" fill="${r.fg}"${r.bold ? ' font-weight="bold"' : ""}>${esc(r.text)}</tspan>`;
      }).join("");
      return spans ? `<text y="${baseline.toFixed(1)}">${spans}</text>` : "";
    }).join("");
    return `<g transform="translate(${i * w},0)">${rects.join("")}${texts}</g>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<style>@keyframes play{${keyframes}}.reel{animation:play ${total.toFixed(2)}s steps(1,end) infinite}`
    + `text{font-family:"JetBrains Mono",Menlo,Consolas,monospace;font-size:${FONT_SIZE}px;white-space:pre}</style>`
    + `<rect width="100%" height="100%" rx="6" fill="${BG}"/>`
    + `<g class="reel">${body}</g></svg>`;
}
