import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { Monitor, KeyRound, X, AlertTriangle, Volume2, VolumeX } from "lucide-react";
import { PcmPlayer } from "../rdp/audio";
import {
  parseEvent, encodeResize, encodeClipboard, encodeMouseMove, encodeMouseButton, encodeWheel, encodeKey, clampPoint, wheelUnits,
  scancodeFor, ctrlAltDelete,
} from "../rdp/wire";

// Remote Desktop inside SubTerm. The protocol runs in a helper process (see
// src-tauri/src/commands/rdp_session.rs); this view paints its screen updates onto a
// canvas and sends keyboard and mouse input back.

interface Props {
  serverId: number;
  serverName: string;
  onClose: () => void;
}

type Phase = "password" | "connecting" | "live" | "ended";

const even = (n: number) => Math.max(0, Math.floor(n)) & ~1;

export default function RdpSessionView({ serverId, serverName, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("password");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  // New or changed server certificate waiting for the user's decision.
  const [cert, setCert] = useState<{ sessionId: string; fingerprint: string; mismatch: boolean } | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<string | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const pressedRef = useRef(new Set<string>());
  const moveRef = useRef<{ x: number; y: number } | null>(null);
  const moveTimerRef = useRef<number | null>(null);
  const errorRef = useRef<string | null>(null);
  // Remote sound, off by switching the speaker button; remembered for every RDP session.
  const [muted, setMuted] = useState(() => localStorage.getItem("subterm-rdp-audio") === "off");
  const playerRef = useRef<PcmPlayer | null>(null);
  // Last text exchanged with the remote clipboard, so the same text is not sent back and forth.
  const lastClipRef = useRef<string | null>(null);

  const send = useCallback((bytes: number[]) => {
    const id = sessionRef.current;
    if (!id || bytes.length === 0) return;
    invoke("rdp_send_input", { sessionId: id, data: bytes }).catch(() => { /* session ended */ });
  }, []);

  const flushMove = useCallback(() => {
    moveTimerRef.current = null;
    const m = moveRef.current;
    moveRef.current = null;
    if (m) send(encodeMouseMove(m.x, m.y));
  }, [send]);

  const handleEvent = useCallback((raw: unknown) => {
    const ev = parseEvent(new Uint8Array(raw as ArrayBuffer));
    switch (ev.kind) {
      case "connected": {
        const canvas = canvasRef.current;
        if (canvas) { canvas.width = ev.width; canvas.height = ev.height; }
        sizeRef.current = { w: ev.width, h: ev.height };
        setPhase("live");
        surfaceRef.current?.focus();
        break;
      }
      case "update": {
        const ctx = canvasRef.current?.getContext("2d");
        if (ctx) ctx.putImageData(new ImageData(ev.pixels, ev.width, ev.height), ev.x, ev.y);
        break;
      }
      case "audio":
        playerRef.current?.push(ev.pcm);
        break;
      case "clipboard":
        lastClipRef.current = ev.text;
        navigator.clipboard?.writeText(ev.text).catch(() => { /* window not focused */ });
        break;
      case "cert":
        setCert({ sessionId: ev.sessionId, fingerprint: ev.fingerprint, mismatch: ev.mismatch });
        break;
      case "error":
        errorRef.current = ev.message;
        setMessage(ev.message);
        break;
      case "closed":
        sessionRef.current = null;
        setCert(null);
        setMessage((m) => errorRef.current ?? m ?? (ev.reason || "The session ended."));
        setPhase("ended");
        break;
      default:
        break;
    }
  }, []);

  const connect = async () => {
    setPhase("connecting");
    setMessage(null);
    errorRef.current = null;
    const body = bodyRef.current;
    const width = Math.max(800, even(body?.clientWidth ?? 1280));
    const height = Math.max(600, even(body?.clientHeight ?? 800));
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = handleEvent;
    playerRef.current?.close();
    playerRef.current = new PcmPlayer(muted);
    try {
      // Muted at connect: the server is not asked for sound at all.
      sessionRef.current = await invoke<string>("rdp_connect", { id: serverId, password, width, height, audio: !muted, onEvent: channel });
      setPassword(""); // not needed again; don't keep it in component state
    } catch (e) {
      setMessage(String(e));
      setPhase("ended");
    }
  };

  const disconnect = useCallback(() => {
    const id = sessionRef.current;
    sessionRef.current = null;
    if (id) invoke("rdp_disconnect", { sessionId: id }).catch(() => {});
  }, []);

  useEffect(() => () => {
    disconnect();
    playerRef.current?.close();
    if (moveTimerRef.current !== null) window.clearTimeout(moveTimerRef.current);
  }, [disconnect]);

  const toggleMuted = () => {
    const next = !muted;
    setMuted(next);
    playerRef.current?.setMuted(next);
    localStorage.setItem("subterm-rdp-audio", next ? "off" : "on");
  };

  // The remote desktop follows the window size (the helper waits until it settles).
  useEffect(() => {
    const body = bodyRef.current;
    if (phase !== "live" || !body || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => send(encodeResize(even(body.clientWidth), even(body.clientHeight))));
    ro.observe(body);
    return () => ro.disconnect();
  }, [phase, send]);

  // Text copied on this computer becomes pasteable remotely: offer it whenever the
  // remote screen gets focus (reading the clipboard needs the window focused).
  const offerLocalClipboard = useCallback(() => {
    navigator.clipboard?.readText().then((text) => {
      if (text && text !== lastClipRef.current) {
        lastClipRef.current = text;
        send(encodeClipboard(text));
      }
    }).catch(() => { /* no permission or nothing to read */ });
  }, [send]);

  // ---- mouse -------------------------------------------------------------

  const toRemote = (e: { clientX: number; clientY: number }): [number, number] => {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) * canvas.width) / Math.max(1, r.width);
    const y = ((e.clientY - r.top) * canvas.height) / Math.max(1, r.height);
    return clampPoint(x, y, canvas.width, canvas.height);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const [x, y] = toRemote(e);
    moveRef.current = { x, y };
    if (moveTimerRef.current === null) moveTimerRef.current = window.setTimeout(flushMove, 16);
  };
  const onMouseButton = (e: React.MouseEvent, pressed: boolean) => {
    e.preventDefault();
    if (pressed) surfaceRef.current?.focus();
    const [x, y] = toRemote(e);
    moveRef.current = null; // the button event carries the latest position
    send([...encodeMouseMove(x, y), ...encodeMouseButton(e.button, pressed)]);
  };

  // React attaches wheel listeners as passive, so preventDefault has to go on a native one.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const out: number[] = [];
      const v = wheelUnits(e.deltaY, e.deltaMode);
      const h = -wheelUnits(e.deltaX, e.deltaMode); // positive = scroll right
      if (v) out.push(...encodeWheel(true, v));
      if (h) out.push(...encodeWheel(false, h));
      send(out);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [phase, send]);

  // ---- keyboard ----------------------------------------------------------

  const onKey = (e: React.KeyboardEvent, pressed: boolean) => {
    if (phase !== "live") return;
    const key = scancodeFor(e.code);
    if (!key) return;
    e.preventDefault();
    e.stopPropagation();
    if (pressed) pressedRef.current.add(e.code); else pressedRef.current.delete(e.code);
    send(encodeKey(key[0], key[1], pressed));
  };

  // Don't leave modifiers stuck on the remote side when focus moves away.
  const releaseAll = () => {
    const out: number[] = [];
    pressedRef.current.forEach((code) => {
      const key = scancodeFor(code);
      if (key) out.push(...encodeKey(key[0], key[1], false));
    });
    pressedRef.current.clear();
    send(out);
  };

  const answerCert = (trust: boolean) => {
    const c = cert;
    setCert(null);
    if (!c) return;
    invoke("rdp_answer_certificate", { sessionId: c.sessionId, trust }).catch((e) => {
      errorRef.current = String(e);
      setMessage(String(e));
    });
  };

  const close = () => { disconnect(); onClose(); };

  return (
    <div className="fixed inset-0 z-[90] flex flex-col bg-[#0a0a0c]" role="dialog" aria-label={`Remote Desktop: ${serverName}`}>
      <div className="h-9 shrink-0 flex items-center gap-3 px-3 border-b border-white/10 bg-[#111114] text-[12px] text-zinc-200">
        <Monitor size={14} className="text-primary" />
        <span className="font-semibold truncate">{serverName}</span>
        <span className={`w-1.5 h-1.5 rounded-full ${phase === "live" ? "bg-emerald-400" : phase === "connecting" ? "bg-amber-400 animate-pulse" : "bg-zinc-500"}`} />
        <span className="text-zinc-500">{phase === "live" ? "Connected" : phase === "connecting" ? "Connecting…" : phase === "ended" ? "Disconnected" : "Sign in"}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={toggleMuted}
          aria-pressed={!muted}
          title={muted ? "Remote sound is off (applies from the next connection if it was off when connecting)" : "Mute remote sound"}
          className="px-2 py-1 rounded bg-white/5 hover:bg-white/10 flex items-center gap-1.5"
        >
          {muted ? <VolumeX size={12} /> : <Volume2 size={12} />} {muted ? "Sound off" : "Sound on"}
        </button>
        {phase === "live" && (
          <button
            type="button"
            onClick={() => { send(ctrlAltDelete()); surfaceRef.current?.focus(); }}
            title="Send Ctrl+Alt+Delete to the remote computer"
            className="px-2 py-1 rounded bg-white/5 hover:bg-white/10 flex items-center gap-1.5"
          >
            <KeyRound size={12} /> Ctrl+Alt+Del
          </button>
        )}
        <button type="button" onClick={close} className="px-2 py-1 rounded bg-white/5 hover:bg-rose-500/20 hover:text-rose-300 flex items-center gap-1.5">
          <X size={12} /> {phase === "live" ? "Disconnect" : "Close"}
        </button>
      </div>

      <div ref={bodyRef} className="flex-1 min-h-0 relative flex items-center justify-center overflow-hidden">
        {phase === "password" && (
          <form
            className="w-80 space-y-3 p-5 rounded-xl bg-[#15151a] border border-white/10"
            onSubmit={(e) => { e.preventDefault(); void connect(); }}
          >
            <div className="text-sm font-semibold text-white">Sign in to {serverName}</div>
            <p className="text-[11px] text-zinc-500">The password is sent only to the server for this connection and is not saved.</p>
            <input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              aria-label="Password"
              className="w-full h-9 bg-[#1a1a1e] rounded-lg px-3 text-[12px] text-white border border-white/10 outline-none focus:border-primary/50"
            />
            <button type="submit" className="w-full h-9 rounded-lg bg-primary text-black text-[12px] font-bold">Connect</button>
          </form>
        )}

        {phase === "connecting" && !cert && <div className="text-zinc-400 text-sm">Connecting to {serverName}…</div>}

        {phase === "connecting" && cert && (
          <div role="alertdialog" aria-label="Server certificate" className="w-[26rem] max-w-full space-y-3 p-5 rounded-xl bg-[#15151a] border border-white/10">
            <div className={`flex items-center gap-2 text-sm font-semibold ${cert.mismatch ? "text-rose-300" : "text-white"}`}>
              <AlertTriangle size={16} className={cert.mismatch ? "text-rose-400" : "text-amber-400"} />
              {cert.mismatch ? "The server's certificate has changed" : `First connection to ${serverName}`}
            </div>
            <p className="text-[11px] text-zinc-400">
              {cert.mismatch
                ? "This is not the certificate you trusted before. If the server was not reinstalled or given a new certificate, someone may be intercepting the connection: do not continue."
                : "Check that this fingerprint matches the server's certificate before you send your password. It is saved for future connections."}
            </p>
            <code className="block p-2 rounded bg-black/40 border border-white/10 text-[11px] text-zinc-200 break-all">{cert.fingerprint}</code>
            <div className="flex justify-end gap-2">
              <button type="button" autoFocus onClick={() => answerCert(false)} className="px-3 py-1.5 rounded-lg bg-white/5 text-zinc-200 text-[12px]">Cancel</button>
              <button
                type="button"
                onClick={() => answerCert(true)}
                className={`px-3 py-1.5 rounded-lg text-[12px] font-bold ${cert.mismatch ? "bg-rose-500/20 text-rose-200 border border-rose-500/40" : "bg-primary text-black"}`}
              >
                {cert.mismatch ? "Trust the new certificate" : "Trust and connect"}
              </button>
            </div>
          </div>
        )}

        {phase === "ended" && (
          <div className="max-w-md text-center space-y-3 p-5">
            <AlertTriangle size={22} className="mx-auto text-amber-400" />
            <div className="text-sm text-zinc-200 break-words">{message ?? "The session ended."}</div>
            <div className="flex justify-center gap-2">
              <button type="button" onClick={() => { setPhase("password"); setMessage(null); }} className="px-3 py-1.5 rounded-lg bg-primary text-black text-[12px] font-bold">Try again</button>
              <button type="button" onClick={close} className="px-3 py-1.5 rounded-lg bg-white/5 text-zinc-200 text-[12px]">Close</button>
            </div>
          </div>
        )}

        <div
          ref={surfaceRef}
          tabIndex={0}
          onKeyDown={(e) => onKey(e, true)}
          onKeyUp={(e) => onKey(e, false)}
          onBlur={releaseAll}
          onFocus={offerLocalClipboard}
          className={`outline-none ${phase === "live" ? "" : "hidden"}`}
          style={{ maxWidth: "100%", maxHeight: "100%" }}
        >
          <canvas
            ref={canvasRef}
            onMouseMove={onMouseMove}
            onMouseDown={(e) => onMouseButton(e, true)}
            onMouseUp={(e) => onMouseButton(e, false)}
            onContextMenu={(e) => e.preventDefault()}
            style={{ display: "block", maxWidth: "100%", maxHeight: "100%", cursor: "default" }}
          />
        </div>
      </div>
    </div>
  );
}
