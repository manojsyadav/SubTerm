import { Search, Plus, Server, Globe, Folder, ChevronLeft, Trash2, Edit2, Zap, Check, X, Copy, GripVertical, Box, Layers, TerminalSquare, ShieldAlert, Download, Activity } from "lucide-react";
import { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useConfirm } from "../ui/confirm";
import { useViewportWidth } from "../hooks/useViewport";
import { renderServerIcon } from "./ServerIcon";
import DistroLogo from "./DistroLogo";
import type { Server as ServerRecord, Folder as FolderRecord } from "../types";
import type { Session } from "../hooks/useSessionManager";

// Fixed card geometry — MUST match the rendered card's actual CSS (h-16 =
// 64px) and the grid's gap-3 (12px). Both the row virtualizer and the
// drag-reorder math below key off these constants instead of measuring the
// DOM, which is what lets reordering work correctly even when most of the
// list is scrolled out of view and not mounted.
const CARD_H = 64;
const GRID_GAP = 12;

interface NodeGridProps {
  servers?: ServerRecord[];
  folders?: FolderRecord[];
  activeFolderId?: number | null;
  onActiveFolderChange?: (id: number | null) => void;
  onOpenServer: (server: ServerRecord, initialTool?: Session["initialTool"]) => void;
  onOpenMultipleServers?: (servers: ServerRecord[]) => void;
  onEditServer: (server: ServerRecord) => void;
  // Method syntax (bivariant params): these are also wired straight to
  // onClick, so they may receive the click event as their first argument.
  onAddClick(folderId?: unknown): void;
  onQuickConnect?(arg?: unknown): void;
  onOpenLocalTerminal?(arg?: unknown): void;
  onImportSSHConfig?(arg?: unknown): void;
  onOpenNetworkTools?(arg?: unknown): void;
  onRemoveServer: (id: number) => void | Promise<unknown>;
  onRemoveFolder: (id: number) => void | Promise<unknown>;
  onRenameFolder?: (id: number, name: string) => void | Promise<unknown>;
  onCloneServer?: (id: number) => void | Promise<unknown>;
  onReorderServers?: (ids: number[]) => void | Promise<unknown>;
  isMobile?: boolean;
}

