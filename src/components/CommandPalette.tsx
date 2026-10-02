import React, { useState, useEffect, useRef, useMemo } from "react";
import { 
  Search, Server, Terminal, Folder, SplitSquareHorizontal, 
  Columns, Rows, Settings, Plus, X, Command, Play, Bookmark,
  Layers, LogOut, ArrowRight, FileCode
} from "lucide-react";
import { getActiveShortcut } from "../shortcuts";

export interface PaletteItem {
  id: string;
  category: "Session" | "Server" | "Action" | "Command";
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  shortcut?: string;
  action: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  servers: any[];
  sessions: { id: string; serverName: string; serverId: number }[];
  activeView: string;
  onSelectView: (viewId: string) => void;
  onConnectServer: (server: any) => void;
  onOpenQuickConnect: () => void;
  onOpenAddNode: () => void;
  onOpenSettings: () => void;
  onCloseSession: (sessionId: string) => void;
  commands?: { id: number; title: string; content: string }[];
  onExecuteCommand?: (cmd: string) => void;
  enableMonitoring?: boolean;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  servers,
  sessions,
  activeView,
  onSelectView,
  onConnectServer,
  onOpenQuickConnect,
  onOpenAddNode,
  onOpenSettings,
  onCloseSession,
  commands = [],
  onExecuteCommand,
  enableMonitoring = true,
}) => {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [];
    const isSessionActive = activeView.startsWith("session-");

    // 1. Session Actions (if in a session)
    if (isSessionActive) {
      list.push({
        id: "act-quick-open",
        category: "Action",
        title: "Quick Open / Edit Remote File",
        subtitle: "Search and open remote files in built-in editor",
        icon: <FileCode size={14} className="text-amber-400" />,
        shortcut: getActiveShortcut("quickOpenFile"),
        action: () => {
          window.dispatchEvent(new CustomEvent(`submarine-quick-open-file-${activeView}`));
        },
      });
      list.push({
        id: "act-new-term",
        category: "Action",
        title: "New Terminal Tab",
        subtitle: "Open additional shell in active session",
        icon: <Terminal size={14} className="text-primary" />,
        shortcut: getActiveShortcut("newTerminal"),
        action: () => {
          window.dispatchEvent(new CustomEvent(`submarine-new-terminal-${activeView}`));
        },
      });
      list.push({
        id: "act-split-h",
        category: "Action",
        title: "Split Terminal Horizontally",
        subtitle: "Side-by-side terminal split",
        icon: <Columns size={14} className="text-indigo-400" />,
        shortcut: getActiveShortcut("splitHorizontal"),
        action: () => {
          window.dispatchEvent(new CustomEvent(`submarine-split-terminal-${activeView}`, { detail: { orientation: "h" } }));
        },
      });
      list.push({
        id: "act-split-v",
        category: "Action",
        title: "Split Terminal Vertically",
        subtitle: "Stacked terminal split",
        icon: <Rows size={14} className="text-indigo-400" />,
        shortcut: getActiveShortcut("splitVertical"),
        action: () => {
          window.dispatchEvent(new CustomEvent(`submarine-split-terminal-${activeView}`, { detail: { orientation: "v" } }));
        },
      });
      list.push({
        id: "act-toggle-sftp",
        category: "Action",
        title: "Toggle SFTP File Explorer",
        subtitle: "Open or close SFTP workspace",
        icon: <Folder size={14} className="text-emerald-400" />,
        shortcut: getActiveShortcut("toggleSftp"),
        action: () => {
          window.dispatchEvent(new CustomEvent(`submarine-toggle-sftp-${activeView}`));
        },
      });
      list.push({
        id: "act-close-session",
        category: "Action",
        title: "Close Current Session",
        subtitle: "Disconnect and close tab",
        icon: <LogOut size={14} className="text-rose-400" />,
        shortcut: getActiveShortcut("closeSession"),
        action: () => {
          onCloseSession(activeView);
        },
      });
    }

    // 2. Global Actions & Navigation
    list.push({
      id: "act-quick-connect",
      category: "Action",
      title: "Quick Connect",
      subtitle: "Connect to an ad-hoc SSH host without saving",
      icon: <Terminal size={14} className="text-emerald-400" />,
      action: onOpenQuickConnect,
    });
    list.push({
      id: "act-add-node",
      category: "Action",
      title: "Add New Server",
      subtitle: "Configure and save a new SSH/SFTP node",
      icon: <Plus size={14} className="text-primary" />,
      action: onOpenAddNode,
    });
    list.push({
      id: "nav-nodes",
      category: "Action",
      title: "Go to: Servers & Hosts",
      subtitle: "Switch to servers grid view",
      icon: <Server size={14} className="text-primary" />,
      shortcut: getActiveShortcut("serversView"),
      action: () => onSelectView("nodes"),
    });
    list.push({
      id: "nav-library",
      category: "Action",
      title: "Go to: Library (Snippets & Notes)",
      subtitle: "Browse saved commands and runbooks",
      icon: <Bookmark size={14} className="text-amber-400" />,
      action: () => onSelectView("library"),
    });
    if (enableMonitoring !== false) {
      list.push({
        id: "nav-monitor",
        category: "Action",
        title: "Go to: Resource Monitor",
        subtitle: "Real-time CPU/RAM/Network dashboard",
        icon: <Layers size={14} className="text-emerald-400" />,
        action: () => onSelectView("monitor"),
      });
    }
    list.push({
      id: "nav-wall",
      category: "Action",
      title: "Go to: Session Wall",
      subtitle: "Multi-session tile pinboard",
      icon: <Columns size={14} className="text-purple-400" />,
      action: () => onSelectView("wall"),
    });
    list.push({
      id: "nav-vault",
      category: "Action",
      title: "Go to: Credential Vault",
      subtitle: "Manage saved SSH keys and credentials",
      icon: <Settings size={14} className="text-zinc-400" />,
      action: () => onSelectView("vault"),
    });
    list.push({
      id: "nav-logs",
      category: "Action",
      title: "Go to: Audit Logs",
      subtitle: "View application event logs",
      icon: <Terminal size={14} className="text-zinc-400" />,
      action: () => onSelectView("logs"),
    });
    list.push({
      id: "act-settings",
      category: "Action",
      title: "Settings & Customization",
      subtitle: "Manage theme, font size, sync and credentials",
      icon: <Settings size={14} className="text-zinc-400" />,
      action: onOpenSettings,
    });

    // 3. Active Sessions
    sessions.forEach((s) => {
      list.push({
        id: `sess-${s.id}`,
        category: "Session",
        title: `Jump to Session: ${s.serverName}`,
        subtitle: s.id === activeView ? "Currently active" : "Switch view",
        icon: <Layers size={14} className="text-indigo-400" />,
        action: () => onSelectView(s.id),
      });
    });

    // 4. Saved Servers
    servers.forEach((srv) => {
      list.push({
        id: `srv-${srv.id}`,
        category: "Server",
        title: srv.name || srv.host,
        subtitle: `${srv.username}@${srv.host}:${srv.port || 22}`,
        icon: <Server size={14} className="text-sky-400" />,
        action: () => onConnectServer(srv),
      });
    });

    // 5. Saved Snippet Commands
    if (isSessionActive && onExecuteCommand) {
      commands.forEach((c) => {
        list.push({
          id: `cmd-${c.id}`,
          category: "Command",
          title: `Run: ${c.title}`,
          subtitle: c.content.split("\n")[0],
          icon: <Play size={14} className="text-amber-400" />,
          action: () => onExecuteCommand(c.content),
        });
      });
    }

    return list;
  }, [servers, sessions, activeView, commands, onSelectView, onConnectServer, onOpenQuickConnect, onOpenAddNode, onOpenSettings, onCloseSession, onExecuteCommand]);

  // Filter items
  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.subtitle?.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
    );
  }, [items, query]);

  // Handle keyboard events
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, filteredItems.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % Math.max(1, filteredItems.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filteredItems.length > 0 && selectedIndex < filteredItems.length) {
        const item = filteredItems[selectedIndex];
        onClose();
        item.action();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  // Keep highlighted item in view
  useEffect(() => {
    if (listRef.current) {
      const selectedEl = listRef.current.children[selectedIndex] as HTMLElement;
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIndex]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center pt-20 bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-100"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-[#0f0f14] border border-white/10 rounded-xl shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Input Bar */}
        <div className="h-12 px-4 border-b border-white/10 bg-[#14141a] flex items-center gap-3">
          <Search size={16} className="text-primary shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command, server name, or action..."
            className="flex-1 bg-transparent text-sm text-white placeholder-zinc-500 focus:outline-none font-sans"
          />
          <kbd className="hidden sm:inline-flex items-center gap-0.5 px-2 py-0.5 rounded bg-white/5 border border-white/10 text-[10px] font-mono text-zinc-400">
            Esc
          </kbd>
        </div>

        {/* Results List */}
        <div
          ref={listRef}
          className="max-h-[60vh] overflow-y-auto p-2 space-y-1 no-scrollbar text-xs font-sans"
        >
          {filteredItems.length === 0 ? (
            <div className="py-12 text-center text-zinc-500 flex flex-col items-center gap-2">
              <Command size={24} className="opacity-30" />
              <span>No matching commands or servers found.</span>
            </div>
          ) : (
            filteredItems.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    onClose();
                    item.action();
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`w-full flex items-center justify-between p-2.5 rounded-lg text-left transition-all ${
                    isSelected
                      ? "bg-primary/15 border border-primary/30 text-white"
                      : "border border-transparent text-zinc-300 hover:bg-white/[0.04]"
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`p-1.5 rounded-md shrink-0 ${
                        isSelected ? "bg-primary/20" : "bg-white/[0.04]"
                      }`}
                    >
                      {item.icon}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-white truncate">
                          {item.title}
                        </span>
                        <span className="px-1.5 py-0.2 rounded text-[9px] font-mono uppercase bg-white/5 text-zinc-400">
                          {item.category}
                        </span>
                      </div>
                      {item.subtitle && (
                        <div className="text-[11px] text-zinc-400 truncate mt-0.5">
                          {item.subtitle}
                        </div>
                      )}
                    </div>
                  </div>
                  {item.shortcut && (
                    <kbd className="hidden sm:inline-block px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-[10px] font-mono text-zinc-400 shrink-0 ml-2">
                      {item.shortcut}
                    </kbd>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Footer info bar */}
        <div className="h-8 px-4 bg-[#0a0a0e] border-t border-white/5 flex items-center justify-between text-[10px] font-mono text-zinc-500">
          <div className="flex items-center gap-3">
            <span>↑↓ Navigate</span>
            <span>↵ Select</span>
            <span>Esc Close</span>
          </div>
          <span>SubTerm Command Palette</span>
        </div>
      </div>
    </div>
  );
};
