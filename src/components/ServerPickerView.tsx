import { useMemo, useState, type ReactNode } from "react";
import { Search, Plus } from "lucide-react";
import type { Server } from "../types";

interface ServerPickerViewProps {
  title: string;
  subtitle: string;
  icon: ReactNode;
  servers: Server[];
  /** Which saved servers belong on this page. */
  include: (s: Server) => boolean;
  actionLabel: string;
  onOpen: (s: Server) => void;
  addLabel?: string;
  onAdd?: () => void;
  emptyText: string;
}

// Shared "pick a saved server and open it" page used by SFTP and RDP. It is a
// flat, searchable list on purpose: folders and bulk actions stay on the
// Servers page, this page is a one-click shortcut to a single activity.
export const ServerPickerView = ({
  title, subtitle, icon, servers, include, actionLabel, onOpen, addLabel, onAdd, emptyText,
}: ServerPickerViewProps) => {
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return servers
      .filter(include)
      .filter((s) => !q || `${s.name} ${s.host} ${s.username ?? ""}`.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [servers, include, query]);

  const total = useMemo(() => servers.filter(include).length, [servers, include]);

  return (
    <div className="flex-1 flex flex-col p-4 sm:p-8 space-y-6 animate-in overflow-y-auto custom-scrollbar">
      <header className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 border-b border-zinc-700 pb-5 shrink-0">
        <div className="min-w-0">
          <h2 className="text-[18px] sm:text-[22px] font-bold text-white tracking-tight flex items-center gap-2">
            <span className="text-primary">{icon}</span>
            {title}
          </h2>
          <p className="hidden sm:block text-[13px] text-zinc-400">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search servers"
              aria-label="Search servers"
              className="h-9 w-48 sm:w-56 pl-8 pr-2 rounded-xl bg-black/40 border border-white/10 text-xs text-white placeholder:text-zinc-600 outline-none focus:border-primary/50"
            />
          </div>
          {onAdd && (
            <button
              type="button"
              onClick={onAdd}
              className="h-9 px-3 rounded-xl bg-primary/15 border border-primary/30 text-primary text-xs font-bold hover:bg-primary/25 flex items-center gap-1.5"
            >
              <Plus size={13} /> {addLabel}
            </button>
          )}
        </div>
      </header>

      {total === 0 ? (
        <p className="text-sm text-zinc-500 py-10 text-center">{emptyText}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-zinc-500 py-10 text-center">No servers match "{query}".</p>
      ) : (
        <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onOpen(s)}
              className="text-left p-4 rounded-2xl bg-[#121215] border border-white/5 hover:border-primary/40 hover:bg-white/[0.03] transition-colors group"
            >
              <div className="text-sm font-bold text-white truncate">{s.name}</div>
              <div className="text-xs text-zinc-500 font-mono truncate mt-0.5">
                {s.username ? `${s.username}@` : ""}{s.host}:{s.port}
              </div>
              <div className="mt-3 text-[11px] font-bold uppercase tracking-wider text-primary opacity-70 group-hover:opacity-100">
                {actionLabel}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
