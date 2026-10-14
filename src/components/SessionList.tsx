import { ChevronDown, ChevronRight, Pin, PinOff, X } from "lucide-react";
import type { Session } from "../hooks/useSessionManager";
import { metaKeyOf, orderSessions, type SessionMeta } from "../sessions/sessionMeta";

// Open sessions of one kind (Servers, SFTP, RDP), listed in the sidebar instead of a
// tab strip: pinned first, then named groups (collapsible), then the rest.
// "rail" fits the 56 px icon rail (short labels); "panel" is the wide list with names.
// Pinned servers stay listed after their session closes, dimmed, so one click reconnects them.

interface Props {
  sessions: Session[];
  meta: SessionMeta;
  variant: "rail" | "panel";
  activeView: string;
  mergedSessionIds: string[];
  statuses: Record<string, string>;
  nameOf: (s: Session) => string;
  onSelect: (sessionId: string, split: boolean) => void;
  onMenu: (sessionId: string, x: number, y: number) => void;
  onClose: (sessionId: string) => void;
  onToggleGroup: (group: string) => void;
  /** Pin or unpin by meta key; shows a hover pin button on each entry. */
  onTogglePin?: (key: string) => void;
  /** Pinned entries of this list with no open session. */
  pinnedClosed?: { key: string; name: string }[];
  onOpenPinned?: (key: string) => void;
  /** Label for screen readers, e.g. "Open servers". */
  label: string;
}

const dot = (status?: string) =>
  status === "connected" ? "bg-emerald-400" : status === "connecting" || status === "idle" ? "bg-amber-400" : "bg-rose-500";

export function SessionList({ sessions, meta, variant, activeView, mergedSessionIds, statuses, nameOf, onSelect, onMenu, onClose, onToggleGroup, onTogglePin, pinnedClosed = [], onOpenPinned, label }: Props) {
  if (sessions.length === 0 && pinnedClosed.length === 0) return null;
  const rail = variant === "rail";
  const pinButton = (key: string, pinned: boolean, name: string) => onTogglePin && (
    <button
      type="button"
      onClick={() => onTogglePin(key)}
      aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
      title={pinned ? "Unpin" : "Pin (stays in this list and reopens on start)"}
      className={`absolute hidden group-hover/sess:flex focus:flex items-center justify-center rounded-full bg-zinc-800 border border-white/10 hover:text-primary ${pinned ? "text-primary" : "text-zinc-400"} ${
        rail ? "-top-1 -left-1 w-3.5 h-3.5" : "right-6 top-1/2 -translate-y-1/2 w-4 h-4"
      }`}
    >
      {pinned ? <PinOff size={rail ? 8 : 10} /> : <Pin size={rail ? 8 : 10} />}
    </button>
  );
  return (
    <div role="list" aria-label={label} className={rail ? "-mt-1.5 flex flex-col gap-1" : "flex flex-col gap-0.5"}>
      {pinnedClosed.map(({ key, name }) => (
        <div role="listitem" key={key} className="relative group/sess">
          <button
            type="button"
            onClick={() => onOpenPinned?.(key)}
            title={`${name} (pinned, not open) · click to connect`}
            className={`w-full flex items-center gap-1 rounded-lg border border-dashed border-white/10 text-zinc-500 hover:text-zinc-100 hover:bg-white/5 transition-colors ${
              rail ? "h-7 px-1 justify-center text-[9px] font-bold uppercase tracking-tight" : "h-7 px-2 text-[12px]"
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-zinc-600" />
            <span className="truncate">{rail ? name.slice(0, 5) : name}</span>
            {!rail && <Pin size={10} className="ml-auto shrink-0 text-zinc-600" aria-label="Pinned" />}
          </button>
          {pinButton(key, true, name)}
        </div>
      ))}
      {orderSessions(sessions, meta).map((block, bi) => {
        const collapsed = !!block.group && meta.collapsed.includes(block.group);
        return (
          <div key={block.group ?? `loose-${bi}`} className="flex flex-col gap-0.5">
            {block.group && (
              <button
                type="button"
                onClick={() => onToggleGroup(block.group!)}
                aria-expanded={!collapsed}
                title={`Group: ${block.group}`}
                className={`flex items-center gap-0.5 text-zinc-500 hover:text-zinc-200 truncate ${rail ? "text-[8px] font-bold uppercase justify-center" : "text-[10px] font-bold uppercase tracking-wider px-1 pt-1.5"}`}
              >
                {collapsed ? <ChevronRight size={rail ? 8 : 11} className="shrink-0" /> : <ChevronDown size={rail ? 8 : 11} className="shrink-0" />}
                <span className="truncate">{block.group}</span>
              </button>
            )}
            {!collapsed && block.sessions.map((s) => {
              const name = nameOf(s);
              const key = metaKeyOf(s);
              const pinned = !!key && meta.pinned.includes(key);
              const active = activeView === s.id;
              const merged = mergedSessionIds.includes(s.id) && !active;
              return (
                <div role="listitem" key={s.id} className="relative group/sess">
                  <button
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={(e) => onSelect(s.id, e.ctrlKey || e.metaKey)}
                    onContextMenu={(e) => { e.preventDefault(); onMenu(s.id, e.clientX, e.clientY); }}
                    title={`${name}${pinned ? " (pinned)" : ""} · ${statuses[s.id] ?? "connecting"} · right-click for options, Ctrl+click to split`}
                    className={`w-full flex items-center gap-1 rounded-lg border transition-colors ${
                      rail ? "h-7 px-1 justify-center text-[9px] font-bold uppercase tracking-tight" : "h-7 px-2 text-[12px]"
                    } ${active
                      ? "bg-primary/15 text-primary border-primary/30"
                      : merged ? "bg-primary/5 text-zinc-200 border-primary/20"
                      : "text-zinc-400 hover:text-zinc-100 hover:bg-white/5 border-transparent"}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot(statuses[s.id])}`} />
                    <span className="truncate">{rail ? name.slice(0, 5) : name}</span>
                    {pinned && !rail && <Pin size={10} className="ml-auto shrink-0 text-zinc-500" aria-label="Pinned" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => onClose(s.id)}
                    aria-label={`Close ${name}`}
                    title="Close"
                    className={`absolute hidden group-hover/sess:flex focus:flex items-center justify-center rounded-full bg-zinc-800 border border-white/10 text-zinc-400 hover:text-red-400 ${
                      rail ? "-top-1 -right-1 w-3.5 h-3.5" : "right-1 top-1/2 -translate-y-1/2 w-4 h-4"
                    }`}
                  >
                    <X size={rail ? 8 : 10} />
                  </button>
                  {key && pinButton(key, pinned, name)}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
