import { LayoutGrid, Plus, X, TerminalSquare, PinOff } from "lucide-react";
import TerminalView from "./TerminalView";
import type { WallItem, SessionTerm } from "../hooks/useWallManager";
import type { Session } from "../hooks/useSessionManager";

// The Fleet Wall view - extracted out of DesktopApp.tsx (part of the ongoing
// decomposition tracked in TODO.md). Pure extraction: all state stays lifted in
// DesktopApp.tsx (via useWallManager / useSessionManager) and arrives as props;
// no behavior change. Wall tiles mount their own TerminalView in attach-only
// mode so xterm scrollback + PTY ownership stay with the primary xterm in the
// session tab.

export interface WallViewProps {
  wallItems: WallItem[];
  setWallItems: (items: WallItem[]) => void;
  wallCols: number;
  setWallCols: (n: number) => void;
  wallPickerOpen: boolean;
  setWallPickerOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  sessions: Session[];
  sessionTerminals: Record<string, SessionTerm[]>;
  sessionStatuses: Record<string, string>;
  setActiveView: (v: string) => void;
  wallHasTerminal: (terminalId: string) => boolean;
  pinTerminalToWall: (sessionId: string, terminalId: string) => void;
  unpinTerminalFromWall: (terminalId: string) => void;
}

