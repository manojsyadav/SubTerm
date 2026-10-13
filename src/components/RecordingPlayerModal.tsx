import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import { X, Play, Pause, RotateCcw, FolderOpen, FastForward, Film, Image as ImageIcon } from "lucide-react";
import { parseCast, type ParsedCast } from "../terminal/recorder";
import { compressIdle, countPlayed, parseResize, formatClock } from "../terminal/playback";
import { captureFrames, framesToSvg } from "../terminal/svgExport";
import { saveTextFile, saveBinaryFile } from "../terminal/saveFile";
import { framesToGif, GIF_MAX_FRAMES } from "../terminal/gifExport";

const SPEEDS = [0.5, 1, 2, 4, 8];
const IDLE_CAP_SECONDS = 1.5;

interface Props {
  onClose: () => void;
}

export function RecordingPlayerModal({ onClose }: Props) {
  const [cast, setCast] = useState<ParsedCast | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"svg" | "gif" | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [skipIdle, setSkipIdle] = useState(true);
  const [position, setPosition] = useState(0);

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const posRef = useRef(0);
  const idxRef = useRef(0);
  const speedRef = useRef(1);
  speedRef.current = speed;

  const events = useMemo(() => {
    if (!cast) return [];
    return skipIdle ? compressIdle(cast.events, IDLE_CAP_SECONDS) : cast.events;
  }, [cast, skipIdle]);
  const duration = events.length ? events[events.length - 1][0] : 0;

  const apply = useCallback((code: string, data: string) => {
    const term = termRef.current;
    if (!term) return;
    if (code === "o") term.write(data);
    else if (code === "r") {
      const size = parseResize(data);
      if (size) term.resize(size.cols, size.rows);
    }
  }, []);

  /** Rebuild the screen at time `t` by replaying everything before it. */
  const seek = useCallback((t: number) => {
    const term = termRef.current;
    if (!term || !cast) return;
    term.reset();
    term.resize(cast.header.width, cast.header.height);
    const n = countPlayed(events, t);
    let out = "";
    for (let i = 0; i < n; i++) {
      const [, code, data] = events[i];
      if (code === "o") out += data;
      else if (code === "r") {
        if (out) { term.write(out); out = ""; }
        apply("r", data);
      }
    }
    if (out) term.write(out);
    idxRef.current = n;
    posRef.current = t;
    setPosition(t);
  }, [cast, events, apply]);

  // Create the terminal once a recording is loaded.
  useEffect(() => {
    if (!cast || !hostRef.current) return;
    const term = new Terminal({
      cols: cast.header.width,
      rows: cast.header.height,
      disableStdin: true,
      cursorBlink: false,
      scrollback: 5000,
      fontFamily: "JetBrains Mono, Menlo, Consolas, monospace",
      fontSize: 13,
      theme: { background: "#0b0b0f" },
    });
    term.open(hostRef.current);
    termRef.current = term;
    return () => {
      term.dispose();
      termRef.current = null;
    };
  }, [cast]);

  // Restart from the top whenever the event list changes (new file or idle toggle).
  useEffect(() => {
    if (!cast) return;
    setPlaying(false);
    seek(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  // Playback clock.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = ((now - last) / 1000) * speedRef.current;
      last = now;
      const pos = Math.min(posRef.current + dt, duration);
      while (idxRef.current < events.length && events[idxRef.current][0] <= pos) {
        const [, code, data] = events[idxRef.current];
        apply(code, data);
        idxRef.current++;
      }
      posRef.current = pos;
      setPosition(pos);
      if (pos >= duration) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, events, duration, apply]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const loadFile = async (file: File) => {
    try {
      const parsed = parseCast(await file.text());
      setError(null);
      setFileName(file.name);
      setCast(parsed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const exportAnimation = async (kind: "svg" | "gif") => {
    if (!cast) return;
    setExporting(kind);
    try {
      const base = (fileName || "recording").replace(/\.[^.]+$/, "");
      if (kind === "svg") {
        const frames = await captureFrames(cast.header, events);
        await saveTextFile(framesToSvg(frames, cast.header.width, cast.header.height), `${base}.svg`, "svg");
      } else {
        const frames = await captureFrames(cast.header, events, GIF_MAX_FRAMES);
        await saveBinaryFile(framesToGif(frames, cast.header.width, cast.header.height), `${base}.gif`, "gif");
      }
    } catch (e) {
      setError(`${kind.toUpperCase()} export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(null);
    }
  };

  const togglePlay = () => {
    if (!cast) return;
    if (!playing && posRef.current >= duration) seek(0);
    setPlaying((p) => !p);
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onMouseDown={onClose}>
      <div
        className="flex flex-col max-w-[95vw] max-h-[92vh] bg-[#121217] border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 px-4 py-2.5 border-b border-white/10">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-white">Session playback</div>
            <div className="text-[11px] text-zinc-500 truncate">
              {cast ? `${cast.header.title ? cast.header.title + " · " : ""}${fileName} · ${cast.header.width}x${cast.header.height}` : "Open an asciinema .cast file"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {cast && (
              <>
                <button
                  type="button"
                  disabled={exporting !== null}
                  onClick={() => { void exportAnimation("svg"); }}
                  title="Save as an animated SVG (plays in browsers and on GitHub). Uses the Skip idle setting."
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-zinc-200 bg-white/5 hover:bg-white/10 disabled:opacity-50"
                >
                  <Film size={13} /> {exporting === "svg" ? "Exporting…" : "Export SVG"}
                </button>
                <button
                  type="button"
                  disabled={exporting !== null}
                  onClick={() => { void exportAnimation("gif"); }}
                  title="Save as an animated GIF (for chat, tickets and slides). Larger than SVG; uses the Skip idle setting."
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-zinc-200 bg-white/5 hover:bg-white/10 disabled:opacity-50"
                >
                  <ImageIcon size={13} /> {exporting === "gif" ? "Exporting…" : "Export GIF"}
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-zinc-200 bg-white/5 hover:bg-white/10"
            >
              <FolderOpen size={13} /> Open file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".cast,.json,text/plain"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void loadFile(f);
                e.target.value = "";
              }}
            />
            <button type="button" onClick={onClose} title="Close (Esc)" className="p-1 text-zinc-400 hover:text-white hover:bg-white/10 rounded">
              <X size={15} />
            </button>
          </div>
        </div>

        {error && <div className="px-4 py-2 text-xs text-red-300 bg-red-500/10 border-b border-red-500/20">{error}</div>}

        {cast ? (
          <>
            <div className="overflow-auto p-3 bg-[#0b0b0f]">
              <div ref={hostRef} />
            </div>
            <div className="flex items-center gap-3 px-4 py-2.5 border-t border-white/10 text-xs text-zinc-300">
              <button type="button" onClick={togglePlay} title={playing ? "Pause" : "Play"} className="p-1.5 rounded-lg bg-primary/20 text-primary hover:bg-primary/30">
                {playing ? <Pause size={14} /> : <Play size={14} />}
              </button>
              <button type="button" onClick={() => { setPlaying(false); seek(0); }} title="Restart" className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10">
                <RotateCcw size={14} />
              </button>
              <span className="font-mono tabular-nums w-24 shrink-0">{formatClock(position)} / {formatClock(duration)}</span>
              <input
                type="range"
                min={0}
                max={Math.max(duration, 0.001)}
                step={0.05}
                value={Math.min(position, duration)}
                onChange={(e) => seek(Number(e.target.value))}
                className="flex-1 accent-primary"
                aria-label="Seek"
              />
              <div className="flex items-center gap-1">
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSpeed(s)}
                    className={`px-1.5 py-0.5 rounded font-mono ${speed === s ? "bg-primary/25 text-primary" : "text-zinc-400 hover:bg-white/10"}`}
                  >
                    {s}x
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1.5 cursor-pointer select-none" title={`Cap idle gaps at ${IDLE_CAP_SECONDS}s`}>
                <input type="checkbox" checked={skipIdle} onChange={(e) => setSkipIdle(e.target.checked)} className="accent-primary" />
                <FastForward size={12} /> Skip idle
              </label>
            </div>
          </>
        ) : (
          <div className="px-10 py-12 text-center text-sm text-zinc-400">
            Choose a <span className="font-mono">.cast</span> file recorded from a terminal's right-click menu, or any asciinema v2 recording.
          </div>
        )}
      </div>
    </div>
  );
}
