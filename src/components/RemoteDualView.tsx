import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import FilePanel, { FilePanelHandle, ActiveDrag } from "./FilePanel";
import { createRemoteProvider } from "../fs/remoteProvider";
import type { FileEntry } from "../fs/types";
import { remoteConnected, useOpenSessions, type OpenSession } from "../fs/sessionRegistry";
import { useConfirm } from "../ui/confirm";

// Two server file browsers side by side. Copying between them goes straight from
// one SSH connection to the other (see `sftp_copy_between_sessions`); nothing is
// written to this computer's disk.

interface Props {
  /** The session whose SFTP tab this is - the default left side, and where progress cards show. */
  hostSessionId: string;
  profile?: string;
  disabled?: boolean;
  onDragMove: (drag: ActiveDrag | null) => void;
  registerPane: (id: string, handle: FilePanelHandle | null) => void;
}

type SideKey = "a" | "b";
const PANE_ID: Record<SideKey, string> = { a: "remoteA", b: "remoteB" };

const joinRemote = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`;

export default function RemoteDualView({ hostSessionId, profile, disabled = false, onDragMove, registerPane }: Props) {
  const confirm = useConfirm();
  const open = useOpenSessions();
  const choices = useMemo(() => remoteConnected(open), [open]);

  const storageKey = `submarine-sftp-dual-${hostSessionId}`;
  const [picked, setPicked] = useState<{ a: string; b: string }>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (v && typeof v.a === "string" && typeof v.b === "string") return v;
    } catch { /* fall through */ }
    return { a: hostSessionId, b: "" };
  });
  const setSide = (side: SideKey, id: string) => {
    const next = { ...picked, [side]: id };
    setPicked(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* ignore */ }
  };

  // Right side defaults to the first other connected session once one exists.
  useEffect(() => {
    if (picked.b || choices.length === 0) return;
    const other = choices.find((c) => c.id !== picked.a);
    if (other) setPicked((p) => ({ ...p, b: other.id }));
  }, [choices, picked.a, picked.b]);

  const byId = (id: string): OpenSession | undefined => choices.find((c) => c.id === id);

  const refs = { a: useRef<FilePanelHandle | null>(null), b: useRef<FilePanelHandle | null>(null) };

  const copyItems = async (from: SideKey, items: FileEntry[], destDir: string) => {
    const to: SideKey = from === "a" ? "b" : "a";
    const srcId = picked[from];
    const dstId = picked[to];
    const dstName = byId(dstId)?.name ?? "server";
    const say = (msg: string, type: "info" | "success" | "error") => refs[from].current?.notify(msg, type);
    let copied = 0;
    for (const e of items) {
      const run = (overwrite: boolean) =>
        invoke("sftp_copy_between_sessions", {
          srcSessionId: srcId,
          srcPath: e.path,
          dstSessionId: dstId,
          dstPath: joinRemote(destDir, e.name),
          isDir: e.isDir,
          overwrite,
          eventSessionId: hostSessionId,
        });
      try {
        await run(false);
        copied++;
      } catch (err) {
        const msg = String(err);
        if (msg.includes("cancelled")) { say("Copy cancelled", "info"); break; }
        if (msg.startsWith("EXISTS:") || msg.includes("EXISTS:")) {
          const replace = await confirm({
            title: "Replace existing item?",
            message: `"${e.name}" already exists in ${dstName}. Replace it?`,
            destructive: true,
          });
          if (!replace) continue;
          try { await run(true); copied++; } catch (err2) { say(`Copy failed for ${e.name}: ${err2}`, "error"); }
        } else {
          say(`Copy failed for ${e.name}: ${msg}`, "error");
        }
      }
    }
    if (copied > 0) {
      say(copied === 1 ? `Copied ${items[0].name} to ${dstName}` : `Copied ${copied} of ${items.length} items to ${dstName}`, "success");
    }
    void refs[to].current?.refresh();
  };

  const providerA = useMemo(() => (picked.a ? createRemoteProvider(picked.a) : null), [picked.a]);
  const providerB = useMemo(() => (picked.b ? createRemoteProvider(picked.b) : null), [picked.b]);

  const side = (key: SideKey, provider: ReturnType<typeof createRemoteProvider> | null) => {
    const other: SideKey = key === "a" ? "b" : "a";
    const id = picked[key];
    const session = byId(id);
    const otherName = byId(picked[other])?.name ?? "other server";
    return (
      <div className="flex-1 min-w-0 min-h-0 flex flex-col border-white/10 first:border-b md:first:border-b-0 md:first:border-r">
        <div className="shrink-0 flex items-center gap-2 px-2 h-8 bg-black/30 border-b border-white/5">
          <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">{key === "a" ? "Left" : "Right"}</span>
          <select
            value={id}
            onChange={(e) => setSide(key, e.target.value)}
            aria-label={`${key === "a" ? "Left" : "Right"} server`}
            className="flex-1 min-w-0 bg-black/50 border border-white/10 rounded px-1.5 py-0.5 text-[11px] text-zinc-200 outline-none focus:border-primary/50"
          >
            <option value="">Choose a server…</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        {provider && session ? (
          <div className="flex-1 min-h-0">
            <FilePanel
              key={id}
              ref={(h) => { refs[key].current = h; registerPane(PANE_ID[key], h); }}
              provider={provider}
              sessionId={id}
              profile={profile}
              disabled={disabled}
              paneId={PANE_ID[key]}
              onDragMove={onDragMove}
              getOppositeDir={() => refs[other].current?.currentDir()}
              peerTransfer={{ label: otherName, send: (items, destDir) => copyItems(key, items, destDir) }}
            />
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center px-6 text-center text-[12px] text-zinc-500">
            {choices.length < 2
              ? "Open a second server connection to copy between servers."
              : "Choose a connected server for this side."}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col md:flex-row">
      {side("a", providerA)}
      {side("b", providerB)}
    </div>
  );
}
