import React, { useState, useEffect, useRef } from "react";
import {
  Bookmark,
  Star,
  Folder,
  Trash2,
  Plus,
  ExternalLink,
  Search,
  Check,
  Compass,
} from "lucide-react";

export interface SftpBookmark {
  id: string;
  name: string;
  path: string;
  isRemote: boolean;
}

const STORAGE_KEY = "subterm-sftp-bookmarks";

export function loadSftpBookmarks(): SftpBookmark[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (err) {
    console.error("Failed to load SFTP bookmarks", err);
  }
  return [];
}

export function saveSftpBookmarks(bookmarks: SftpBookmark[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
    window.dispatchEvent(new CustomEvent("subterm-bookmarks-updated"));
  } catch (err) {
    console.error("Failed to save SFTP bookmarks", err);
  }
}

interface SftpBookmarksPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  currentPath: string;
  isRemote: boolean;
  onNavigate: (path: string) => void;
}

export function SftpBookmarksPopover({
  isOpen,
  onClose,
  currentPath,
  isRemote,
  onNavigate,
}: SftpBookmarksPopoverProps) {
  const [bookmarks, setBookmarks] = useState<SftpBookmark[]>(loadSftpBookmarks);
  const [search, setSearch] = useState("");
  const [customName, setCustomName] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Sync with storage changes
  useEffect(() => {
    const handleUpdate = () => setBookmarks(loadSftpBookmarks());
    window.addEventListener("subterm-bookmarks-updated", handleUpdate);
    return () => window.removeEventListener("subterm-bookmarks-updated", handleUpdate);
  }, []);

  // Close on outside click or Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", handleDown);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleDown);
      window.removeEventListener("keydown", handleKey);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const currentNormalized = currentPath.replace(/\/+$/, "") || "/";
  const isCurrentBookmarked = bookmarks.some(
    (b) => b.isRemote === isRemote && (b.path.replace(/\/+$/, "") || "/") === currentNormalized
  );

  // System quick jumps
  const systemQuickJumps: { name: string; path: string; desc: string }[] = isRemote
    ? [
        { name: "Root", path: "/", desc: "Root filesystem" },
        { name: "Home (~)", path: "~", desc: "User home directory" },
        { name: "System Logs", path: "/var/log", desc: "Service and kernel logs" },
        { name: "Configuration", path: "/etc", desc: "System configuration files" },
        { name: "Web Root", path: "/var/www", desc: "HTML / Nginx / Apache sites" },
        { name: "Opt / Apps", path: "/opt", desc: "Third-party application software" },
        { name: "Temp Files", path: "/tmp", desc: "Temporary files" },
      ]
    : [
        { name: "Root / Drive", path: "/", desc: "Filesystem root" },
        { name: "User Home (~)", path: "~", desc: "User profile directory" },
        { name: "Temp Files", path: "/tmp", desc: "Temporary workspace" },
      ];

  const handleToggleCurrent = () => {
    if (isCurrentBookmarked) {
      const next = bookmarks.filter(
        (b) => !(b.isRemote === isRemote && (b.path.replace(/\/+$/, "") || "/") === currentNormalized)
      );
      saveSftpBookmarks(next);
      setBookmarks(next);
    } else {
      const defaultName = currentPath.split(/[\\/]/).filter(Boolean).pop() || "Root";
      const newBookmark: SftpBookmark = {
        id: Date.now().toString(),
        name: customName.trim() || defaultName,
        path: currentPath,
        isRemote,
      };
      const next = [...bookmarks, newBookmark];
      saveSftpBookmarks(next);
      setBookmarks(next);
      setShowAddForm(false);
      setCustomName("");
    }
  };

  const handleDeleteBookmark = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = bookmarks.filter((b) => b.id !== id);
    saveSftpBookmarks(next);
    setBookmarks(next);
  };

  const filteredBookmarks = bookmarks
    .filter((b) => b.isRemote === isRemote)
    .filter(
      (b) =>
        b.name.toLowerCase().includes(search.toLowerCase()) ||
        b.path.toLowerCase().includes(search.toLowerCase())
    );

  const filteredQuickJumps = systemQuickJumps.filter(
    (q) =>
      q.name.toLowerCase().includes(search.toLowerCase()) ||
      q.path.toLowerCase().includes(search.toLowerCase()) ||
      q.desc.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div
      ref={popoverRef}
      className="absolute top-8 right-0 z-50 w-72 bg-[#121217]/95 border border-white/10 rounded-xl shadow-2xl backdrop-blur-md p-2.5 text-xs text-zinc-200 select-none animate-in fade-in zoom-in-95 duration-100 font-sans"
    >
      {/* Header */}
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-white/5">
        <div className="flex items-center gap-1.5 font-bold text-white text-[11px]">
          <Bookmark size={13} className="text-primary" />
          <span>Directory Bookmarks</span>
        </div>
        <button
          type="button"
          onClick={handleToggleCurrent}
          className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
            isCurrentBookmarked
              ? "bg-amber-500/20 text-amber-300 hover:bg-amber-500/30"
              : "bg-white/[0.06] text-zinc-300 hover:bg-white/10 hover:text-white"
          }`}
          title={isCurrentBookmarked ? "Remove current folder from bookmarks" : "Bookmark current directory"}
        >
          <Star
            size={11}
            className={isCurrentBookmarked ? "text-amber-400 fill-amber-400" : "text-zinc-400"}
          />
          <span>{isCurrentBookmarked ? "Starred" : "Star Folder"}</span>
        </button>
      </div>

      {/* Search Filter */}
      <div className="relative mb-2">
        <Search size={11} className="absolute left-2 top-2 text-zinc-500" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter bookmarks or quick paths…"
          className="w-full h-7 pl-7 pr-2 bg-black/40 border border-white/10 rounded-lg text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-primary/50"
        />
      </div>

      {/* Bookmarked Folders Section */}
      <div className="max-h-56 overflow-y-auto space-y-2 no-scrollbar pr-0.5">
        <div>
          <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider px-1 mb-1 flex items-center justify-between">
            <span>Saved Favorites ({filteredBookmarks.length})</span>
          </div>

          {filteredBookmarks.length === 0 ? (
            <div className="py-2.5 px-2 text-center text-[10px] text-zinc-500 border border-dashed border-white/5 rounded-lg">
              No saved folders yet. Click <span className="text-amber-400">Star Folder</span> above.
            </div>
          ) : (
            <div className="space-y-0.5">
              {filteredBookmarks.map((b) => {
                const isCurrent = (b.path.replace(/\/+$/, "") || "/") === currentNormalized;
                return (
                  <div
                    key={b.id}
                    onClick={() => {
                      onNavigate(b.path);
                      onClose();
                    }}
                    className={`group flex items-center justify-between px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${
                      isCurrent
                        ? "bg-primary/20 text-white font-medium"
                        : "hover:bg-white/[0.06] text-zinc-300 hover:text-white"
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate min-w-0">
                      <Star size={11} className="text-amber-400 fill-amber-400 shrink-0" />
                      <div className="truncate">
                        <div className="text-[11px] leading-tight truncate">{b.name}</div>
                        <div className="text-[9px] text-zinc-500 font-mono truncate">{b.path}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {isCurrent && <Check size={11} className="text-primary" />}
                      <button
                        type="button"
                        onClick={(e) => handleDeleteBookmark(b.id, e)}
                        className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 rounded transition-opacity"
                        title="Delete bookmark"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* System Quick Jumps Section */}
        <div>
          <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider px-1 mb-1 mt-2 flex items-center gap-1">
            <Compass size={10} />
            <span>Standard Quick Jumps</span>
          </div>
          <div className="space-y-0.5">
            {filteredQuickJumps.map((q) => {
              const isCurrent = (q.path.replace(/\/+$/, "") || "/") === currentNormalized;
              return (
                <div
                  key={q.path}
                  onClick={() => {
                    onNavigate(q.path);
                    onClose();
                  }}
                  className={`group flex items-center justify-between px-2 py-1 rounded-lg cursor-pointer transition-colors ${
                    isCurrent
                      ? "bg-primary/20 text-white font-medium"
                      : "hover:bg-white/[0.06] text-zinc-300 hover:text-white"
                  }`}
                >
                  <div className="flex items-center gap-2 truncate min-w-0">
                    <Folder size={11} className="text-indigo-400 shrink-0" />
                    <div className="truncate">
                      <div className="text-[11px] leading-tight truncate">{q.name}</div>
                      <div className="text-[9px] text-zinc-500 font-mono truncate">{q.path}</div>
                    </div>
                  </div>
                  {isCurrent && <Check size={11} className="text-primary shrink-0" />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
