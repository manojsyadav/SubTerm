import React, { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Search,
  Folder,
  FolderUp,
  FileText,
  FileCode,
  File,
  X,
  CornerDownLeft,
  RefreshCw,
  ArrowRight,
  AlertCircle
} from "lucide-react";

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

interface QuickFilePickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  initialPath?: string;
  onSelectFile: (file: { path: string; name: string }) => void;
}

const isTextOrCodeFile = (name: string) => {
  return (
    /\.(ya?ml|json|toml|ini|conf|cfg|txt|md|sh|bash|zsh|env|py|jsx?|tsx?|html?|css|scss|xml|sql|rs|go|c|cpp|h|hpp|log|properties|lock|service|timer|crt|cer|pem|csr|key|pub|cnf|j2|tf|tfvars|csv)$/i.test(
      name
    ) ||
    /^(Dockerfile|Makefile|docker-compose|README|LICENSE|\.env|\.gitignore|\.bashrc|\.zshrc)$/i.test(
      name
    ) ||
    !name.includes(".")
  );
};

const getFileBadge = (name: string) => {
  const ext = name.split(".").pop()?.toLowerCase();
  if (!ext || ext === name.toLowerCase()) {
    if (name.toLowerCase().includes("docker")) return "DOCKER";
    return "FILE";
  }
  return ext.toUpperCase();
};

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const QuickFilePickerModal: React.FC<QuickFilePickerModalProps> = ({
  isOpen,
  onClose,
  sessionId,
  initialPath,
  onSelectFile,
}) => {
  const [currentPath, setCurrentPath] = useState<string>("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const fetchDir = async (path: string) => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await invoke<any>("sftp_list_dir", {
        sessionId,
        path: path || "",
      });
      if (res) {
        setCurrentPath(res.current_path || path || "/");
        const mapped: FileEntry[] = (res.entries || [])
          .filter((e: any) => e.name !== "." && e.name !== "..")
          .map((e: any) => ({
            name: e.name,
            path: e.path,
            isDir: !!e.is_dir,
            size: e.size || 0,
          }));
        // Sort directories first, then text files, then others
        mapped.sort((a, b) => {
          if (a.isDir && !b.isDir) return -1;
          if (!a.isDir && b.isDir) return 1;
          const aText = isTextOrCodeFile(a.name);
          const bText = isTextOrCodeFile(b.name);
          if (aText && !bText) return -1;
          if (!aText && bText) return 1;
          return a.name.localeCompare(b.name);
        });
        setEntries(mapped);
      }
    } catch (err: any) {
      console.warn("Failed to list SFTP dir:", err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      let start = initialPath ? initialPath.trim() : "";
      if (start && !start.endsWith("/")) {
        // If initialPath looks like a file, start from its directory
        const parts = start.split("/");
        if (parts.length > 1) {
          parts.pop();
          start = parts.join("/") || "/";
        }
      }
      fetchDir(start);
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [isOpen, sessionId, initialPath]);

  const goUp = () => {
    if (!currentPath || currentPath === "/") return;
    const trimmed = currentPath.replace(/\/+$/, "");
    const lastSlash = trimmed.lastIndexOf("/");
    const parent = lastSlash <= 0 ? "/" : trimmed.slice(0, lastSlash);
    setQuery("");
    fetchDir(parent);
  };

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [entries, query]);

  // Option to directly open/create the query as an exact path if user typed something
  const canDirectOpen = useMemo(() => {
    const q = query.trim();
    if (!q) return false;
    // If it looks like a path or specific file that doesn't match an existing folder
    const exactMatch = entries.find((e) => e.name.toLowerCase() === q.toLowerCase());
    return !exactMatch || !exactMatch.isDir;
  }, [query, entries]);

  const totalOptionsCount = filteredEntries.length + (canDirectOpen ? 1 : 0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, currentPath]);

  const handleSelect = (entry: FileEntry) => {
    if (entry.isDir) {
      setQuery("");
      fetchDir(entry.path);
    } else {
      onSelectFile({ path: entry.path, name: entry.name });
      onClose();
    }
  };

  const handleDirectOpen = () => {
    const q = query.trim();
    if (!q) return;
    let fullPath = q;
    if (!q.startsWith("/") && !q.startsWith("~")) {
      fullPath = currentPath.endsWith("/") ? `${currentPath}${q}` : `${currentPath}/${q}`;
    }
    const fileName = fullPath.split("/").filter(Boolean).pop() || fullPath;
    onSelectFile({ path: fullPath, name: fileName });
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, totalOptionsCount));
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + totalOptionsCount) % Math.max(1, totalOptionsCount));
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (canDirectOpen && selectedIndex === 0) {
        handleDirectOpen();
        return;
      }
      const entryIdx = canDirectOpen ? selectedIndex - 1 : selectedIndex;
      if (entryIdx >= 0 && entryIdx < filteredEntries.length) {
        handleSelect(filteredEntries[entryIdx]);
      } else if (canDirectOpen) {
        handleDirectOpen();
      }
      return;
    }

    if (e.key === "Backspace" && !query && currentPath && currentPath !== "/") {
      e.preventDefault();
      goUp();
      return;
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 sm:pt-24 bg-black/75 backdrop-blur-xs p-4 animate-in fade-in duration-100"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-[#0f1117] border border-white/10 rounded-xl shadow-2xl flex flex-col overflow-hidden text-zinc-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search header */}
        <div className="p-3 border-b border-white/10 flex items-center gap-2.5 bg-[#141822]">
          <Search size={16} className="text-indigo-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a file name (e.g. services.yaml) or custom path..."
            className="flex-1 bg-transparent text-sm text-white placeholder-zinc-500 focus:outline-none font-mono"
            autoFocus
          />
          {loading && <RefreshCw size={14} className="text-zinc-400 animate-spin shrink-0" />}
          {query && (
            <button
              onClick={() => setQuery("")}
              className="p-1 hover:bg-white/10 rounded text-zinc-400 hover:text-white"
              title="Clear"
            >
              <X size={14} />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1 hover:bg-white/10 rounded text-zinc-400 hover:text-white"
            title="Close (Esc)"
          >
            <X size={16} />
          </button>
        </div>

        {/* Current remote directory breadcrumb & actions */}
        <div className="px-3 py-1.5 bg-[#0b0c10] border-b border-white/5 flex items-center justify-between text-xs font-mono text-zinc-400">
          <div className="flex items-center gap-1.5 truncate">
            <span className="text-zinc-500 select-none">Remote:</span>
            <span className="text-indigo-300 truncate font-semibold">{currentPath || "/"}</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {currentPath && currentPath !== "/" && (
              <button
                onClick={goUp}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-white/10 text-zinc-300 hover:text-white transition-colors text-[11px]"
                title="Go up to parent directory (Backspace)"
              >
                <FolderUp size={12} className="text-amber-400" />
                <span>.. Up</span>
              </button>
            )}
            <button
              onClick={() => fetchDir(currentPath)}
              className="p-1 hover:bg-white/10 rounded text-zinc-400 hover:text-white transition-colors"
              title="Refresh directory"
            >
              <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>

        {/* Error notice */}
        {error && (
          <div className="p-2.5 mx-3 mt-2 bg-rose-500/10 border border-rose-500/20 rounded-lg flex items-center gap-2 text-rose-300 text-xs">
            <AlertCircle size={14} className="shrink-0" />
            <span className="truncate">{error}</span>
          </div>
        )}

        {/* Results list */}
        <div
          ref={listRef}
          className="max-h-[55vh] overflow-y-auto p-1.5 font-mono text-xs no-scrollbar divide-y divide-white/5"
        >
          {/* Direct path execution option */}
          {canDirectOpen && (
            <button
              onClick={handleDirectOpen}
              className={`w-full flex items-center justify-between p-2 rounded-lg text-left transition-colors mb-1 ${
                selectedIndex === 0 ? "bg-indigo-600/30 border border-indigo-500/40 text-white" : "hover:bg-white/5 text-zinc-300"
              }`}
            >
              <div className="flex items-center gap-2 truncate">
                <ArrowRight size={13} className="text-indigo-400 shrink-0" />
                <span className="text-indigo-300 truncate">
                  Edit custom path:{" "}
                  <strong className="text-white font-semibold">
                    {query.startsWith("/") || query.startsWith("~")
                      ? query
                      : `${currentPath.replace(/\/+$/, "")}/${query}`}
                  </strong>
                </span>
              </div>
              <span className="text-[10px] text-indigo-300/80 px-1.5 py-0.5 rounded bg-indigo-500/20 shrink-0">
                Press Enter
              </span>
            </button>
          )}

          {/* List items */}
          {filteredEntries.map((entry, idx) => {
            const itemIndex = canDirectOpen ? idx + 1 : idx;
            const isSelected = selectedIndex === itemIndex;
            const isText = isTextOrCodeFile(entry.name);
            const badge = !entry.isDir ? getFileBadge(entry.name) : null;

            return (
              <button
                key={entry.path}
                onClick={() => handleSelect(entry)}
                className={`w-full flex items-center justify-between p-2 rounded-lg text-left transition-colors ${
                  isSelected ? "bg-white/10 text-white font-medium" : "hover:bg-white/5 text-zinc-300"
                }`}
              >
                <div className="flex items-center gap-2.5 truncate">
                  {entry.isDir ? (
                    <Folder size={14} className="text-amber-400 shrink-0" />
                  ) : isText ? (
                    <FileCode size={14} className="text-indigo-400 shrink-0" />
                  ) : (
                    <File size={14} className="text-zinc-500 shrink-0" />
                  )}
                  <span className={`truncate ${entry.isDir ? "text-amber-200" : isText ? "text-zinc-100" : "text-zinc-400"}`}>
                    {entry.name}
                  </span>
                  {badge && (
                    <span className="text-[9px] px-1 py-0.2 rounded bg-white/5 text-zinc-400 border border-white/5 shrink-0">
                      {badge}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-zinc-500">
                    {entry.isDir ? "Folder" : formatSize(entry.size)}
                  </span>
                  {entry.isDir ? (
                    <span className="text-[10px] text-zinc-500">→</span>
                  ) : (
                    <span className="text-[10px] text-indigo-400 opacity-60">Edit</span>
                  )}
                </div>
              </button>
            );
          })}

          {!loading && filteredEntries.length === 0 && !canDirectOpen && (
            <div className="p-6 text-center text-zinc-500 text-xs">
              No files found matching &quot;{query}&quot;
            </div>
          )}
        </div>

        {/* Footer shortcuts hint */}
        <div className="p-2 border-t border-white/10 bg-[#0d0e14] flex items-center justify-between text-[11px] text-zinc-500">
          <div className="flex items-center gap-3">
            <span>
              <kbd className="px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-[10px] text-zinc-400">↑↓</kbd> navigate
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-[10px] text-zinc-400">Enter</kbd> open / select
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-[10px] text-zinc-400">Backspace</kbd> go up
            </span>
          </div>
          <div>
            <kbd className="px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-[10px] text-zinc-400">Esc</kbd> close
          </div>
        </div>
      </div>
    </div>
  );
};
