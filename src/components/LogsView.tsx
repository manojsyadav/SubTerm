import { ChevronLeft, Trash2 } from "lucide-react";

// The "Activity" (logs) view — extracted out of DesktopApp.tsx (part of the
// ongoing decomposition tracked in TODO.md). Pure extraction: all state
// (the log list itself) stays lifted in DesktopApp.tsx, passed down as
// props; no behavior change.

export interface LogEntry {
  id: string;
  time: string;
  msg: string;
  type: string;
}

export interface LogsViewProps {
  logs: LogEntry[];
  setActiveView: (v: string) => void;
  setLogs: (logs: LogEntry[]) => void;
  confirm: (opts: { title: string; message: string; destructive?: boolean }) => Promise<boolean>;
}

export const LogsView = ({ logs, setActiveView, setLogs, confirm }: LogsViewProps) => (
  <div className="flex-1 flex flex-col p-3 sm:p-8 space-y-3 sm:space-y-6 animate-in overflow-hidden">
    <header className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 sm:gap-3 border-b border-zinc-700 pb-3 sm:pb-6 shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={() => setActiveView("settings")}
          className="h-8 w-8 sm:hidden flex items-center justify-center rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 transition-all shrink-0"
          title="Back to Settings"
        >
          <ChevronLeft size={18} />
        </button>
        <div className="min-w-0">
          <h2 className="text-[16px] sm:text-[22px] font-bold text-white tracking-tight">Activity</h2>
          <p className="hidden sm:block text-[13px] text-zinc-400">What the app has been doing.</p>
        </div>
      </div>
      <div className="flex items-center gap-2 self-end sm:self-auto">
        <button
          onClick={() => setActiveView("settings")}
          className="hidden sm:flex h-9 px-3 bg-white/[0.04] text-zinc-300 text-[12px] font-bold rounded-xl border border-white/5 hover:bg-white/10 hover:text-white transition-all items-center gap-1.5"
        >
          <ChevronLeft size={14} /> Settings
        </button>
        <button onClick={async () => {
          const ok = await confirm({ title: "Clear activity log?", message: "All entries will be discarded.", destructive: true });
          if (!ok) return;
          setLogs([]);
        }} className="h-8 sm:h-9 px-2.5 sm:px-4 bg-zinc-900 text-zinc-200 text-[11px] sm:text-[13px] font-bold rounded-xl border border-white/5 hover:bg-red-500/20 hover:text-red-400 hover:border-primary/50 transition-all flex items-center gap-1.5">
          <Trash2 size={13} /> Clear
        </button>
      </div>
    </header>

    <div className="flex-1 overflow-y-auto custom-scrollbar bg-black/50 rounded-xl sm:rounded-2xl border border-white/5 p-2 sm:p-4 space-y-0.5 sm:space-y-1 shadow-inner select-text cursor-text">
      {logs.length === 0 ? (
        <div className="h-full flex items-center justify-center text-zinc-600 text-[12px] sm:text-[14px] font-mono italic">
          Nothing yet.
        </div>
      ) : (
        [...logs].reverse().map((log) => (
          <div
            key={log.id ?? `${log.time}-${log.msg}`}
            className="flex flex-col sm:flex-row sm:items-start sm:gap-3 text-[10px] sm:text-[12px] font-mono group hover:bg-white/5 p-1 rounded-md transition-colors"
          >
            <div className="flex items-baseline gap-2 sm:gap-3 sm:shrink-0">
              <span className="text-zinc-600 sm:w-20 shrink-0">{log.time}</span>
              <span className={`sm:w-24 shrink-0 font-bold uppercase ${log.type === 'error' ? 'text-red-500' : log.type === 'success' ? 'text-primary' : log.type === 'warn' ? 'text-amber-500' : 'text-sky-300'}`}>
                [{log.type}]
              </span>
            </div>
            <span className="text-zinc-300 break-all sm:flex-1">{log.msg}</span>
          </div>
        ))
      )}
    </div>
  </div>
);
