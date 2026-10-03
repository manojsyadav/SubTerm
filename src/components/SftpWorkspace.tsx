import { useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { File as FileIcon, Folder, FolderUp, Rows, LayoutPanelTop } from "lucide-react";
import FilePanel, { ActiveDrag, FilePanelHandle } from "./FilePanel";
import MirrorsPanel from "./MirrorsPanel";
import TransfersBar, { Transfer } from "./TransfersBar";
import { onRovingKeyDown } from "../ui/rovingKeys";
import { createLocalProvider } from "../fs/localProvider";
import { createRemoteProvider } from "../fs/remoteProvider";
import { transferFile } from "../fs/transfer";
import { useOverwritePrompt } from "../ui/confirm";
import { dropQueued, useQueuedTransfers } from "../fs/transferQueue";

// Speed is measured over this trailing window of progress samples, so one
// slow or fast chunk does not make the number jump.
const SPEED_WINDOW_MS = 3000;
const SPEED_MIN_SPAN_MS = 500;

// Dual-pane SFTP workspace. Owns the two FilePanels, the cross-pane drag
// state, and the global mouseup that turns a release over the opposite pane
// into a `transferFile` call. The panels themselves stay agnostic — they only
// know how to drive their own provider.

interface SftpWorkspaceProps {
  sessionId: string;
  disabled?: boolean;
  // Mirror config from the parent session — both pieces are needed by the
  // (now-nested) MirrorsPanel sub-tab. Passing them through here lets us
  // collapse the previously-separate Mirror toolbar entry into one SFTP
  // umbrella ("Files" vs "Mirror" sub-tabs), so the session toolbar has
  // one fewer item to fit on phones.
  serverId?: number;
  mirrorsConfig?: any[];
  /** Focused PTY. Passed through while SFTP hides the terminal on a narrow window. */
  terminalId?: string;
  /** Compact layout: close the SFTP pane so the terminal that just received `cd` is visible. */
  onRevealTerminal?: () => void;
  /** Unlocked profile. Server ids restart in every profile's DB, so per-server storage keys need it. */
  profile?: string;
}

// Profile names hold only [A-Za-z0-9_-], so ":" keeps the parts apart.
export const bookmarksKeyPrefix = (profile = "default") => `submarine-sftp-bookmarks:${profile}:`;

type SftpView = "files" | "mirror";
type FilesLayout = "tabs" | "split";
type FilesSide = "local" | "remote";

// Cursor-following drag ghost, isolated into its own component so that the
// per-mousemove position updates re-render ONLY this tiny node — not the whole
// SftpWorkspace and, through it, both (un-memoized) FilePanels with their full
// row lists. The parent drives it imperatively via the ref instead of holding
// the position in its own state.
export interface DragGhostHandle {
  show: (drag: ActiveDrag) => void;
  hide: () => void;
}

const DragGhost = forwardRef<DragGhostHandle>((_props, ref) => {
  const [drag, setDrag] = useState<ActiveDrag | null>(null);
  useImperativeHandle(ref, () => ({
    show: (d) => setDrag(d),
    hide: () => setDrag(null),
  }), []);
  if (!drag) return null;
  // Rendered through a portal so any ancestor's `transform` / `backdrop-filter`
  // doesn't re-anchor the `position: fixed` element to a containing block.
  return createPortal(
    <div
      style={{
        position: "fixed",
        top: drag.y + 8,
        left: drag.x + 12,
        pointerEvents: "none",
        zIndex: 10000,
      }}
      className="bg-[#0c0c0e]/95 border border-indigo-500/40 rounded-lg px-3 py-1.5 text-[11px] font-mono text-zinc-100 shadow-2xl backdrop-blur-md flex items-center gap-2"
    >
      <FileIcon size={12} className="text-indigo-300 shrink-0" />
      <span className="truncate max-w-[260px]">{drag.entry.name}</span>
      {drag.items.length > 1 && <span className="shrink-0 text-indigo-300">+{drag.items.length - 1}</span>}
    </div>,
    document.body
  );
});
DragGhost.displayName = "DragGhost";

const SftpWorkspace = ({ sessionId, disabled = false, serverId = 0, mirrorsConfig = [], terminalId, onRevealTerminal, profile }: SftpWorkspaceProps) => {
  // Active sub-tab. Files is the default (the common workflow); Mirror is
  // for the per-server one-way replication setup.
  const [view, setView] = useState<SftpView>("files");
  // Files layout: "tabs" (one side full height) is the default because the
  // side panel is narrow on most desktop setups and "split" squeezed each
  // FilePanel into 5-6 rows. "split" stays available for users who want
  // simultaneous Local+Remote visibility (drag-drop still works there).
  // Persisted globally (not per-session) — pure layout preference.
  const [layout, setLayout] = useState<FilesLayout>(() => {
    try {
      const v = localStorage.getItem("submarine-sftp-layout");
      return v === "split" ? "split" : "tabs";
    } catch { return "tabs"; }
  });
  const setLayoutPersisted = (l: FilesLayout) => {
    setLayout(l);
    try { localStorage.setItem("submarine-sftp-layout", l); } catch { /* quota — ignore */ }
  };
  // Active side in tabs mode. We persist it per (session) so the user
  // returns to the side they were last using, not always Local.
  const sideStorageKey = `submarine-sftp-side-${sessionId}`;
  const [activeSide, setActiveSide] = useState<FilesSide>(() => {
    try {
      const v = localStorage.getItem(sideStorageKey);
      return v === "remote" ? "remote" : "local";
    } catch { return "local"; }
  });
  const setActiveSidePersisted = (s: FilesSide) => {
    setActiveSide(s);
    try { localStorage.setItem(sideStorageKey, s); } catch { /* ignore */ }
  };
  // Providers are created once per session so the panels' provider identity
  // is stable across renders (the FilePanel's load-on-mount effect keys off it).
  const localProvider = useMemo(() => createLocalProvider(), []);
  const remoteProvider = useMemo(() => createRemoteProvider(sessionId), [sessionId]);

  const localRef = useRef<FilePanelHandle | null>(null);
  const remoteRef = useRef<FilePanelHandle | null>(null);

  // Persist the last directory each panel was in per (session, side) so the
  // user lands on the same path next time they open this server. If the
  // saved path no longer exists, FilePanel falls back to provider.homePath().
  const storageKey = `submarine-server-dirs-${sessionId}`;
  const savedDirsRef = useRef<{ local?: string; remote?: string }>(
    (() => {
      try {
        const raw = localStorage.getItem(storageKey);
        return raw ? JSON.parse(raw) : {};
      } catch { return {}; }
    })()
  );
  const saveDir = (side: "local" | "remote", path: string) => {
    savedDirsRef.current[side] = path;
    try { localStorage.setItem(storageKey, JSON.stringify(savedDirsRef.current)); }
    catch { /* quota or private-mode storage — ignore */ }
  };

  // Source of truth for the active drag. Updated SYNCHRONOUSLY from the
  // panel's onMove via the ref so the window mouseup handler (which runs in
  // the same tick as the panel's own mouseup that clears it) can still see
  // the source pane and entry. Going through React state introduces a race
  // because `setDrag → render → useEffect` doesn't always settle before the
  // mouseup propagates.
  const dragRef = useRef<ActiveDrag | null>(null);
  // The ghost owns its own position state; we poke it imperatively so a
  // mousemove never re-renders this workspace (and its FilePanels).
  const ghostRef = useRef<DragGhostHandle>(null);
  const [notification, setNotification] = useState<{ msg: string; type: "info" | "success" | "error" } | null>(null);

  const notify = (msg: string, type: "info" | "success" | "error" = "info") => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 4000);
  };

  const dropHoverElRef = useRef<Element | null>(null);
  const markDropHover = (el: Element | null) => {
    if (dropHoverElRef.current === el) return;
    dropHoverElRef.current?.removeAttribute("data-fs-drop-hover");
    el?.setAttribute("data-fs-drop-hover", "");
    dropHoverElRef.current = el;
  };

  const handleDragMove = (drag: ActiveDrag | null) => {
    dragRef.current = drag;
    if (!drag) {
      ghostRef.current?.hide();
      markDropHover(null);
      return;
    }
    ghostRef.current?.show(drag);
    const hit = document.elementFromPoint(drag.x, drag.y);
    const pane = hit?.closest("[data-fs-pane]") ?? null;
    const overOtherPane = !!pane && pane.getAttribute("data-fs-pane") !== drag.paneId;
    markDropHover(overOtherPane ? hit!.closest("[data-fs-drop-path]") ?? pane : null);
  };

  // Live transfer progress, keyed by the backend-assigned id. The Rust
  // commands stream events at ~10Hz; we replace the entry on each update so
  // a single growing progress bar shows per transfer. Speed comes from the
  // (time, bytes) samples of the last few seconds.
  const [transfers, setTransfers] = useState<Record<string, Transfer>>({});
  const speedSamplesRef = useRef(new Map<string, { t: number; bytes: number }[]>());
  const [transfersCollapsed, setTransfersCollapsed] = useState(false);
  const queued = useQueuedTransfers(sessionId);

  // Bytes/second over the samples of the last SPEED_WINDOW_MS. Every sample
  // older than the window is dropped, even if only the new one is left, so a
  // pause (a long folder walk before the first byte) never counts as
  // transfer time. Undefined until the window spans SPEED_MIN_SPAN_MS.
  const measureSpeed = (id: string, bytes: number): number | undefined => {
    const now = performance.now();
    const samples = speedSamplesRef.current.get(id) ?? [];
    samples.push({ t: now, bytes });
    while (now - samples[0].t > SPEED_WINDOW_MS) samples.shift();
    speedSamplesRef.current.set(id, samples);
    const span = now - samples[0].t;
    return span >= SPEED_MIN_SPAN_MS ? ((bytes - samples[0].bytes) * 1000) / span : undefined;
  };

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    listen<Transfer>(`sftp-transfer-${sessionId}`, (event) => {
      const t = event.payload;
      if (!t || !t.id) return;
      const measured = t.status === "progress" ? measureSpeed(t.id, t.bytes) : undefined;
      if (t.status !== "progress") speedSamplesRef.current.delete(t.id);
      setTransfers((prev) => {
        // Until the window spans SPEED_MIN_SPAN_MS again (e.g. right after
        // a folder walk), keep the last measured speed rather than blank it.
        const speed = t.status === "progress" ? measured ?? prev[t.id]?.speed : undefined;
        return { ...prev, [t.id]: { ...t, speed } };
      });
      if (t.status === "done" || t.status === "error" || t.status === "cancelled") {
        // Leave the final state visible briefly before clearing the card so
        // the user sees the success tick / failure colour / cancel notice.
        const linger = t.status === "error" ? 6000 : t.status === "cancelled" ? 3000 : 1800;
        setTimeout(() => {
          setTransfers((prev) => {
            const { [t.id]: _, ...rest } = prev;
            return rest;
          });
        }, linger);
      }
    }).then((fn) => {
      if (!alive) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      alive = false;
      if (unlisten) unlisten();
    };
  }, [sessionId]);

  const cancelTransfer = (id: string) => {
    // Fire-and-forget: the backend emits its own "cancelled" event when the
    // loop notices the flag, which is what wipes the card.
    invoke("sftp_cancel_transfer", { transferId: id }).catch(() => {});
  };

  // Transfers bar. Batch items carry the transfer id they are run with, so
  // a "starting" item is hidden exactly when events for that id exist (its
  // live row takes over), including between "done" and the invoke settling.
  const transferList = Object.values(transfers);
  const visibleQueued = queued.filter((q) => !(q.id in transfers));
  // Removing an item from the queue makes the batch skip it; one that is
  // already starting may have reached the backend, so cancel that id too.
  const cancelQueued = (id: string) => {
    const wasStarting = queued.some((q) => q.id === id && q.state === "starting");
    dropQueued(sessionId, [id]);
    if (wasStarting) cancelTransfer(id);
  };

  const transfersBar = transferList.length + visibleQueued.length > 0 ? (
    <TransfersBar
      transfers={transferList}
      queued={visibleQueued}
      collapsed={transfersCollapsed}
      onToggleCollapsed={() => setTransfersCollapsed((c) => !c)}
      onCancel={cancelTransfer}
      onCancelQueued={cancelQueued}
    />
  ) : null;

  const overwritePrompt = useOverwritePrompt();

  // Cross-pane drop dispatch: when the user releases the mouse anywhere, look
  // up which pane is under the cursor; if it differs from the source pane,
  // run the transfer and refresh both panels.
  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      const active = dragRef.current;
      if (!active) return;
      // Clear immediately so a second mouseup (e.g. the FilePanel's own
      // listener clearing the ghost) doesn't re-enter this branch.
      dragRef.current = null;
      markDropHover(null);

      const hit = document.elementFromPoint(e.clientX, e.clientY);
      if (!hit) return;
      const pane = (hit as HTMLElement).closest("[data-fs-pane]") as HTMLElement | null;
      if (!pane) return;
      const targetPaneId = pane.getAttribute("data-fs-pane");
      if (!targetPaneId || targetPaneId === active.paneId) return;

      const dropEl = (hit as HTMLElement).closest("[data-fs-drop-path]");
      const targetDir = dropEl?.getAttribute("data-fs-drop-path")
        || pane.getAttribute("data-fs-current-path") || "";
      if (!targetDir) return;

      const sourceRef = active.paneId === "local" ? localRef : remoteRef;
      const run = sourceRef.current?.sendItems(active.items, targetDir) ?? Promise.resolve();
      run
        .catch((err) => {
          notify(`Transfer failed: ${err}`, "error");
          console.error("Cross-pane transfer failed:", err);
        })
        .finally(() => {
          localRef.current?.refresh();
          remoteRef.current?.refresh();
        });
    };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, []);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#0a0a0c] relative">
      {/* Sub-tab strip — Files vs Mirror, replacing the standalone Mirror
          toolbar button that used to live next to SFTP / Ports / Library. The
          Mirror panel keeps state across tab switches via CSS hidden (same
          mounted-but-invisible pattern the parent SessionView used before)
          so the live worker's counters and rolling log survive a switch back
          to Files. */}
      <div role="tablist" aria-label="SFTP views" onKeyDown={(e) => onRovingKeyDown(e)} className="shrink-0 grid grid-cols-2 border-b border-white/5 bg-black/20">
        <button
          role="tab"
          aria-selected={view === "files"}
          tabIndex={view === "files" ? 0 : -1}
          onClick={() => setView("files")}
          className={`h-9 flex items-center justify-center gap-1.5 text-[11px] font-bold uppercase tracking-wider transition-all ${
            view === "files"
              ? "text-primary bg-primary/5 border-b border-primary"
              : "text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.03] border-b border-transparent"
          }`}
        >
          <Folder size={12} /> Files
        </button>
        <button
          role="tab"
          aria-selected={view === "mirror"}
          tabIndex={view === "mirror" ? 0 : -1}
          onClick={() => setView("mirror")}
          disabled={!serverId}
          title={!serverId ? "Mirror needs a saved server" : undefined}
          className={`h-9 flex items-center justify-center gap-1.5 text-[11px] font-bold uppercase tracking-wider transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
            view === "mirror"
              ? "text-primary bg-primary/5 border-b border-primary"
              : "text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.03] border-b border-transparent"
          }`}
        >
          <FolderUp size={12} /> Mirror
        </button>
      </div>

      {/* Files view — dual-pane browser. Stays mounted when Mirror is on top
          so directory state and selection don't reset across tab toggles.
          Both FilePanels are ALWAYS mounted (one is just CSS-hidden in
          tabs mode) so cd state, scroll position, and selection survive a
          tab toggle. */}
      <div className={`${view === "files" ? "flex-1 flex flex-col min-h-0" : "hidden"}`}>
        {/* Layout toolbar: Local|Remote pills in tabs mode (or a static
            label in split mode), plus the global layout toggle on the
            right. The toggle's label is the DESTINATION mode so the
            user can predict what clicking will do. */}
        <div className="shrink-0 h-10 sm:h-8 flex items-stretch border-b border-white/5 bg-black/20">
          {layout === "tabs" ? (
            <div role="tablist" aria-label="Active panel" onKeyDown={(e) => onRovingKeyDown(e)} className="flex-1 grid grid-cols-2">
              <button
                role="tab"
                aria-selected={activeSide === "local"}
                tabIndex={activeSide === "local" ? 0 : -1}
                onClick={() => setActiveSidePersisted("local")}
                className={`h-full flex items-center justify-center gap-1.5 text-[10px] font-bold uppercase tracking-wider transition-all ${
                  activeSide === "local"
                    ? "text-emerald-300 bg-emerald-500/5 border-b border-emerald-400"
                    : "text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.03] border-b border-transparent"
                }`}
              >
                <Folder size={11} /> Local
              </button>
              <button
                role="tab"
                aria-selected={activeSide === "remote"}
                tabIndex={activeSide === "remote" ? 0 : -1}
                onClick={() => setActiveSidePersisted("remote")}
                className={`h-full flex items-center justify-center gap-1.5 text-[10px] font-bold uppercase tracking-wider transition-all ${
                  activeSide === "remote"
                    ? "text-sky-300 bg-sky-500/5 border-b border-sky-400"
                    : "text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.03] border-b border-transparent"
                }`}
              >
                <Folder size={11} /> Remote
              </button>
            </div>
          ) : (
            <div className="flex-1 flex items-center px-3 text-[9.5px] font-bold uppercase tracking-widest text-zinc-500">
              Local + Remote
            </div>
          )}
          <button
            onClick={() => setLayoutPersisted(layout === "tabs" ? "split" : "tabs")}
            title={layout === "tabs" ? "Show both panels stacked (drag-drop between them)" : "Switch to tabbed view (one panel at full height)"}
            className="px-3 border-l border-white/5 text-[10px] font-bold uppercase tracking-wider text-zinc-400 hover:bg-white/5 hover:text-white flex items-center gap-1.5 transition-all shrink-0"
          >
            {layout === "tabs"
              ? <><Rows size={11} /> Split</>
              : <><LayoutPanelTop size={11} /> Tabs</>
            }
          </button>
        </div>

        {/* Local panel — visible in split mode (top), or in tabs mode when
            Local is the active side. Hidden via CSS (not unmounted) when
            on the inactive tab so its directory and provider state
            survive a side-swap. */}
        <div className={
          layout === "split"
            ? "flex-1 min-h-0 border-b border-white/10"
            : activeSide === "local" ? "flex-1 min-h-0" : "hidden"
        }>
          <FilePanel
            ref={localRef}
            provider={localProvider}
            // The local pane also needs sessionId so its bulk-upload button can
            // invoke sftp_upload_file / sftp_upload_dir on the right session.
            // Without this the Upload button silently no-ops on the first
            // guard (`if (!sessionId) return`).
            sessionId={sessionId}
            serverId={serverId}
            profile={profile}
            disabled={disabled}
            onDragMove={handleDragMove}
            initialPath={savedDirsRef.current.local}
            onPathChange={(p) => saveDir("local", p)}
            getOppositeDir={() => remoteRef.current?.currentDir()}
          />
        </div>
        <div className={
          layout === "split"
            ? "flex-1 min-h-0"
            : activeSide === "remote" ? "flex-1 min-h-0" : "hidden"
        }>
          <FilePanel
            ref={remoteRef}
            provider={remoteProvider}
            sessionId={sessionId}
            serverId={serverId}
            profile={profile}
            disabled={disabled}
            onDragMove={handleDragMove}
            initialPath={savedDirsRef.current.remote}
            onPathChange={(p) => saveDir("remote", p)}
            getOppositeDir={() => localRef.current?.currentDir()}
            terminalId={terminalId}
            onRevealTerminal={onRevealTerminal}
          />
        </div>
      </div>

      {/* Mirror view — kept MOUNTED (CSS hidden) so the live worker's logs
          and progress counters survive when the user pops back to Files. */}
      {!!serverId && (
        <div className={`${view === "mirror" ? "flex-1 flex flex-col min-h-0" : "hidden"}`}>
          <MirrorsPanel
            sessionId={sessionId}
            serverId={serverId}
            configuredMirrors={mirrorsConfig}
            disabled={disabled}
          />
        </div>
      )}

      {notification && (
        <div className={`absolute bottom-3 left-1/2 -translate-x-1/2 z-50 px-3 py-1.5 rounded-lg border text-[11px] font-mono shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-bottom-4 duration-300 ${
          notification.type === "success" ? "bg-emerald-950/90 border-emerald-500/30 text-emerald-400" :
          notification.type === "error"   ? "bg-rose-950/90 border-rose-500/30 text-rose-400" :
                                            "bg-indigo-950/90 border-indigo-500/30 text-indigo-400"
        }`}>{notification.msg}</div>
      )}

      {/* Transfers bar — docked on the workspace root, under both the Files
          and the Mirror view, so a long transfer or an editor save stays
          visible (and cancellable) whichever tab is open. */}
      {transfersBar}


      {/* Cursor-following drag ghost. Self-contained so its per-mousemove
          position updates don't re-render this workspace or the FilePanels. */}
      <DragGhost ref={ghostRef} />
    </div>
  );
};

export default SftpWorkspace;
