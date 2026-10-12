import { invoke } from "@tauri-apps/api/core";
import { Shield, Search, Plus, TerminalSquare, StickyNote, Play, Edit2, Trash2 } from "lucide-react";
import type { SavedCommand, Note, Server } from "../types";
import type { CommandEditPanelProps } from "./VaultEditPanels";

// The "Library" tab — merged Commands + Notes view — extracted out of
// DesktopApp.tsx (part of the ongoing decomposition tracked in TODO.md).
// Pure extraction: all state (query, active tab, which panel is open) stays
// lifted in DesktopApp.tsx, passed down as props; no behavior change.

export interface LibraryViewProps {
  libraryQuery: string;
  setLibraryQuery: (q: string) => void;
  libraryTab: "commands" | "notes";
  setLibraryTab: (t: "commands" | "notes") => void;
  commands: SavedCommand[];
  notes: Note[];
  servers: Server[];
  sessions: unknown[];
  confirm: (opts: { title: string; message: string; destructive?: boolean }) => Promise<boolean>;
  refreshCommands: () => void;
  refreshNotes: () => void;
  bumpSync: () => void;
  handleExecuteSnippet: (content: string, title?: string) => void;
  setEditCommandData: (d: CommandEditPanelProps["data"]) => void;
  setIsCommandPanelOpen: (b: boolean) => void;
  setEditNoteData: (d: { id: number | null; title: string; body: string }) => void;
  setIsNotePanelOpen: (b: boolean) => void;
}