export const NodeGrid = ({ servers, folders, activeFolderId: activeFolderIdProp, onActiveFolderChange, onOpenServer, onOpenMultipleServers, onEditServer, onAddClick, onQuickConnect, onOpenLocalTerminal, onImportSSHConfig, onOpenNetworkTools, onRemoveServer, onRemoveFolder, onRenameFolder, onCloneServer, onReorderServers, isMobile }: NodeGridProps) => {
  const [search, setSearch] = useState("");
  // Native window.confirm() is a silent no-op inside Tauri's Android WebView
  // (same shim gap useTextPrompt was added for), so the delete buttons here
  // silently did nothing on Android after v0.2.32 made the action cluster
  // always-visible on mobile. Route through the themed useConfirm hook.
  const confirm = useConfirm();
  // Folder navigation is controlled when the parent passes both props, so the
  // selection survives NodeGrid unmount/remount (the parent sticks it onto
  // its own state). Falls back to local state for older callers that don't
  // lift the value — same behaviour as before, just optional.
  const [localFolderId, setLocalFolderId] = useState<number | null>(null);
  const activeFolderId: number | null = onActiveFolderChange ? (activeFolderIdProp ?? null) : localFolderId;
  const setActiveFolderId = (next: number | null) => {
    if (onActiveFolderChange) onActiveFolderChange(next);
    else setLocalFolderId(next);
  };
  // Per-folder inline rename state. Only one folder can be in edit mode at
  // a time, so a single { id, draft } slot is enough.
  const [renaming, setRenaming] = useState<{ id: number; draft: string } | null>(null);
  const commitRename = async () => {
    if (!renaming || !onRenameFolder) return;
    const next = renaming.draft.trim();
    if (next && next !== folders?.find((f) => f.id === renaming.id)?.name) {
      try { await onRenameFolder(renaming.id, next); } catch { /* parent surfaces error */ }
    }
    setRenaming(null);
  };

  // Supports glob wildcards (`*` = any run of characters, `?` = exactly one)
  // on top of the plain substring search — `web-*` or `prod-db?` now work the
  // same way they would in a shell. Plain queries with no wildcard chars fall
  // through to the identical regex (every other char is escaped literally),
  // so existing substring-search behavior is unchanged.
  const matchesSearch = (value: string, query: string) => {
    if (!/[*?]/.test(query)) return value.toLowerCase().includes(query.toLowerCase());
    const pattern = query.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    try {
      return new RegExp(pattern, "i").test(value);
    } catch {
      return value.toLowerCase().includes(query.toLowerCase());
    }
  };

  const filteredServers = servers?.filter((s) =>
    matchesSearch(s.name, search) || matchesSearch(s.host, search)
  ) || [];

  const currentFolder = folders?.find((f) => f.id === activeFolderId);

  // If search is active, we might want to just show all matching servers flat,
  // or still respect the folder. Let's just show them flat if searching.
  const isSearching = search.trim() !== "";

  const displayedServers = isSearching
    ? filteredServers
    : filteredServers.filter((s) => s.folder_id === activeFolderId);

  // Single source of truth for column count — drives both the virtualized
  // grid's row layout AND the drag-reorder geometry below, instead of the
  // old pure-CSS `grid-cols-2 lg:grid-cols-3 xl:grid-cols-4` classes (which
  // JS can't read back synchronously). Mirrors Tailwind's default lg/xl
  // breakpoints (1024/1280) so the visual result is unchanged.
  const viewportWidth = useViewportWidth();
  const columnCount = isMobile ? 1 : viewportWidth >= 1280 ? 4 : viewportWidth >= 1024 ? 3 : 2;

  const showFolders = !isSearching && activeFolderId === null;
  const folderCount = showFolders ? (folders?.length || 0) : 0;

  // ── Modern floating drag-to-reorder (pointer-based: mouse AND touch) ────────
  // Grabbing the grip lifts the node out of the grid: a fixed-position clone
  // follows the pointer (the "floating" tile), the vacated slot shows a dashed
  // placeholder, and the remaining cards reflow with a smooth FLIP animation as
  // the placeholder tracks the pointer's insertion point. Drag it back and the
  // order returns; on release the final order is persisted via onReorderServers
  // and held until the props catch up so there's no flash of the old order.
  // Disabled while searching (results aren't the stored order).
  const canReorder = !!onReorderServers && !isSearching;
  const [dragId, setDragId] = useState<number | null>(null);
  // Live id order during a drag (null when not dragging). Rendered from when set.
  const [order, setOrder] = useState<number[] | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const cloneRef = useRef<HTMLDivElement | null>(null);
  // Latest values read inside the window listeners without re-subscribing them.
  const orderRef = useRef<number[] | null>(null);
  orderRef.current = order;
  const initialOrderRef = useRef<number[]>([]);
  const onReorderRef = useRef(onReorderServers);
  onReorderRef.current = onReorderServers;
  const rafRef = useRef<number | null>(null);
  // The scroll container + its scrollTop at drag start. The slot snapshot is in
  // viewport coords; if the list scrolls mid-drag the cards move but the
  // snapshot doesn't, so we subtract the scroll delta to keep them aligned.
  const scrollerRef = useRef<HTMLElement | null>(null);
  const scrollTop0Ref = useRef(0);
  // Pointer + grab geometry for the floating clone.
  const pointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const grabOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const cardSizeRef = useRef<{ w: number; h: number }>({ w: 240, h: 64 });
  // Fixed snapshot of the grid CELL centres, captured at drag start. Insertion
  // is computed against these — never the live card rects — because the live
  // cards carry in-flight FLIP transforms that would corrupt the maths (the
  // grid cells themselves don't move as the order changes; only which card
  // occupies each cell does).
  const slotsRef = useRef<{ x: number; y: number; h: number }[]>([]);
  // Per-card rects for FLIP (measured after each render, keyed by server id).
  const flipRects = useRef<Map<number, DOMRect>>(new Map());
  // True once a drag actually moves, so the click synthesized on pointerup
  // doesn't open whatever card sits under the finger. Cleared next tick.
  const draggedRef = useRef(false);

  const moveClone = (x: number, y: number) => {
    const el = cloneRef.current;
    if (el) el.style.transform = `translate(${x - grabOffsetRef.current.x}px, ${y - grabOffsetRef.current.y}px) rotate(1.5deg) scale(1.03)`;
  };

  useEffect(() => {
    if (dragId === null) return;
    document.body.style.userSelect = 'none';
    const move = (e: PointerEvent) => {
      draggedRef.current = true;
      pointerRef.current = { x: e.clientX, y: e.clientY };
      moveClone(e.clientX, e.clientY); // clone tracks the pointer 1:1, every frame
      if (rafRef.current != null) return; // coalesce the reflow recompute
      const px = e.clientX, py = e.clientY;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        // Insertion index = how many grid CELLS sit before the pointer in
        // reading order (earlier row, or same row and left of it), measured
        // against the fixed drag-start snapshot. Counting the dragged card's
        // own cell is intentional: removing dragId below shifts everything left
        // by one, so inserting at this raw count lands the card exactly under
        // the pointer. Pure function of pointer position → no flicker, and it
        // works across rows because the snapshot never moves.
        // Compensate for any list scroll since drag start: the cells moved by
        // this delta in viewport space but the snapshot didn't.
        const sd = scrollerRef.current ? scrollerRef.current.scrollTop - scrollTop0Ref.current : 0;
        let idx = 0;
        for (const c of slotsRef.current) {
          const cy = c.y - sd;
          const before = (cy < py - c.h / 2) || (Math.abs(cy - py) <= c.h / 2 && c.x < px);
          if (before) idx++;
        }
        setOrder((prev) => {
          const base = (prev ?? initialOrderRef.current).filter((x) => x !== dragId);
          const clamped = Math.max(0, Math.min(idx, base.length));
          base.splice(clamped, 0, dragId);
          if (prev && prev.length === base.length && prev.every((v, i) => v === base[i])) return prev;
          return base;
        });
      });
    };
    const finish = () => {
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      document.body.style.userSelect = '';
      // Clear any leftover FLIP transforms so cards sit cleanly after the drop.
      gridRef.current?.querySelectorAll<HTMLElement>('[data-sid]').forEach((el) => {
        el.style.transition = ''; el.style.transform = '';
      });
      const final = orderRef.current;
      const initial = initialOrderRef.current;
      const changed = !!final && (final.length !== initial.length || final.some((v, i) => v !== initial[i]));
      if (changed) {
        // Persist and KEEP `order` applied — the catch-up effect below clears it
        // once get_servers returns the same sequence, so the grid never flashes
        // back to the old order between release and refresh. If the persist
        // FAILS, drop the override so the grid reverts to the real (unchanged)
        // order instead of showing an arrangement the DB never accepted.
        Promise.resolve(onReorderRef.current?.(final)).catch(() => setOrder(null));
      } else {
        setOrder(null); // dropped where it started: revert cleanly
      }
      setDragId(null);
      setTimeout(() => { draggedRef.current = false; }, 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.body.style.userSelect = '';
    };
  }, [dragId]);

  // FLIP: after each drag render, animate every card from its previous box to
  // its new one so the reflow around the placeholder is smooth, not a jump.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || order === null) { flipRects.current.clear(); return; }
    grid.querySelectorAll<HTMLElement>('[data-sid]').forEach((el) => {
      const id = Number(el.dataset.sid);
      // Strip any in-flight FLIP transform first so we read the true LAYOUT box,
      // not a mid-animation position — otherwise fast successive moves compound.
      el.style.transition = 'none';
      el.style.transform = '';
      const next = el.getBoundingClientRect();
      const prev = flipRects.current.get(id);
      if (prev) {
        const dx = prev.left - next.left, dy = prev.top - next.top;
        if (dx || dy) {
          el.style.transform = `translate(${dx}px, ${dy}px)`;
          void el.getBoundingClientRect(); // force reflow so the next line animates
          el.style.transition = 'transform 180ms cubic-bezier(0.2,0,0,1)';
          el.style.transform = '';
        }
      }
      flipRects.current.set(id, next);
    });
  }, [order]);

  // Clear the local `order` override once the incoming servers prop reflects it
  // (or the drag ended with no change) — avoids a flash back to the old order.
  useEffect(() => {
    if (dragId !== null || order === null) return;
    const cur = displayedServers.map((s) => s.id);
    if (cur.length === order.length && cur.every((v: number, i: number) => v === order[i])) {
      setOrder(null);
    }
  }, [dragId, order, displayedServers]);

  const beginDrag = (e: React.PointerEvent | React.MouseEvent, id: number) => {
    if (!canReorder) return;
    e.preventDefault();
    e.stopPropagation();
    const card = (e.currentTarget as HTMLElement).closest('[data-sid]') as HTMLElement | null;
    const r = card?.getBoundingClientRect();
    grabOffsetRef.current = r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: 20, y: 32 };
    cardSizeRef.current = r ? { w: r.width, h: r.height } : { w: 240, h: 64 };
    pointerRef.current = { x: e.clientX, y: e.clientY };
    // Analytic slot snapshot instead of querying real card DOM rects — with
    // virtualization, most server cards past a screenful aren't mounted at
    // all, so there's nothing for querySelectorAll to find. Column count,
    // card width (measured from the dragged card itself, which IS mounted),
    // and the fixed CARD_H/GRID_GAP constants fully determine every slot's
    // centre, including ones currently scrolled out of view. `folderCount`
    // leading cells shift every server's effective grid index the same way
    // the folders' real DOM cells used to.
    const wrapperRect = gridRef.current?.getBoundingClientRect();
    const originX = wrapperRect?.left ?? 0;
    const originY = wrapperRect?.top ?? 0;
    const cardW = cardSizeRef.current.w;
    const cols = columnCount;
    slotsRef.current = displayedServers.map((_, i: number) => {
      const gridIndex = folderCount + i;
      const row = Math.floor(gridIndex / cols);
      const col = gridIndex % cols;
      return {
        x: originX + col * (cardW + GRID_GAP) + cardW / 2,
        y: originY + row * (CARD_H + GRID_GAP) + CARD_H / 2,
        h: CARD_H,
      };
    });
    // Remember the scroll container + position so mid-drag scrolling can be
    // compensated in the move handler (keeps the drop index aligned) — the
    // analytic slots above are a snapshot at the CURRENT scroll position,
    // exactly like the old DOM-rect snapshot was.
    scrollerRef.current = (gridRef.current?.closest('.custom-scrollbar') as HTMLElement | null) ?? null;
    scrollTop0Ref.current = scrollerRef.current ? scrollerRef.current.scrollTop : 0;
    draggedRef.current = false;
    initialOrderRef.current = displayedServers.map((s) => s.id);
    setOrder(initialOrderRef.current);
    setDragId(id);
  };

  // The servers to render, honouring the live drag order when one is active.
  const orderedServers: ServerRecord[] = (() => {
    if (!order) return displayedServers;
    const byId = new Map<number, ServerRecord>(displayedServers.map((s) => [s.id, s]));
    const out = order.map((id) => byId.get(id)).filter((x): x is ServerRecord => Boolean(x));
    // Include any servers not present in `order` (e.g. added mid-drag) at the end.
    for (const s of displayedServers) if (!order.includes(s.id)) out.push(s);
    return out;
  })();

  const draggedServer = dragId != null ? displayedServers.find((s) => s.id === dragId) : null;

  // Flat list of grid cells in render order (folders first, then servers),
  // chunked into rows of `columnCount` for the row virtualizer. Rebuilt
  // whenever any of its inputs change — cheap relative to a render anyway.
  type Cell = { kind: "folder"; f: FolderRecord } | { kind: "server"; s: ServerRecord };
  const cells: Cell[] = useMemo(() => {
    const out: Cell[] = [];
    if (showFolders) for (const f of folders || []) out.push({ kind: "folder", f });
    for (const s of orderedServers) out.push({ kind: "server", s });
    return out;
  }, [showFolders, folders, orderedServers]);
  const rows: Cell[][] = useMemo(() => {
    const out: Cell[][] = [];
    for (let i = 0; i < cells.length; i += columnCount) out.push(cells.slice(i, i + columnCount));
    return out;
  }, [cells, columnCount]);

  const scrollParentRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => CARD_H + GRID_GAP,
    overscan: 6,
  });

  // Compact horizontal node card: a monogram avatar carries identity, the
  // server projects its own colour as a left accent bar. Kept short (h-16) so
  // name + host read clearly. Rendered as a plain keyed <div> (not a nested
  // component) so React reuses the same DOM node across renders — that's what
  // lets the FLIP effect measure and animate real positions. While this card is
  // the one being dragged it renders as a dashed placeholder holding the slot;
  // the floating clone (portal, below) is what the pointer carries.
  const renderServer = (s: ServerRecord) => {
    const isProd = Boolean(s.is_production || /prod|production|live/i.test(s.name || ""));
    const accent = s.color || (isProd ? '#f43f5e' : 'rgb(var(--primary))');
    const monogram = (s.name || '').trim().charAt(0).toUpperCase();
    if (dragId === s.id) {
      return (
        <div
          key={`server-${s.id}`}
          data-sid={s.id}
          aria-hidden
          className="h-16 rounded-xl border-2 border-dashed border-primary/40 bg-primary/[0.05]"
        />
      );
    }
    return (
      <div
        key={`server-${s.id}`}
        data-sid={s.id}
        onClick={() => { if (draggedRef.current) return; onOpenServer(s); }}
        className="group relative flex items-center gap-3 h-16 pl-3.5 pr-2 rounded-xl bg-gradient-to-br from-[#17171c] to-[#121216] border border-white/5 hover:border-primary/40 hover:bg-white/[0.015] transition-colors duration-150 cursor-pointer overflow-hidden"
      >
        {/* Per-server colour accent: a crisp left bar. */}
        <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: accent }} />

        {/* Drag handle (grip) — grab to reorder. Hidden until hover on desktop,
            always shown on touch (no hover there). touch-action:none stops the
            gesture from scrolling the list while dragging. */}
        {canReorder && (
          <button
            onPointerDown={(e) => beginDrag(e, s.id)}
            onClick={(e) => e.stopPropagation()}
            title="Drag to reorder"
            className="shrink-0 -ml-1.5 -mr-1 p-1 rounded-md text-zinc-600 hover:text-zinc-300 cursor-grab active:cursor-grabbing opacity-100 sm:opacity-0 sm:group-hover:opacity-100 [@media(hover:none)]:!opacity-100 transition-opacity"
            style={{ touchAction: 'none' }}
          >
            <GripVertical size={14} />
          </button>
        )}

        {/* Icon / Monogram avatar with tag colour. */}
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center shadow-inner shrink-0 border transition-all"
          style={{
            backgroundColor: s.color ? `${s.color}15` : 'rgba(var(--primary), 0.12)',
            borderColor: s.color ? `${s.color}35` : 'rgba(var(--primary), 0.25)',
            color: s.color || 'rgb(var(--primary))',
          }}
        >
          {s.icon && s.icon !== "server" ? (
            renderServerIcon(s.icon, 16)
          ) : monogram ? (
            <span className="font-black text-[14px] leading-none">{monogram}</span>
          ) : (
            <Server size={15} />
          )}
        </div>

        {/* Name + host — flex-1 + min-w-0 so long values truncate cleanly. */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <h3 className="font-bold text-zinc-100 text-[13px] truncate tracking-tight leading-tight">{s.name}</h3>
            {s.protocol === "rdp" && (
              <span
                className="px-1.5 py-0.5 rounded text-[8.5px] font-bold tracking-wider uppercase bg-sky-500/15 border border-sky-500/30 text-sky-300 shrink-0"
                title="Remote Desktop (RDP) - opens your system's Remote Desktop client"
              >
                RDP
              </span>
            )}
            {isProd && (
              <span
                className="px-1.5 py-0.5 rounded text-[8.5px] font-bold tracking-wider uppercase bg-rose-500/15 border border-rose-500/30 text-rose-300 flex items-center gap-1 shrink-0"
                title="Production Node (Safe Mode active)"
              >
                <ShieldAlert size={10} /> PROD
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
            <Globe size={10} className="text-zinc-400 shrink-0" />
            <span className="text-[10.5px] text-zinc-300 font-mono truncate">{s.host}</span>
          </div>
        </div>

        {/* Distro / OS prominent logo on right */}
        {(() => {
          if (!s.os_info) return null;
          try {
            const info = typeof s.os_info === "string" ? JSON.parse(s.os_info) : s.os_info;
            if (!info || (!info.distro && !info.os_type)) return null;
            return (
              <div
                title={`OS: ${info.distro || info.os_type} ${info.version || ""}`}
                className="shrink-0 mr-1 sm:group-hover:opacity-0 transition-opacity flex items-center justify-center select-none"
              >
                <DistroLogo
                  distroId={info.distro_id}
                  distroName={info.distro}
                  osType={info.os_type}
                  size={28}
                />
              </div>
            );
          } catch {
            return null;
          }
        })()}

        {/* Actions: absolute + hover-revealed on desktop so the name gets the
            full width; inline + always-visible on mobile (no hover there). */}
        <div className="flex items-center gap-0.5 shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 [@media(hover:none)]:!opacity-100 sm:absolute sm:right-1.5 sm:top-1/2 sm:-translate-y-1/2 sm:pl-8 sm:bg-gradient-to-l sm:from-[#121216] sm:via-[#121216] sm:to-transparent transition-all duration-200">
          <button
            onClick={(e) => { e.stopPropagation(); onOpenServer(s, 'sftp'); }}
            title="Open SFTP directly"
            className="p-1.5 rounded-lg text-zinc-500 hover:text-indigo-400 hover:bg-white/5 transition-all"
          >
            <Folder size={13} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onOpenServer(s, 'info'); }}
            title="Open Docker & Overview directly"
            className="p-1.5 rounded-lg text-zinc-500 hover:text-sky-400 hover:bg-white/5 transition-all"
          >
            <Box size={13} />
          </button>
          {onCloneServer && (
            <button
              onClick={(e) => { e.stopPropagation(); onCloneServer(s.id); }}
              title="Clone"
              className="p-1.5 rounded-lg text-zinc-500 hover:text-primary hover:bg-white/5 transition-all"
            >
              <Copy size={13} />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onEditServer(s); }}
            title="Edit"
            className="p-1.5 rounded-lg text-zinc-500 hover:text-white hover:bg-white/5 transition-all"
          >
            <Edit2 size={13} />
          </button>
          <button
            onClick={async (e) => {
              e.stopPropagation();
              if (await confirm({ title: 'Delete server?', message: `“${s.name}” will be removed from this profile.`, destructive: true })) {
                onRemoveServer(s.id);
              }
            }}
            title="Delete"
            className="p-1.5 rounded-lg text-zinc-500 hover:text-red-500 hover:bg-white/5 transition-all"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    );
  };

  // Folders share the compact horizontal language so the grid reads as one
  // surface: a tinted folder glyph, name + server count, inline rename in
  // place, and the same hover lift as server cards.
  const FolderCard = ({ f }: { f: FolderRecord }) => {
    const serverCount = servers?.filter((s) => s.folder_id === f.id).length || 0;
    const isRenaming = renaming?.id === f.id;
    const accent = f.color || 'rgb(var(--primary))';
    return (
      <div
        onClick={() => { if (!isRenaming) setActiveFolderId(f.id); }}
        className="group relative flex items-center gap-3 h-16 pl-3.5 pr-2 rounded-xl bg-gradient-to-br from-[#1c1c22] to-[#141418] border border-white/5 hover:border-primary/40 hover:bg-white/[0.015] transition-colors duration-150 cursor-pointer overflow-hidden"
      >
        <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: accent }} />

        {/* Folder glyph avatar. */}
        <div
          className="w-9 h-9 rounded-lg bg-black/40 border border-white/10 flex items-center justify-center shadow-inner shrink-0"
          style={{ color: f.color || undefined }}
        >
          <Folder size={16} className={f.color ? '' : 'text-primary'} />
        </div>

        {/* Name (inline-editable) + count. */}
        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <input
              autoFocus
              value={renaming!.draft}
              onChange={(e) => setRenaming({ id: f.id, draft: e.target.value })}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                if (e.key === "Escape") { e.preventDefault(); setRenaming(null); }
              }}
              className="w-full h-7 px-2 bg-black/40 border border-primary/40 rounded-lg text-[13px] font-bold text-white outline-none"
            />
          ) : (
            <>
              <h3 className="font-bold text-zinc-100 text-[13px] truncate tracking-tight leading-tight">{f.name}</h3>
              <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-[0.12em]">
                {serverCount === 1 ? '1 server' : `${serverCount} servers`}
              </span>
            </>
          )}
        </div>

        {/* Right cluster: count badge (idle) that swaps to actions on hover. */}
        {isRenaming ? (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); commitRename(); }}
              title="Save name"
              className="p-1.5 text-emerald-400 hover:bg-white/10 rounded-lg"
            >
              <Check size={14} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setRenaming(null); }}
              title="Cancel"
              className="p-1.5 text-zinc-400 hover:text-rose-400 hover:bg-white/10 rounded-lg"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <div className="relative flex items-center shrink-0">
            <span className="text-[10px] bg-black/60 text-zinc-400 px-1.5 py-0.5 rounded-md font-mono group-hover:opacity-0 transition-opacity">{serverCount}</span>
            <div className="absolute right-0 flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 [@media(hover:none)]:!opacity-100 transition-all bg-gradient-to-l from-[#16161b] via-[#16161b] to-transparent pl-6">
              <button
                onClick={(e) => { e.stopPropagation(); setRenaming({ id: f.id, draft: f.name || "" }); }}
                title="Rename folder"
                className="p-1.5 rounded-lg text-zinc-500 hover:text-primary hover:bg-white/5 transition-all"
              >
                <Edit2 size={13} />
              </button>
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  if (await confirm({ title: 'Delete folder?', message: `“${f.name}” and every server inside it will be removed.`, destructive: true })) {
                    onRemoveFolder(f.id);
                  }
                }}
                title="Delete folder"
                className="p-1.5 rounded-lg text-zinc-500 hover:text-red-500 hover:bg-white/5 transition-all"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col h-full p-6 overflow-hidden bg-transparent">
      <div className="relative max-w-sm w-full mx-auto mb-6 shrink-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={14} />
        <input
          type="text"
          placeholder="Search servers…"
          className="w-full h-9 bg-[#1c1c21] border border-white/10 rounded-lg pl-9 pr-4 text-[13px] text-zinc-100 outline-none focus:border-primary/50 focus:bg-[#16161a] transition-all placeholder:text-zinc-600 shadow-inner"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="flex-1 flex flex-col min-h-0">

        {/* Header navigation if in folder */}
        {!isSearching && activeFolderId !== null && (
          <div className="flex items-center gap-3 mb-6 shrink-0">
            <button
              onClick={() => setActiveFolderId(null)}
              className="w-8 h-8 bg-black rounded-xl border border-white/5 flex items-center justify-center hover:bg-white/10 hover:text-white text-zinc-500 transition-all shadow-inner"
            >
              <ChevronLeft size={16} />
            </button>
            <h2 className="text-[15px] font-bold text-primary tracking-tight flex items-center gap-2 flex-1">
              <Folder size={16} /> {currentFolder?.name}
            </h2>
            {/* Adding a server from inside a folder pre-selects this folder
                in the new-node panel, so the user doesn't have to repeat
                the choice they just clicked into. */}
            {displayedServers.length >= 2 && onOpenMultipleServers && (
              <button
                onClick={() => onOpenMultipleServers(displayedServers)}
                className="h-8 px-3 bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 hover:bg-indigo-500/25 rounded-lg flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider transition-colors"
                title="Connect all servers in this folder"
              >
                <Layers size={13} /> Connect All ({displayedServers.length})
              </button>
            )}
            <button
              onClick={() => onAddClick(activeFolderId)}
              className="h-8 px-3 bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 rounded-lg flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider"
            >
              <Plus size={13} /> Add server
            </button>
          </div>
        )}

        {servers?.length === 0 && folders?.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-4">
            <button
              onClick={onAddClick}
              className="flex flex-col items-center gap-4 p-12 rounded-3xl border-2 border-dashed border-zinc-800 hover:border-primary/40 hover:bg-primary/5 transition-all group"
            >
              <div className="w-14 h-14 bg-primary/10 rounded-2xl flex items-center justify-center text-primary shadow-[0_0_15px_rgba(var(--primary),0.1)] transition-transform">
                <Plus size={28} />
              </div>
              <div className="text-center">
                <h3 className="text-[15px] font-bold text-white tracking-tight">Add your first server</h3>
                <p className="text-[12px] text-zinc-500 mt-1">Tap here to get started.</p>
              </div>
            </button>
            {onOpenLocalTerminal && (
              <button
                onClick={onOpenLocalTerminal}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-xs font-semibold hover:bg-emerald-500/20 transition-all shadow-sm"
              >
                <TerminalSquare size={15} /> Launch Local Shell
              </button>
            )}
            {onImportSSHConfig && (
              <button
                onClick={onImportSSHConfig}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-sky-500/10 border border-sky-500/25 text-sky-400 text-xs font-semibold hover:bg-sky-500/20 transition-all shadow-sm"
              >
                <Download size={15} /> Import from ~/.ssh/config
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Compact action toolbar (root only) — sized to its own content
                rather than filling a full grid cell like the cards. */}
            {(!isSearching && activeFolderId === null) && (
              <div className="flex items-center gap-2 mb-4 flex-wrap shrink-0">
                <button
                  onClick={onAddClick}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-primary/10 border border-primary/25 text-primary text-[11px] font-bold uppercase tracking-wider hover:bg-primary/20 transition-colors"
                >
                  <Plus size={13} /> Add server
                </button>
                {onQuickConnect && (
                  <button
                    onClick={onQuickConnect}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-amber-500/10 border border-amber-500/25 text-amber-300/90 text-[11px] font-bold uppercase tracking-wider hover:bg-amber-500/20 hover:text-amber-200 transition-colors"
                  >
                    <Zap size={13} /> Quick connect
                  </button>
                )}
                {onOpenLocalTerminal && (
                  <button
                    onClick={onOpenLocalTerminal}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-[11px] font-bold uppercase tracking-wider hover:bg-emerald-500/20 hover:text-emerald-300 transition-colors"
                    title="Launch a local shell (PowerShell / Bash) session"
                  >
                    <TerminalSquare size={13} /> Local Shell
                  </button>
                )}
                {onImportSSHConfig && (
                  <button
                    onClick={onImportSSHConfig}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-sky-500/10 border border-sky-500/25 text-sky-400 text-[11px] font-bold uppercase tracking-wider hover:bg-sky-500/20 hover:text-sky-300 transition-colors"
                    title="Import hosts from OpenSSH ~/.ssh/config, PuTTY, or MobaXterm"
                  >
                    <Download size={13} /> Import SSH Config
                  </button>
                )}
                {onOpenNetworkTools && (
                  <button
                    onClick={onOpenNetworkTools}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-teal-500/10 border border-teal-500/25 text-teal-300 text-[11px] font-bold uppercase tracking-wider hover:bg-teal-500/20 hover:text-teal-200 transition-colors"
                    title="Network diagnostics: TCP port probe, latency ping, service audit"
                  >
                    <Activity size={13} /> Network Tools
                  </button>
                )}
                {displayedServers.length >= 2 && onOpenMultipleServers && (
                  <button
                    onClick={() => onOpenMultipleServers(displayedServers)}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-indigo-500/10 border border-indigo-500/25 text-indigo-300 text-[11px] font-bold uppercase tracking-wider hover:bg-indigo-500/20 hover:text-white transition-colors"
                    title="Connect all displayed servers and enable broadcast"
                  >
                    <Layers size={13} /> Connect All ({displayedServers.length})
                  </button>
                )}
              </div>
            )}

          {/* Scroll container the row virtualizer measures against. Pulled out
              of the header/toolbar's flow (those are shrink-0 siblings above)
              so only the grid itself scrolls — needed because the virtualizer
              positions rows as absolute offsets from the TOP of its own
              wrapper, which only lines up correctly if that wrapper starts at
              the scroll container's scroll origin. */}
          <div ref={scrollParentRef} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-1 pb-10">
            {rows.length === 0 ? (
              <div className="col-span-full py-10 text-center text-zinc-600 text-xs italic">
                {isSearching ? "No matches." : "Nothing in this folder yet."}
              </div>
            ) : (
              <div ref={gridRef} style={{ position: "relative", height: rowVirtualizer.getTotalSize() }}>
                {rowVirtualizer.getVirtualItems().map((vRow) => (
                  <div
                    key={vRow.key}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: CARD_H,
                      transform: `translateY(${vRow.start}px)`,
                      display: "grid",
                      gridTemplateColumns: `repeat(${columnCount}, 1fr)`,
                      gap: GRID_GAP,
                    }}
                  >
                    {rows[vRow.index].map((cell) =>
                      cell.kind === "folder"
                        ? <FolderCard key={`folder-${cell.f.id}`} f={cell.f} />
                        : renderServer(cell.s)
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          </>
        )}
      </div>

      {/* Floating drag clone — a fixed-position copy of the node that the
          pointer carries while the grid reflows underneath. pointer-events:none
          so it never intercepts the elementFromPoint / hover logic. */}
      {draggedServer && createPortal(
        <div
          ref={cloneRef}
          className="fixed left-0 top-0 z-[9999] pointer-events-none will-change-transform"
          style={{
            width: cardSizeRef.current.w,
            transform: `translate(${pointerRef.current.x - grabOffsetRef.current.x}px, ${pointerRef.current.y - grabOffsetRef.current.y}px) rotate(1.5deg) scale(1.03)`,
          }}
        >
          <div className="relative flex items-center gap-3 h-16 pl-3.5 pr-2 rounded-xl bg-gradient-to-br from-[#1b1b20] to-[#141418] border border-primary/50 ring-1 ring-primary/40 shadow-2xl shadow-black/60 overflow-hidden">
            <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: draggedServer.color || 'rgb(var(--primary))' }} />
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary/25 to-primary/[0.03] border border-primary/20 flex items-center justify-center text-primary shadow-inner shrink-0">
              {(draggedServer.name || '').trim().charAt(0)
                ? <span className="font-black text-[14px] leading-none">{(draggedServer.name || '').trim().charAt(0).toUpperCase()}</span>
                : <Server size={14} />}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-bold text-zinc-100 text-[13px] truncate tracking-tight leading-tight">{draggedServer.name}</h3>
              <div className="flex items-center gap-1 mt-0.5">
                <Globe size={10} className="text-zinc-400 shrink-0" />
                <span className="text-[10.5px] text-zinc-300 font-mono truncate">{draggedServer.host}</span>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