export const WallView = ({
  wallItems, setWallItems, wallCols, setWallCols, wallPickerOpen, setWallPickerOpen,
  sessions, sessionTerminals, sessionStatuses, setActiveView,
  wallHasTerminal, pinTerminalToWall, unpinTerminalFromWall,
}: WallViewProps) => (
  <div className="absolute inset-0 flex flex-col overflow-hidden bg-[#0a0a0d]">
    {/* Toolbar: cols selector + Add + Clear. Rows are
        derived automatically from tile count so users only
        have to pick the horizontal density they want. */}
    <div className="h-10 shrink-0 border-b border-white/5 bg-[#111114] flex items-center gap-2 px-3">
      <LayoutGrid size={12} className="text-primary/70 shrink-0" />
      <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 shrink-0">
        Wall {wallItems.length > 0 ? `· ${wallItems.length}` : ''}
      </span>
      <div className="flex items-center gap-1 ml-2 shrink-0">
        <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Cols</span>
        {[1, 2, 3, 4, 5, 6].map(n => (
          <button
            key={n}
            onClick={() => setWallCols(n)}
            title={`${n} column${n === 1 ? '' : 's'} per row`}
            className={`h-6 w-6 rounded flex items-center justify-center text-[10px] font-bold transition-all ${
              wallCols === n
                ? 'bg-primary/20 text-primary border border-primary/40'
                : 'text-zinc-400 hover:bg-white/[0.06] border border-transparent'
            }`}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="flex-1" />
      <button
        onClick={() => setWallPickerOpen(v => !v)}
        title="Pick terminals to pin"
        className="px-3 py-1 bg-primary/15 hover:bg-primary/25 text-primary border border-primary/30 rounded-md text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5"
      >
        <Plus size={11} /> Add
      </button>
      {wallItems.length > 0 && (
        <button
          onClick={() => setWallItems([])}
          title="Unpin everything (terminals stay open in their sessions)"
          className="px-3 py-1 bg-white/[0.04] hover:bg-rose-500/15 hover:text-rose-300 border border-white/10 rounded-md text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5"
        >
          <X size={11} /> Clear
        </button>
      )}
    </div>

    {/* Grid canvas. Empty state overlaid when nothing is
        pinned so we don't just show a black rectangle to a
        first-time visitor. */}
    <div className="flex-1 relative bg-black/40 overflow-auto custom-scrollbar">
      {wallItems.length === 0 ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center px-6 pointer-events-none">
          <LayoutGrid size={40} className="text-zinc-600" />
          <div className="text-zinc-400 text-[13px] max-w-md leading-relaxed">
            The Wall is a pinboard for watching multiple <em>terminals</em> at once.<br/>
            Right-click a session tab or use the <span className="text-primary font-semibold">Add</span> button above to pin any terminal from any server.
          </div>
        </div>
      ) : (
        <div
          className="min-h-full grid gap-1.5 p-1.5"
          style={{
            gridTemplateColumns: `repeat(${wallCols}, minmax(0, 1fr))`,
            gridAutoRows: `minmax(220px, 1fr)`,
          }}
        >
          {wallItems.map(item => {
            const sess = sessions.find(s => s.id === item.sessionId);
            if (!sess) return null;
            const terms = sessionTerminals[item.sessionId] ?? [];
            const term = terms.find(t => t.id === item.terminalId);
            const st = sessionStatuses[item.sessionId] ?? 'connecting';
            const dotTone =
              st === 'connected'    ? 'bg-emerald-400' :
              st === 'connecting'   ? 'bg-amber-400 animate-pulse' :
                                      'bg-rose-500';
            return (
              <div
                key={item.id}
                className="flex flex-col overflow-hidden border border-white/10 rounded-md bg-[#09090b] shadow-[0_2px_10px_rgba(0,0,0,0.4)] hover:border-primary/30 transition-colors"
              >
                {/* Slim tile header — server + terminal
                    title, quick-jump into the session,
                    unpin. Terminal body below owns focus
                    so keystrokes go to xterm directly. */}
                <div className="h-7 shrink-0 flex items-center gap-2 px-2 border-b border-white/5 bg-[#141418] text-[10.5px] select-none">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotTone}`} />
                  <span className="font-bold text-zinc-200 uppercase tracking-wider truncate">
                    {sess.serverName}
                  </span>
                  <span className="text-zinc-600">·</span>
                  <span className="text-zinc-400 truncate flex-1">
                    {term?.title ?? item.terminalId}
                  </span>
                  <button
                    onClick={() => setActiveView(sess.id)}
                    title="Open this session in its own tab"
                    className="h-5 w-5 rounded flex items-center justify-center text-zinc-500 hover:text-primary hover:bg-white/[0.05] transition-all"
                  >
                    <TerminalSquare size={11} />
                  </button>
                  <button
                    onClick={() => unpinTerminalFromWall(item.terminalId)}
                    title="Unpin from Wall"
                    className="h-5 w-5 rounded flex items-center justify-center text-zinc-500 hover:text-red-400 hover:bg-white/[0.05] transition-all"
                  >
                    <PinOff size={11} />
                  </button>
                </div>
                {/* Attach-only TerminalView: hitches onto
                    the same PTY as the session's primary
                    xterm without owning the lifecycle, so
                    closing the Wall or unpinning doesn't
                    drop the session. */}
                {sessionStatuses[item.sessionId] === 'connected' ? (
                  <div className="flex-1 min-h-0 relative">
                    <TerminalView
                      sessionId={item.sessionId}
                      terminalId={item.terminalId}
                      attachOnly
                      disabled={false}
                      isActive={true}
                      serverId={sess.serverId}
                      serverName={sess.serverName}
                    />
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-zinc-500 text-[10.5px] font-medium uppercase tracking-wider">
                    Session {st}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>

    {/* Wall picker popover — 2-level session → terminal
        tree so users can precisely pick which shells to
        pin. Ticking a terminal pins; unticking unpins.
        Session rows aren't selectable themselves; they
        only group their terminals visually. */}
    {wallPickerOpen && (
      <>
        <div className="fixed inset-0 z-[65]" onClick={() => setWallPickerOpen(false)} />
        <div className="absolute top-12 right-3 z-[66] w-80 max-h-[70vh] bg-[#15151a] border border-white/10 rounded-xl shadow-2xl p-2 flex flex-col">
          <div className="px-2 pb-2 flex items-center justify-between shrink-0">
            <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
              Pin terminals
            </span>
            <button
              onClick={() => setWallPickerOpen(false)}
              className="h-5 w-5 rounded flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/[0.05]"
            >
              <X size={11} />
            </button>
          </div>
          {sessions.length === 0 ? (
            <div className="px-2 py-6 text-center text-zinc-500 text-[11px]">
              No open sessions yet.
            </div>
          ) : (
            <div className="overflow-y-auto custom-scrollbar space-y-1 pr-1">
              {sessions.map(s => {
                const terms = sessionTerminals[s.id] ?? [];
                const st = sessionStatuses[s.id] ?? 'connecting';
                return (
                  <div key={s.id} className="rounded bg-white/[0.02] border border-white/5">
                    <div className="flex items-center gap-2 px-2 py-1.5 border-b border-white/5">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        st === 'connected' ? 'bg-emerald-400' :
                        st === 'connecting' ? 'bg-amber-400' :
                        'bg-rose-500'
                      }`} />
                      <span className="text-[11px] font-bold text-zinc-200 truncate flex-1">
                        {s.serverName}
                      </span>
                      <span className="text-[9px] uppercase tracking-wider text-zinc-500">
                        {terms.length} term{terms.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    {terms.length === 0 ? (
                      <div className="px-3 py-2 text-[10px] text-zinc-500 italic">
                        Session not yet ready.
                      </div>
                    ) : (
                      <div className="p-1 space-y-0.5">
                        {terms.map(t => {
                          const checked = wallHasTerminal(t.id);
                          return (
                            <label
                              key={t.id}
                              className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer ${
                                checked ? 'bg-primary/10' : 'hover:bg-white/[0.04]'
                              }`}
                            >
                              <input
                                type="checkbox"
                                className="accent-primary shrink-0"
                                checked={checked}
                                onChange={() => {
                                  if (checked) unpinTerminalFromWall(t.id);
                                  else pinTerminalToWall(s.id, t.id);
                                }}
                              />
                              <TerminalSquare size={11} className="text-zinc-500 shrink-0" />
                              <span className="text-[11px] text-zinc-200 truncate flex-1">
                                {t.title}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </>
    )}
  </div>
);