export const LibraryView = ({
  libraryQuery, setLibraryQuery, libraryTab, setLibraryTab,
  commands, notes, servers, sessions, confirm,
  refreshCommands, refreshNotes, bumpSync, handleExecuteSnippet,
  setEditCommandData, setIsCommandPanelOpen, setEditNoteData, setIsNotePanelOpen,
}: LibraryViewProps) => {
  const q = libraryQuery.trim().toLowerCase();
  const filteredCommands = q
    ? commands.filter(c =>
        (c.title || "").toLowerCase().includes(q) ||
        (c.content || "").toLowerCase().includes(q) ||
        (c.tags || "").toLowerCase().includes(q))
    : commands;
  const filteredNotes = q
    ? notes.filter(n =>
        (n.title || "").toLowerCase().includes(q) ||
        (n.body || "").toLowerCase().includes(q))
    : notes;
  const onCommandsTab = libraryTab === "commands";
  const addLabel = onCommandsTab ? "Add Command" : "Add Note";
  const openAdd = () => {
    if (onCommandsTab) {
      setEditCommandData({ id: null, title: "", content: "", serverId: null, tags: "" });
      setIsCommandPanelOpen(true);
    } else {
      setEditNoteData({ id: null, title: "", body: "" });
      setIsNotePanelOpen(true);
    }
  };

  return (
    <div className="flex-1 flex flex-col p-4 sm:p-8 space-y-5 sm:space-y-6 animate-in overflow-y-auto custom-scrollbar">
      <header className="flex flex-col gap-3 border-b border-zinc-700 pb-5 sm:pb-6 shrink-0">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
          <div className="min-w-0">
            <h2 className="text-[18px] sm:text-[22px] font-bold text-white tracking-tight flex items-center gap-2">
              Snippets
              <span
                title="All entries are AES-256-GCM encrypted inside the current profile vault."
                className="inline-flex items-center gap-1 h-5 px-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-[9px] font-bold uppercase tracking-wider text-emerald-300"
              >
                <Shield size={9} /> Vault-locked
              </span>
            </h2>
            <p className="hidden sm:block text-[13px] text-zinc-400">
              Reusable snippets and freeform notes — encrypted with your profile key.
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
              <input
                type="text"
                value={libraryQuery}
                onChange={(e) => setLibraryQuery(e.target.value)}
                placeholder="Search title or content…"
                className="h-9 pl-7 pr-3 w-44 sm:w-56 bg-black/40 border border-white/10 rounded-xl text-[12px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-primary/40"
              />
            </div>
            <button
              onClick={openAdd}
              title={addLabel}
              className="h-9 px-3 sm:px-4 bg-primary text-black text-[12px] sm:text-[13px] font-bold rounded-xl shadow-lg shadow-primary/20 flex items-center gap-1.5 transition-all hover:brightness-110 self-start sm:self-auto"
            >
              <Plus size={14} /> {addLabel}
            </button>
          </div>
        </div>
        {/* Segmented control — Commands vs Notes. Counts sit
            inside each pill so switching contexts is a single
            glance. */}
        <div className="flex items-center gap-1 self-start bg-black/30 border border-white/5 rounded-xl p-0.5">
          <button
            onClick={() => setLibraryTab("commands")}
            className={`h-8 px-3 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 ${
              onCommandsTab
                ? "bg-primary/15 text-primary shadow-inner"
                : "text-zinc-400 hover:text-zinc-100"
            }`}
          >
            <TerminalSquare size={12} /> Commands
            <span className={`text-[9px] font-bold ${onCommandsTab ? "text-primary/70" : "text-zinc-600"}`}>
              {filteredCommands.length}
            </span>
          </button>
          <button
            onClick={() => setLibraryTab("notes")}
            className={`h-8 px-3 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 ${
              !onCommandsTab
                ? "bg-primary/15 text-primary shadow-inner"
                : "text-zinc-400 hover:text-zinc-100"
            }`}
          >
            <StickyNote size={12} /> Notes
            <span className={`text-[9px] font-bold ${!onCommandsTab ? "text-primary/70" : "text-zinc-600"}`}>
              {filteredNotes.length}
            </span>
          </button>
        </div>
      </header>

      {onCommandsTab ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pb-10">
          {filteredCommands.length === 0 ? (
            <div className="col-span-full py-12 text-center text-zinc-500 text-[14px] italic border border-dashed border-white/10 rounded-2xl">
              {q ? `No commands match "${libraryQuery}".` : "No commands yet."}
            </div>
          ) : (
            filteredCommands.map(cmd => (
              <div key={cmd.id} className="bg-[#16161a] border border-white/5 rounded-2xl p-4 flex flex-col group relative overflow-hidden shadow-inner h-[170px]">
                <div className="flex justify-between items-start mb-1">
                  <h3 className="text-[16px] font-bold text-primary tracking-tight truncate flex-1">{cmd.title}</h3>
                  <div className="flex items-center gap-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                    {sessions.length > 0 && (
                      <button
                        onClick={() => handleExecuteSnippet(cmd.content, cmd.title)}
                        title="Run command in terminal"
                        className="px-2 py-0.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary transition-colors flex items-center gap-1 text-[11px] font-bold"
                      >
                        <Play size={10} className="fill-primary" />
                        <span>Run</span>
                      </button>
                    )}
                    <button onClick={() => { setEditCommandData(cmd); setIsCommandPanelOpen(true); }} className="text-zinc-500 hover:text-white transition-colors"><Edit2 size={14} /></button>
                    <button onClick={async () => {
                      const ok = await confirm({ title: "Delete command?", message: `“${cmd.title}” will be removed.`, destructive: true });
                      if (!ok) return;
                      invoke("delete_command", { id: cmd.id }).then(() => { refreshCommands(); bumpSync(); });
                    }} className="text-zinc-500 hover:text-red-500 transition-colors"><Trash2 size={14} /></button>
                  </div>
                </div>
                {(cmd.serverId || (cmd.tags && cmd.tags.trim())) && (
                  <div className="flex flex-wrap items-center gap-1 mb-2">
                    {cmd.serverId ? (
                      <span className="px-1.5 py-0.5 rounded-md bg-sky-500/10 text-sky-300 text-[9.5px] font-bold uppercase tracking-wide">
                        {servers.find((s) => s.id === cmd.serverId)?.name || `Server #${cmd.serverId}`}
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded-md bg-white/5 text-zinc-400 text-[9.5px] font-bold uppercase tracking-wide">Global</span>
                    )}
                    {(cmd.tags || "").split(",").map((t: string) => t.trim()).filter(Boolean).map((t: string) => (
                      <span key={t} className="px-1.5 py-0.5 rounded-md bg-violet-500/10 text-violet-300 text-[9.5px] font-bold">#{t}</span>
                    ))}
                  </div>
                )}
                <div className="bg-black/30 rounded-xl p-3 border border-white/5 flex-1 relative group-hover:border-primary/20 transition-colors overflow-hidden">
                  <pre className="text-[12px] text-zinc-400 font-mono whitespace-pre-wrap leading-relaxed line-clamp-3">{cmd.content}</pre>
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pb-10">
          {filteredNotes.length === 0 ? (
            <div className="col-span-full py-12 text-center text-zinc-500 text-[14px] italic border border-dashed border-white/10 rounded-2xl">
              {q ? `No notes match "${libraryQuery}".` : "No notes yet."}
            </div>
          ) : (
            filteredNotes.map(n => (
              <div key={n.id} className="bg-[#16161a] border border-white/5 rounded-2xl p-4 flex flex-col group relative overflow-hidden shadow-inner h-[170px]">
                <div className="flex justify-between items-start mb-2 gap-2">
                  <h3 className="text-[15px] font-bold text-primary tracking-tight truncate flex-1">{n.title || "Untitled"}</h3>
                  <div className="flex items-center gap-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0">
                    <button onClick={() => { setEditNoteData({ id: n.id, title: n.title || "", body: n.body || "" }); setIsNotePanelOpen(true); }} className="text-zinc-500 hover:text-white transition-colors"><Edit2 size={14} /></button>
                    <button onClick={async () => {
                      const ok = await confirm({ title: "Delete note?", message: `“${n.title || "Untitled"}” will be removed.`, destructive: true });
                      if (!ok) return;
                      invoke("delete_note", { id: n.id }).then(() => { refreshNotes(); bumpSync(); });
                    }} className="text-zinc-500 hover:text-red-500 transition-colors"><Trash2 size={14} /></button>
                  </div>
                </div>
                <div className="bg-black/30 rounded-xl p-3 border border-white/5 flex-1 relative group-hover:border-primary/20 transition-colors overflow-hidden cursor-pointer"
                     onClick={() => { setEditNoteData({ id: n.id, title: n.title || "", body: n.body || "" }); setIsNotePanelOpen(true); }}>
                  <pre className="text-[12px] text-zinc-400 whitespace-pre-wrap leading-relaxed line-clamp-4 font-sans">{n.body}</pre>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
