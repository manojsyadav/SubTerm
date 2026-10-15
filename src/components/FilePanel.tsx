import { useFeatureFlag } from "../featureFlags";
import React, { useState, useEffect, useRef, useImperativeHandle, forwardRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  Folder, File, ArrowUp, RefreshCw, Trash2, Edit3, Shield,
  X, ChevronUp, ChevronDown, Plus, MoreVertical, FolderSearch,
  Download, Upload, ExternalLink, Move, CheckSquare, Square, Search,
  TerminalSquare, FileCode, Archive, Copy, Check, Bookmark, Star,
  Eye, EyeOff, GitCompare, FolderTree, Compass,
} from "lucide-react";
import { FileEntry, FileProvider } from "../fs/types";
import { toCssPoint } from "../terminal/dropPaths";
import { useConfirm, useOverwritePrompt, OverwriteChoice, OverwritePromptOptions } from "../ui/confirm";
import { IS_MOBILE_OS } from "../util/platform";
import { QuickEditorModal } from "./QuickEditorModal";
import { SftpBookmarksPopover, loadSftpBookmarks } from "./SftpBookmarksPopover";
import { DirectoryTree } from "./DirectoryTree";
import { getTerminalCwd, onTerminalCwdChange } from "../terminal/cwd";
import { archiveKind } from "../fs/archive";
import { useElementWidth } from "../hooks/useViewport";
import { canMoveInto, rulesFor, takenNames } from "../fs/moveRules";
import { pathCrumbs } from "../fs/pathCrumbs";

// Batch overwrite state shared across items in a single download/upload run.
// Once the user picks "Overwrite all" or "Skip all" the kind is sticky and we
// stop prompting; "ask" means we prompt on each individual conflict. Mutated
// in place inside the helper so the loop sees updates immediately.
type OverwriteBatchKind = "ask" | "overwrite-all" | "skip-all";
interface OverwriteBatch { kind: OverwriteBatchKind; }

// Run a single transfer that may trip the backend's `EXISTS:<path>` sentinel.
// First attempt is always with overwrite=false unless the batch state already
// says "overwrite all". On EXISTS: consult batch state, prompt the user if
// needed, then either retry with overwrite=true or skip.
async function transferWithOverwriteCheck(
  invokeFn: (overwrite: boolean) => Promise<void>,
  name: string,
  direction: "download" | "upload",
  batchSize: number,
  batch: OverwriteBatch,
  overwritePrompt: (opts: OverwritePromptOptions) => Promise<OverwriteChoice>,
  meta?: { localPath?: string; remotePath?: string; sessionId?: string }
): Promise<"done" | "skipped" | "cancelled"> {
  if (batch.kind === "overwrite-all") {
    await invokeFn(true);
    return "done";
  }
  try {
    await invokeFn(false);
    return "done";
  } catch (err) {
    const msg = String(err);
    if (!msg.startsWith("EXISTS:")) throw err;
    if (batch.kind === "skip-all") return "skipped";
    const choice = await overwritePrompt({
      name,
      direction,
      batchSize,
      localPath: meta?.localPath,
      remotePath: meta?.remotePath,
      sessionId: meta?.sessionId,
    });
    if (choice === "cancel") return "cancelled";
    if (choice === "skip") return "skipped";
    if (choice === "skip-all") { batch.kind = "skip-all"; return "skipped"; }
    if (choice === "overwrite-all") batch.kind = "overwrite-all";
    await invokeFn(true);
    return "done";
  }
}

// Generic two-mode file panel. Drives all I/O through a `FileProvider` so
// the same component renders either the local filesystem or the remote SFTP
// tree. Drag-out and drop integration are handled by the parent workspace —
// FilePanel just emits lifecycle callbacks.

type SortColumn = "name" | "size" | "modified" | "owner" | "permissions";
interface SortState { column: SortColumn; asc: boolean; }
interface SftpOwner { uid: number; name: string; }
interface SftpOwnerLookup {
  owners: SftpOwner[];
  status: "complete" | "transient_error" | "unsupported";
}

const listFailures = (failures: string[]) =>
  failures.length > 3
    ? `${failures.slice(0, 3).join(", ")} +${failures.length - 3} more`
    : failures.join(", ");

export interface ActiveDrag {
  /** "local" / "remote" in the normal view; custom ids (see FilePanelProps.paneId) in the dual-remote view. */
  paneId: string;
  entry: FileEntry;
  items: FileEntry[];
  x: number;
  y: number;
}

export interface FilePanelProps {
  provider: FileProvider;
  /** True when the underlying session is disconnected — UI is dimmed and ops are blocked. */
  disabled?: boolean;
  /** Optional session id to scope OS drag-drop events (Tauri fires them globally). */
  sessionId?: string;
  /** Notifies the parent of an active cross-pane drag. */
  onDragMove: (drag: ActiveDrag | null) => void;
  /**
   * Optional starting directory. Overrides the provider's home. If listing it
   * fails (e.g. the saved dir was removed since last session), the panel falls
   * back to the provider's home without surfacing the error.
   */
  initialPath?: string;
  /** Fires after every successful navigation — workspace uses it to persist. */
  onPathChange?: (path: string) => void;
  /**
   * Live read of whatever directory the *other* pane is currently in. Wired
   * from SftpWorkspace via the sibling's FilePanelHandle. Used by the remote
   * pane's download action: if the local pane has a directory open, the
   * download lands there directly instead of popping a folder picker.
   */
  getOppositeDir?: () => string | undefined;
  /** Optional server ID for scoping bookmarks and settings per server. */
  serverId?: number | string;
  /** Optional active profile for scoping bookmarks per profile. */
  profile?: string;
  /** Focused PTY terminal ID. */
  terminalId?: string;
  /** Compact layout: reveal terminal. */
  onRevealTerminal?: () => void;
  /**
   * Opens the cross-pane file diff viewer for `entry` against the
   * same-named file in the opposite pane's current directory. Wired from
   * SftpWorkspace, which owns both panes and the FileDiffModal instance —
   * omitted here when no sibling pane context exists (e.g. local-only
   * desktop file browsing with no SFTP session).
   */
  onCompareWithOpposite?: (entry: FileEntry) => void;
  /**
   * Identity used to tell panes apart for drag-and-drop. Defaults to the
   * provider id; the dual-remote view mounts two "remote" panes and gives each
   * its own id.
   */
  paneId?: string;
  /**
   * When set, this pane copies to the OTHER pane's folder through `send`
   * (server to server) instead of downloading to / uploading from the local disk.
   */
  peerTransfer?: {
    label: string;
    send: (items: FileEntry[], destDir: string) => Promise<void>;
  };
}

export interface FilePanelHandle {
  refresh: () => Promise<void>;
  currentDir: () => string;
  notify: (msg: string, type?: "info" | "success" | "error") => void;
  sendItems: (items: FileEntry[], destDir: string) => Promise<void>;
}

const FilePanel = forwardRef<FilePanelHandle, FilePanelProps>(({
  provider,
  disabled = false,
  sessionId,
  onDragMove,
  initialPath,
  onPathChange,
  getOppositeDir,
  serverId,
  profile,
  terminalId,
  onRevealTerminal,
  onCompareWithOpposite,
  paneId,
  peerTransfer,
}, ref) => {
  const paneKey = paneId ?? provider.id;
  const [currentPath, setCurrentPath] = useState("");
  // Last five distinct directories visited in this panel, MRU first. Lives
  // in component state (cleared per session) — persistence didn't seem
  // worth the complexity given users usually want recents from this work
  // session, not whatever they were doing last week. Updated from `fetch`
  // when navigation succeeds.
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  const [recentOpen, setRecentOpen] = useState(false);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  // Multi-selection lives as a Set of paths. Single-click replaces, Ctrl/⌘-
  // click toggles a row in/out, Shift-click extends from the last-clicked
  // anchor. lastSelectedPathRef remembers that anchor across renders.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastSelectedPathRef = useRef<string | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [dropHover, setDropHover] = useState<string | null>(null);
  const dropHoverRef = useRef<string | null>(null);
  const dragJustEndedRef = useRef(false);
  const movingRef = useRef(false);
  const [pendingMove, setPendingMove] = useState<{ label: string; targetDir: string; waiting: boolean } | null>(null);
  const cancelPendingMoveRef = useRef<() => void>(() => {});
  const sendItemsRef = useRef<(items: FileEntry[], destDir: string) => Promise<void>>(async () => {});
  const [sort, setSort] = useState<SortState>({ column: "name", asc: true });
  const [showHiddenFiles, setShowHiddenFiles] = useState<boolean>(() => {
    return localStorage.getItem("subterm-sftp-show-hidden") !== "false";
  });
  type FileTypeFilter = "all" | "dirs" | "code" | "logs" | "archives" | "media";
  const [typeFilter, setTypeFilter] = useState<FileTypeFilter>("all");
  const [showTree, setShowTree] = useState<boolean>(() => {
    return localStorage.getItem("subterm-filepanel-show-tree") === "true";
  });
  const [terminalCwd, setTerminalCwd] = useState<string | null>(() => {
    return terminalId ? (getTerminalCwd(terminalId) || null) : null;
  });
  const [followTerminal, setFollowTerminal] = useState<boolean>(() => {
    return localStorage.getItem("subterm-sftp-follow-cwd") === "true";
  });

  const dropTargetRef = useRef<HTMLDivElement | null>(null);
  const listWidth = useElementWidth(dropTargetRef);
  const [ownerNames, setOwnerNames] = useState<Record<number, string>>({});
  const requestedOwnerUidsRef = useRef(new Set<number>());
  const ownerLookupUnavailableRef = useRef(false);
  const failedOwnerLookupListGenRef = useRef<number | null>(null);
  const ownerLookupGenerationRef = useRef(0);
  const listGenRef = useRef(0);

  useEffect(() => {
    ownerLookupGenerationRef.current++;
    requestedOwnerUidsRef.current.clear();
    ownerLookupUnavailableRef.current = false;
    failedOwnerLookupListGenRef.current = null;
    setOwnerNames({});
  }, [provider, sessionId, disabled]);

  useEffect(() => {
    if (
      provider.id !== "remote"
      || !sessionId
      || disabled
      || ownerLookupUnavailableRef.current
      || failedOwnerLookupListGenRef.current === listGenRef.current
    ) return;
    const uids = [...new Set(entries.map((entry) => entry.uid).filter((uid): uid is number => uid != null))]
      .filter((uid) => !requestedOwnerUidsRef.current.has(uid));
    if (uids.length === 0) return;

    uids.forEach((uid) => requestedOwnerUidsRef.current.add(uid));
    const generation = ownerLookupGenerationRef.current;
    const listGeneration = listGenRef.current;
    invoke<SftpOwnerLookup>("sftp_resolve_owners", { sessionId, uids })
      .then((result) => {
        if (ownerLookupGenerationRef.current !== generation) return;
        if (result.status === "unsupported") ownerLookupUnavailableRef.current = true;
        if (result.status === "transient_error") {
          failedOwnerLookupListGenRef.current = listGeneration;
          const resolved = new Set(result.owners.map((owner) => owner.uid));
          uids.filter((uid) => !resolved.has(uid))
            .forEach((uid) => requestedOwnerUidsRef.current.delete(uid));
        }
        if (result.owners.length > 0) {
          setOwnerNames((current) => ({
            ...current,
            ...Object.fromEntries(result.owners.map((owner) => [owner.uid, owner.name])),
          }));
        }
      })
      .catch(() => {
        if (ownerLookupGenerationRef.current !== generation) return;
        failedOwnerLookupListGenRef.current = listGeneration;
        uids.forEach((uid) => requestedOwnerUidsRef.current.delete(uid));
      });
  }, [entries, provider.id, sessionId, disabled]);

  const ownerLabel = (uid?: number) => uid == null ? "" : ownerNames[uid] ?? uid.toString();

  const [tempInput, setTempInput] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  // Name filter applied AFTER sort — substring, case-insensitive. Kept
  // separate from the path bar so the user can leave a filter active while
  // typing into the path. Sticky across `cd` so a quick filter session can
  // span sibling dirs; the X button or Escape on the input clears it.
  const [nameFilter, setNameFilter] = useState("");

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
  const [modal, setModal] = useState<{ type: "rename" | "mkdir" | "properties" | "move" | "move-bulk" | "duplicate"; entry?: FileEntry; v1?: string; v2?: string } | null>(null);
  const [notification, setNotification] = useState<{ msg: string; type: "info" | "success" | "error" } | null>(null);

  const [isEditingPath, setIsEditingPath] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [editorEntry, setEditorEntry] = useState<FileEntry | null>(null);
  const [fuzzySearchOpen, setFuzzySearchOpen] = useState(false);
  const [fuzzyQuery, setFuzzyQuery] = useState("");
  const [gitFileStatuses, setGitFileStatuses] = useState<Record<string, string>>({});
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const bookmarksEnabled = useFeatureFlag("sftpBookmarks");
  const [isCurrentBookmarked, setIsCurrentBookmarked] = useState(false);

  useEffect(() => {
    if (!bookmarksEnabled) return;
    const check = () => {
      const bms = loadSftpBookmarks(sessionId, serverId, profile);
      const norm = currentPath.replace(/\/+$/, "") || "/";
      setIsCurrentBookmarked(
        bms.some((b) => b.isRemote === (provider.id === "remote") && (b.path.replace(/\/+$/, "") || "/") === norm)
      );
    };
    check();
    window.addEventListener("subterm-bookmarks-updated", check);
    return () => window.removeEventListener("subterm-bookmarks-updated", check);
  }, [currentPath, provider.id, sessionId, serverId, profile, bookmarksEnabled]);

  useEffect(() => {
    if (!sessionId) return;
    const handleOpenEditor = (ev: Event) => {
      const e = ev as CustomEvent<{ path?: string }>;
      const filePath = e.detail?.path;
      if (!filePath) return;
      const fileName = filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;
      setEditorEntry({
        name: fileName,
        path: filePath,
        isDir: false,
        size: 0,
      });
    };
    window.addEventListener(`submarine-open-editor-${sessionId}`, handleOpenEditor);
    return () => {
      window.removeEventListener(`submarine-open-editor-${sessionId}`, handleOpenEditor);
    };
  }, [sessionId]);

  const isTextFile = (name: string) => {
    return /\.(txt|json|ya?ml|conf|sh|bash|zsh|env|py|js|jsx|ts|tsx|html|css|scss|md|toml|xml|ini|service|sql|rs|go|c|cpp|h|hpp|log|gitignore|dockerfile)$/i.test(name) || !name.includes(".");
  };

  const isImage = (name: string) => {
    return /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(name);
  };

  const pathSegments = useMemo(() => {
    if (!currentPath) return [];
    return pathCrumbs(currentPath, provider.pathSep).map((c) => ({
      label: c.label,
      fullPath: c.path,
      navigable: c.navigable,
    }));
  }, [currentPath, provider.pathSep]);

  const extractArchive = async (entry: FileEntry) => {
    if (!sessionId) return;
    notify(`Extracting ${entry.name}…`, "info");
    try {
      const parent = provider.parentPath(entry.path);
      const isZip = /\.zip$/i.test(entry.name);
      const cmd = isZip
        ? `unzip -o "${entry.path.replace(/"/g, '\\"')}" -d "${parent.replace(/"/g, '\\"')}"`
        : `tar -xzf "${entry.path.replace(/"/g, '\\"')}" -C "${parent.replace(/"/g, '\\"')}"`;
      await invoke("sftp_exec_command", { sessionId, command: cmd });
      notify(`Extracted ${entry.name}`, "success");
      fetch(currentPath);
    } catch (err) {
      notify(`Extraction failed: ${err}`, "error");
    }
  };

  const compressToTar = async (items: FileEntry[]) => {
    if (!sessionId || items.length === 0) return;
    const firstName = items[0].name.replace(/\.[^/.]+$/, "");
    const tarName = items.length === 1 ? `${firstName}.tar.gz` : `archive_${Date.now()}.tar.gz`;
    notify(`Compressing to ${tarName}…`, "info");
    try {
      const parent = currentPath;
      const fileArgs = items.map(it => `"${it.name.replace(/"/g, '\\"')}"`).join(" ");
      const cmd = `cd "${parent.replace(/"/g, '\\"')}" && tar -czf "${tarName}" ${fileArgs}`;
      await invoke("sftp_exec_command", { sessionId, command: cmd });
      notify(`Created ${tarName}`, "success");
      fetch(currentPath);
    } catch (err) {
      notify(`Compression failed: ${err}`, "error");
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        const root = dropTargetRef.current;
        if (root && document.activeElement && !root.contains(document.activeElement)) return;
        e.preventDefault();
        setFuzzySearchOpen(true);
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        setShowTree((prev) => {
          const next = !prev;
          try {
            localStorage.setItem("subterm-filepanel-show-tree", String(next));
          } catch {
            /* quota */
          }
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  const [dragOver, setDragOver] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const currentPathRef = useRef(currentPath);
  useEffect(() => { currentPathRef.current = currentPath; }, [currentPath]);

  // Android quick-picker state. There is no OS-level folder picker that
  // returns a real filesystem path on Android (SAF returns content URIs
  // that Rust's std::fs can't open), so we replace the desktop rfd call
  // with a small popover of writable paths returned by the backend. Loaded
  // lazily the first time the user opens the popover so we don't burn a
  // touch-probe per directory on every panel mount.
  const [androidPickerOpen, setAndroidPickerOpen] = useState(false);
  const [androidQuickDirs, setAndroidQuickDirs] = useState<{ label: string; path: string }[] | null>(null);

  // ---- helpers ----------------------------------------------------------------

  const notify = (msg: string, type: "info" | "success" | "error" = "info") => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 4000);
  };

  const formatRights = (isDir: boolean, perm?: number) => {
    if (perm === undefined) return isDir ? "d---------" : "----------";
    const r = (v: number) => (v & 4 ? "r" : "-");
    const w = (v: number) => (v & 2 ? "w" : "-");
    const x = (v: number) => (v & 1 ? "x" : "-");
    const u = (perm >> 6) & 7, g = (perm >> 3) & 7, o = perm & 7;
    return (isDir ? "d" : "-") + r(u) + w(u) + x(u) + r(g) + w(g) + x(g) + r(o) + w(o) + x(o);
  };

  const formatTime = (ts?: number) => {
    if (!ts) return "-";
    const d = new Date(ts * 1000);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const formatSize = (bytes: number) => {
    if (!bytes) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  // ---- listing / navigation ---------------------------------------------------

  const pushRecent = (path: string) => {
    if (!path) return;
    setRecentDirs((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)];
      return next.slice(0, 5);
    });
  };

  const fetch = async (path: string) => {
    setLoading(true);
    try {
      const result = await provider.list(path);
      listGenRef.current++;
      setEntries(result.entries);
      setCurrentPath(result.currentPath);
      setTempInput(result.currentPath);
      setSelected(new Set());
      lastSelectedPathRef.current = null;
      onPathChange?.(result.currentPath);
      pushRecent(result.currentPath);

      if (provider.id === "remote" && sessionId) {
        invoke<string>("sftp_exec_command", {
          sessionId,
          command: `cd "${result.currentPath.replace(/"/g, '\\"')}" 2>/dev/null && git status --porcelain . 2>/dev/null`,
        }).then((out) => {
          const map: Record<string, string> = {};
          if (out) {
            for (const line of out.split("\n")) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              const code = line.slice(0, 2).trim();
              const relPath = line.slice(2).trim();
              const base = relPath.split("/").pop() || relPath;
              map[base] = code;
            }
          }
          setGitFileStatuses(map);
        }).catch(() => setGitFileStatuses({}));
      } else {
        setGitFileStatuses({});
      }
    } catch (err) {
      notify(`List failed: ${err}`, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!sessionId) return;
    const handleNavigate = (ev: Event) => {
      const e = ev as CustomEvent<{ path?: string }>;
      const p = e.detail?.path;
      if (p) fetch(p);
    };
    window.addEventListener(`submarine-navigate-path-${sessionId}`, handleNavigate);
    return () => {
      window.removeEventListener(`submarine-navigate-path-${sessionId}`, handleNavigate);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!terminalId) return;
    const initial = getTerminalCwd(terminalId);
    if (initial) setTerminalCwd(initial);

    const unlisten = onTerminalCwdChange((termId, cwd) => {
      if (termId === terminalId && cwd) {
        setTerminalCwd(cwd);
        if (followTerminal && cwd !== currentPathRef.current) {
          fetch(cwd);
        }
      }
    });
    return unlisten;
  }, [terminalId, followTerminal]);

  const sendTerminalCd = (targetDir: string) => {
    const clean = targetDir.replace(/"/g, '\\"');
    if (sessionId) {
      window.dispatchEvent(
        new CustomEvent(`submarine-terminal-cd-${sessionId}`, { detail: { path: targetDir } })
      );
    } else if (terminalId) {
      const cdCmd = `cd "${clean}"\r`;
      const bytes = Array.from(new TextEncoder().encode(cdCmd));
      invoke("write_terminal_data", { terminalId, data: bytes }).catch(() => {});
      window.dispatchEvent(new CustomEvent(`subterm-terminal-focus-${terminalId}`));
    }
    notify(`Sent cd "${targetDir}" to Terminal`, "info");
  };

  // Initial load: try the caller-supplied `initialPath` first (the
  // per-server-saved directory), and fall back to the provider's home if it
  // no longer exists — that way a saved path being removed doesn't strand
  // the user with an error screen.
  useEffect(() => {
    (async () => {
      const tryFetch = async (path: string) => {
        const result = await provider.list(path);
        setEntries(result.entries);
        setCurrentPath(result.currentPath);
        setTempInput(result.currentPath);
        setSelected(new Set());
      lastSelectedPathRef.current = null;
        onPathChange?.(result.currentPath);
        pushRecent(result.currentPath);
      };
      setLoading(true);
      try {
        if (initialPath) {
          try { await tryFetch(initialPath); return; }
          catch { /* fall through to home */ }
        }
        const home = await provider.homePath();
        await tryFetch(home);
      } catch (err) {
        notify(`Failed to load: ${err}`, "error");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  useImperativeHandle(ref, () => ({
    refresh: () => fetch(currentPathRef.current),
    currentDir: () => currentPathRef.current,
    notify: (msg, type) => notify(msg, type),
    sendItems: (items, destDir) => sendItemsRef.current(items, destDir),
  }), []);

  const goUp = () => fetch(provider.parentPath(currentPath));

  // ---- selection -------------------------------------------------------------

  // Three click modes match every desktop file manager people already know:
  //   - plain click  → replace selection with this row
  //   - Ctrl/⌘+click → toggle this row in / out of the existing set
  //   - Shift+click  → extend the range from the last anchor to this row
  // Shift-extend uses `sortedEntries` (the rendered order), not `entries`,
  // so the visual range matches what the user just dragged across.
  const onRowClick = (e: React.MouseEvent, entry: FileEntry, ordered: FileEntry[]) => {
    if (dragJustEndedRef.current) return;
    if (e.shiftKey && lastSelectedPathRef.current) {
      const a = ordered.findIndex(x => x.path === lastSelectedPathRef.current);
      const b = ordered.findIndex(x => x.path === entry.path);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const range = ordered.slice(lo, hi + 1).map(x => x.path);
        setSelected(new Set([...selected, ...range]));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      setSelected(next);
      lastSelectedPathRef.current = entry.path;
      return;
    }
    setSelected(new Set([entry.path]));
    lastSelectedPathRef.current = entry.path;
  };

  // Forward-walking autocomplete. As the user types a path, look at the
  // segment AFTER the last separator and prefix-match it against whichever
  // directory's listing applies. Three sources, in order of preference:
  //   1. typed path's parent matches the pane's current directory → use
  //      the already-loaded `entries` (free, no SFTP roundtrip).
  //   2. typed parent matches a previously-prefetched lookahead → reuse
  //      that cached listing.
  //   3. typed parent is somewhere else → kick a debounced provider.list
  //      to load it (effect below), then case 2 lights up.
  const [lookaheadParent, setLookaheadParent] = useState<string>("");
  const [lookaheadEntries, setLookaheadEntries] = useState<FileEntry[]>([]);

  // Split the typed input into (parent_dir, leaf_prefix) using either '/'
  // or '\' as the separator so Windows local paths work too.
  const splitInputPath = (input: string): { parent: string; leaf: string } | null => {
    const sep = Math.max(input.lastIndexOf('/'), input.lastIndexOf('\\'));
    if (sep < 0) return null;
    // Keep the trailing separator on the parent so "/var/" parses as
    // parent=/var/, leaf="" — that's what makes typing the slash trigger
    // a fresh listing of the directory below.
    const parent = input.substring(0, sep + 1);
    const leaf = input.substring(sep + 1);
    return { parent, leaf };
  };

  // Prefetch listings for typed paths outside the current directory. Debounced
  // so a fast typist doesn't fire one SFTP request per keystroke; skipped
  // when the typed parent already matches currentPath (free from `entries`).
  useEffect(() => {
    if (!inputFocused) return;
    const split = splitInputPath(tempInput);
    if (!split) return;
    // Normalize: most providers report paths without the trailing '/'.
    const probe = split.parent.replace(/[\\/]+$/, "") || "/";
    if (probe === currentPath || probe === lookaheadParent) return;
    const t = setTimeout(async () => {
      try {
        const result = await provider.list(probe);
        setLookaheadEntries(result.entries);
        setLookaheadParent(result.currentPath);
      } catch { /* parent doesn't exist (yet) — suggestions just stay empty */ }
    }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tempInput, inputFocused, currentPath]);

  const suggestions = (() => {
    if (!inputFocused) return [];
    const split = splitInputPath(tempInput);
    if (!split) return [];
    const probe = split.parent.replace(/[\\/]+$/, "") || "/";
    const source =
      probe === currentPath      ? entries :
      probe === lookaheadParent  ? lookaheadEntries :
                                   [];
    const leafLower = split.leaf.toLowerCase();
    return source.filter(e => e.name.toLowerCase().startsWith(leafLower));
  })();

  const pickSuggestion = (e: FileEntry) => {
    setTempInput(e.path);
    if (e.isDir) fetch(e.path);
    setInputFocused(false);
  };

  // ---- context menu auto-close ------------------------------------------------

  useEffect(() => {
    if (!contextMenu) return;
    const onWindowMouseDown = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      setContextMenu(null);
    };
    const timer = setTimeout(() => window.addEventListener("mousedown", onWindowMouseDown), 50);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", onWindowMouseDown);
    };
  }, [contextMenu]);

  const openMenu = (e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    const MENU_W = 200, MENU_H = 320;
    const x = Math.min(e.clientX, window.innerWidth - MENU_W - 4);
    const y = Math.min(e.clientY, window.innerHeight - MENU_H - 4);
    // Right-click on a row that isn't already part of the selection should
    // switch focus to it (Explorer/Finder behaviour). Right-click on a row
    // that IS selected keeps the multi-selection so bulk actions apply.
    if (!selected.has(entry.path)) {
      setSelected(new Set([entry.path]));
      lastSelectedPathRef.current = entry.path;
    }
    setContextMenu({ x: Math.max(4, x), y: Math.max(4, y), entry });
  };

  // ---- drag-source & in-pane move --------------------------------------------

  const moveRules = () => rulesFor(provider.id, provider.pathSep);

  const dropTargetAt = (x: number, y: number, items: FileEntry[]): string | null => {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!hit || hit.closest("[data-fs-pane]")?.getAttribute("data-fs-pane") !== paneKey) return null;
    const target = hit.closest("[data-fs-drop-path]")?.getAttribute("data-fs-drop-path");
    const rules = moveRules();
    if (!target || !items.some((it) => canMoveInto(it, target, rules))) return null;
    return target;
  };

  const moveInto = async (items: FileEntry[], targetDir: string) => {
    const rules = moveRules();
    const movable = items.filter((it) => canMoveInto(it, targetDir, rules));
    if (movable.length === 0) return;
    if (movingRef.current) {
      notify("Another move is still in progress. Wait for it, or cancel it.", "info");
      return;
    }
    movingRef.current = true;
    let cancelled = false;
    const waiting = false;
    let ownsPanel = true;
    cancelPendingMoveRef.current = () => {
      cancelled = true;
      if (!waiting) return;
      ownsPanel = false;
      movingRef.current = false;
      setPendingMove(null);
    };
    const label = movable.length === 1 ? movable[0].name : `${movable.length} items`;
    const showRow = () => { if (ownsPanel) setPendingMove({ label, targetDir, waiting }); };
    const rowTimer: number | null = window.setTimeout(showRow, 250);
    try {
      if (cancelled) return;
      let taken: Set<string>;
      try {
        const existing = (await provider.list(targetDir)).entries.map((e) => e.name);
        taken = takenNames(movable.map((it) => it.name), existing, rules);
      } catch (err) {
        notify(`Move failed: ${err}`, "error");
        return;
      }
      const moved: string[] = [];
      const failures: string[] = [];
      for (const it of movable) {
        if (cancelled) break;
        if (taken.has(it.name)) {
          failures.push(`${it.name} (already exists there)`);
          continue;
        }
        try {
          await provider.rename(it.path, provider.joinPath(targetDir, it.name));
          moved.push(it.path);
        } catch (err) {
          failures.push(`${it.name} (${err})`);
        }
      }
      const stopped = movable.length - moved.length - failures.length;
      const notMoved = failures.length > 0 ? ` Not moved: ${listFailures(failures)}` : "";
      const stoppedNote = stopped > 0 ? ` (${stopped} cancelled)` : "";
      if (failures.length === 0 && stopped === 0) {
        notify(movable.length === 1 ? `Moved ${movable[0].name} → ${targetDir}` : `Moved ${moved.length} items → ${targetDir}`, "success");
      } else if (moved.length > 0) {
        notify(`Moved ${moved.length} of ${movable.length} → ${targetDir}${stoppedNote}.${notMoved}`, failures.length > 0 ? "error" : "info");
      } else if (failures.length > 0) {
        notify(`Nothing moved${stoppedNote}.${notMoved}`, "error");
      } else {
        notify("Move cancelled", "info");
      }
      if (moved.length > 0) {
        const gone = new Set(moved);
        const keep = new Set([...selectedRef.current].filter((path) => !gone.has(path)));
        const anchor = lastSelectedPathRef.current;
        await fetch(currentPathRef.current);
        setSelected(keep);
        lastSelectedPathRef.current = anchor && keep.has(anchor) ? anchor : null;
      }
    } finally {
      if (rowTimer != null) window.clearTimeout(rowTimer);
      if (ownsPanel) {
        ownsPanel = false;
        setPendingMove(null);
        movingRef.current = false;
      }
    }
  };

  const DRAG_START_THRESHOLD = 6;

  const handleRowMouseDown = (e: React.MouseEvent, entry: FileEntry) => {
    if (disabled || e.button !== 0) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let dragStarted = false;
    const items = selected.has(entry.path)
      ? sortedEntries.filter((en) => selected.has(en.path))
      : [entry];

    const setHover = (path: string | null) => {
      if (dropHoverRef.current === path) return;
      dropHoverRef.current = path;
      setDropHover(path);
    };

    const onMove = (ev: MouseEvent) => {
      if (!dragStarted) {
        if (Math.abs(ev.clientX - startX) < DRAG_START_THRESHOLD &&
            Math.abs(ev.clientY - startY) < DRAG_START_THRESHOLD) return;
        dragStarted = true;
      }
      onDragMove({
        paneId: paneKey,
        entry,
        items,
        x: ev.clientX,
        y: ev.clientY,
      });
      setHover(dropTargetAt(ev.clientX, ev.clientY, items));
    };

    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      onDragMove(null);
      setHover(null);
      if (!dragStarted) return;
      dragJustEndedRef.current = true;
      window.setTimeout(() => { dragJustEndedRef.current = false; }, 0);
      const target = dropTargetAt(ev.clientX, ev.clientY, items);
      if (target) moveInto(items, target);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Live-edit toast. `sftp_open_remote_file` downloads the file to a temp
  // dir, opens it in the system editor, and watches the file's mtime.
  // Every time the user saves, Rust pushes the change back to the server
  // and emits `sftp-sync-status-{id}`. Surface the success path as a
  // notify() so the user sees their save actually landed; errors get the
  // full text from the backend.
  useEffect(() => {
    if (!sessionId) return;
    let unlisten: (() => void) | null = null;
    listen<{ status: string; message?: string }>(
      `sftp-sync-status-${sessionId}`,
      (event) => {
        const { status, message } = event.payload || ({} as { status?: string; message?: string });
        if (status === "success") {
          notify(message || "Changes uploaded", "success");
        } else if (status === "error") {
          notify(message || "Auto-sync failed", "error");
        }
      },
    ).then((u) => { unlisten = u; });
    return () => { if (unlisten) unlisten(); };
  }, [sessionId]);

  // ---- OS-level drag-drop into this pane --------------------------------------
  // Tauri 2 routes OS file drops through `tauri://drag-drop`; HTML5 drop events
  // fire too but their `File.path` is empty inside Tauri. We listen globally and
  // dispatch only when the cursor landed inside our root.

  useEffect(() => {
    if (!sessionId) return; // local pane doesn't need this
    let unlisten: (() => void) | null = null;
    listen<{ paths: string[]; position: { x: number; y: number } }>(
      "tauri://drag-drop",
      async (event) => {
        const { paths, position } = event.payload || ({} as { paths?: string[]; position: { x: number; y: number } });
        if (!paths?.length || !dropTargetRef.current) return;
        // Tauri reports physical pixels; elementFromPoint wants CSS pixels.
        const pt = toCssPoint(position);
        const hit = document.elementFromPoint(pt.x, pt.y);
        if (!hit || !dropTargetRef.current.contains(hit)) return;
        setDragOver(false);
        const dir = currentPathRef.current;
        const batch: OverwriteBatch = { kind: "ask" };
        let cancelled = false;
        for (const p of paths) {
          if (cancelled) break;
          const name = p.split(/[\\/]/).pop() || "file";
          notify(`Uploading ${name}...`, "info");
          try {
            const remote = dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
            const res = await transferWithOverwriteCheck(
              (ow) => invoke("sftp_upload_file", { sessionId, localPath: p, remotePath: remote, overwrite: ow }),
              name, "upload", paths.length, batch, overwritePrompt,
              { localPath: p, remotePath: remote, sessionId }
            );
            if (res === "done") notify(`Uploaded ${name}`, "success");
            if (res === "cancelled") { cancelled = true; notify("Upload batch cancelled", "info"); }
          } catch (err) {
            notify(`Upload failed: ${err}`, "error");
          }
        }
        await fetch(dir);
      }
    ).then((fn) => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ---- modals -----------------------------------------------------------------

  const submitModal = async () => {
    if (!modal) return;
    const { type, entry, v1, v2 } = modal;
    try {
      if (type === "rename" && entry && v1) {
        const destDir = provider.parentPath(entry.path);
        const dest = provider.joinPath(destDir, v1);
        await provider.rename(entry.path, dest);
        notify(`Renamed to ${v1}`, "success");
      } else if (type === "move" && entry && v1) {
        // v1 is the destination *directory* the user typed (matches the
        // bulk-move semantics so users have a single mental model). We
        // append the entry's own name so the item keeps its filename. To
        // change the filename, the user picks "Rename" instead.
        const destDir = v1.replace(/[\\/]+$/, "");
        const dest = provider.joinPath(destDir, entry.name);
        if (dest === entry.path) throw new Error("Destination is the current location — nothing to move.");
        await provider.rename(entry.path, dest);
        notify(`Moved ${entry.name} → ${destDir}`, "success");
      } else if (type === "move-bulk" && v1) {
        // v1 is the destination *directory*; each selected item keeps its
        // own name under it.
        const dest = v1.replace(/[\\/]+$/, "");
        const items = sortedEntries.filter(e => selected.has(e.path));
        let count = 0;
        for (const it of items) {
          try {
            await provider.rename(it.path, provider.joinPath(dest, it.name));
            count++;
          } catch (err) {
            notify(`Move failed for ${it.name}: ${err}`, "error");
          }
        }
        if (count > 0) {
          setSelected(new Set());
          lastSelectedPathRef.current = null;
          notify(items.length === 1 ? `Moved ${items[0].name} → ${dest}` : `Moved ${count} of ${items.length} items → ${dest}`, "success");
        }
      } else if (type === "mkdir" && v1) {
        await provider.mkdir(provider.joinPath(currentPath, v1));
        notify(`Created ${v1}`, "success");
      } else if (type === "duplicate" && entry && v1) {
        const destPath = provider.joinPath(currentPath, v1);
        if (provider.id === "remote" && sessionId) {
          const escapedSrc = entry.path.replace(/"/g, '\\"');
          const escapedDest = destPath.replace(/"/g, '\\"');
          const res = await invoke<string>("sftp_exec_command", {
            sessionId,
            command: `cp -r "${escapedSrc}" "${escapedDest}" 2>&1`,
          });
          if (res && res.trim().length > 0 && /error|cannot|failed|denied/i.test(res)) {
            throw new Error(res.trim());
          }
          notify(`Duplicated ${entry.name} → ${v1}`, "success");
        } else {
          await invoke("local_copy_entry", {
            src: entry.path,
            dest: destPath,
            isDir: entry.isDir,
          });
          notify(`Duplicated ${entry.name} → ${v1}`, "success");
        }
      } else if (type === "properties" && entry && v1 && provider.chmod) {
        const mode = parseInt(v1, 8);
        if (isNaN(mode)) throw new Error("Invalid octal mode");
        await provider.chmod(entry.path, mode);
        if (v2 && provider.chown) {
          const uid = parseInt(v2);
          if (!isNaN(uid)) await provider.chown(entry.path, uid, entry.gid ?? 0);
        }
        notify("Properties updated", "success");
      }
      await fetch(currentPath);
    } catch (err) {
      notify(`Failed: ${err}`, "error");
    } finally {
      setModal(null);
    }
  };

  // ---- removal ----------------------------------------------------------------

  const confirmDialog = useConfirm();
  const overwritePrompt = useOverwritePrompt();

  // Bulk-aware delete. Pops a single confirm dialog regardless of count, then
  // applies provider.remove to each item in turn — best-effort: per-item
  // failures notify but don't halt the rest. Selection is cleared on success
  // so the user isn't left with stale paths highlighted.
  const removeItems = async (items: FileEntry[]) => {
    if (items.length === 0) return;
    const ok = await confirmDialog({
      title: items.length === 1 ? "Delete item" : `Delete ${items.length} items`,
      message: items.length === 1
        ? (items[0].isDir
            ? `Permanently delete folder “${items[0].name}” and everything inside?`
            : `Permanently delete “${items[0].name}”?`)
        : `Permanently delete ${items.length} items? Folders include their contents.`,
      okLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    let count = 0;
    for (const it of items) {
      try { await provider.remove(it.path, it.isDir && !it.isSymlink); count++; }
      catch (err) { notify(`Delete failed for ${it.name}: ${err}`, "error"); }
    }
    if (count > 0) {
      setSelected(new Set());
      lastSelectedPathRef.current = null;
      notify(items.length === 1 ? `Deleted ${items[0].name}` : `Deleted ${count} of ${items.length} items`, "success");
      await fetch(currentPath);
    }
  };

  // ---- contextual actions -----------------------------------------------------

  // Remote → local download. Bulk-aware, folder-aware. Destination is
  // whatever the local pane is currently showing (`getOppositeDir`) — that's
  // almost always what the user wants and saves the round-trip through a
  // folder picker every single time. Only falls back to the native picker
  // if the sibling pane hasn't reported a directory yet (e.g. it's still
  // loading). Folders go through `sftp_download_dir` which walks the tree
  // and preserves structure; individual files go through the single-file
  // command. Both paths emit progress on the same `sftp-transfer-{id}`
  // channel so the user sees uniform cards.
  const downloadItems = async (items: FileEntry[], destDir?: string) => {
    if (!sessionId || items.length === 0) return;
    let dest = destDir || getOppositeDir?.();
    if (!dest) {
      try {
        dest = IS_MOBILE_OS
          ? ((await invoke<string>("android_default_local_dir")) || undefined)
          : ((await invoke<string | null>("select_local_folder")) || undefined);
      } catch (err) { notify(`Pick folder failed: ${err}`, "error"); return; }
      if (!dest) return;
    }
    const sep = dest.includes("\\") ? "\\" : "/";
    const trimmed = dest.replace(/[\\/]+$/, "");
    const fileCount = items.filter(e => !e.isDir).length;
    const dirCount  = items.filter(e =>  e.isDir).length;
    const summary =
      items.length === 1
        ? `Downloading ${items[0].isDir ? "folder " : ""}${items[0].name}…`
        : `Downloading ${fileCount} files${dirCount ? ` + ${dirCount} folder${dirCount === 1 ? "" : "s"}` : ""}…`;
    notify(summary, "info");
    const batch: OverwriteBatch = { kind: "ask" };
    let count = 0;
    let cancelled = false;
    for (const e of items) {
      if (cancelled) break;
      try {
        const dest = e.isDir ? trimmed : `${trimmed}${sep}${e.name}`;
        const cmd = e.isDir ? "sftp_download_dir" : "sftp_download_file";
        const res = await transferWithOverwriteCheck(
          (ow) => invoke(cmd, { sessionId, remotePath: e.path, localPath: dest, overwrite: ow }),
          e.name, "download", items.length, batch, overwritePrompt,
          e.isDir ? undefined : { localPath: dest, remotePath: e.path, sessionId }
        );
        if (res === "done") count++;
        if (res === "cancelled") { cancelled = true; }
      } catch (err) {
        notify(`Download failed for ${e.name}: ${err}`, "error");
      }
    }
    if (count > 0) {
      notify(items.length === 1 ? `Downloaded ${items[0].name}` : `Downloaded ${count} of ${items.length} items`, "success");
    } else if (cancelled) {
      notify("Download batch cancelled", "info");
    }
  };

  const uploadItems = async (items: FileEntry[], destDir?: string) => {
    if (!sessionId || items.length === 0) return;
    const dest = destDir || getOppositeDir?.();
    if (!dest) { notify("Open a directory in the remote pane first.", "error"); return; }
    const trimmed = dest.replace(/[\\/]+$/, "");
    const fileCount = items.filter((e) => !e.isDir).length;
    const dirCount = items.filter((e) => e.isDir).length;
    const summary = items.length === 1
      ? `Uploading ${items[0].isDir ? "folder " : ""}${items[0].name}…`
      : `Uploading ${fileCount} file${fileCount === 1 ? "" : "s"}${dirCount ? ` + ${dirCount} folder${dirCount === 1 ? "" : "s"}` : ""}…`;
    notify(summary, "info");
    const batch: OverwriteBatch = { kind: "ask" };
    let count = 0;
    let cancelled = false;
    for (const e of items) {
      if (cancelled) break;
      try {
        const remotePath = e.isDir ? trimmed || "/" : `${trimmed}/${e.name}`;
        const cmd = e.isDir ? "sftp_upload_dir" : "sftp_upload_file";
        const res = await transferWithOverwriteCheck(
          (ow) => invoke(cmd, { sessionId, localPath: e.path, remotePath, overwrite: ow }),
          e.name, "upload", items.length, batch, overwritePrompt,
          e.isDir ? undefined : { localPath: e.path, remotePath, sessionId }
        );
        if (res === "done") count++;
        if (res === "cancelled") { cancelled = true; }
      } catch (err) {
        notify(`Upload failed for ${e.name}: ${err}`, "error");
      }
    }
    if (count > 0) {
      notify(items.length === 1 ? `Uploaded ${items[0].name}` : `Uploaded ${count} of ${items.length} items`, "success");
    } else if (cancelled) {
      notify("Upload batch cancelled", "info");
    }
  };

  // Server-to-server copy: send to whatever folder the other pane is showing.
  const copyToPeer = async (items: FileEntry[], destDir?: string) => {
    if (!peerTransfer || items.length === 0) return;
    const dest = destDir || getOppositeDir?.();
    if (!dest) { notify("Open a folder in the other pane first.", "error"); return; }
    await peerTransfer.send(items, dest);
  };

  sendItemsRef.current = peerTransfer ? copyToPeer : provider.id === "remote" ? downloadItems : uploadItems;

  const openingPathsRef = useRef<Set<string>>(new Set());

  // Remote: open in OS default editor with a save-watcher that re-uploads on
  // every change. Backed by the existing `sftp_open_remote_file` command.
  const liveEditEntry = async (entry: FileEntry) => {
    if (!sessionId || entry.isDir) return;
    if (openingPathsRef.current.has(entry.path)) {
      notify(`${entry.name} is already downloading`, "info");
      return;
    }
    openingPathsRef.current.add(entry.path);
    const transferId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      notify(`Opening ${entry.name} in default editor…`, "info");
      await invoke("sftp_open_remote_file", { sessionId, remotePath: entry.path, transferId });
    } catch (err) {
      if (String(err) !== "cancelled") {
        notify(`Open failed: ${err}`, "error");
      }
    } finally {
      openingPathsRef.current.delete(entry.path);
    }
  };

  // Local: open file in default OS application.
  const openLocalEntry = async (entry: FileEntry) => {
    if (entry.isDir) { fetch(entry.path); return; }
    try {
      await invoke("local_open_file", { localPath: entry.path });
    } catch (err) {
      notify(`Open failed: ${err}`, "error");
    }
  };

  // Local: reveal in OS file manager.
  const revealLocalEntry = async (entry: FileEntry) => {
    try {
      await invoke("local_open_in_explorer", { localPath: entry.path });
    } catch (err) {
      notify(`Reveal failed: ${err}`, "error");
    }
  };

  // ---- sorting ----------------------------------------------------------------

  const hiddenCount = entries.filter((e) => e.name.startsWith(".")).length;

  const sortedEntries = (() => {
    let source = entries;
    if (!showHiddenFiles) {
      source = source.filter((e) => !e.name.startsWith("."));
    }
    if (typeFilter === "dirs") {
      source = source.filter((e) => e.isDir);
    } else if (typeFilter === "code") {
      source = source.filter((e) => e.isDir || /\.(json|ya?ml|toml|conf|cfg|ini|env|xml|sh|bash|py|js|ts|tsx|jsx|rs|go|c|cpp|h|css|html|md|sql)$/i.test(e.name));
    } else if (typeFilter === "logs") {
      source = source.filter((e) => e.isDir || /\.(log|out|err|trace|audit)$/i.test(e.name));
    } else if (typeFilter === "archives") {
      source = source.filter((e) => e.isDir || /\.(tar(\.gz|\.bz2|\.xz)?|tgz|zip|gz|bz2|xz|7z|rar)$/i.test(e.name));
    } else if (typeFilter === "media") {
      source = source.filter((e) => e.isDir || /\.(png|jpe?g|gif|webp|svg|ico|mp4|webm|pdf)$/i.test(e.name));
    }
    const sorted = [...source].sort((a, b) => {
      if (a.isDir !== b.isDir) return b.isDir ? 1 : -1;
      let va: string | number = 0, vb: string | number = 0;
      switch (sort.column) {
        case "name": va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
        case "size": va = a.isDir ? -1 : a.size; vb = b.isDir ? -1 : b.size; break;
        case "modified": va = a.modified || 0; vb = b.modified || 0; break;
        case "owner": va = ownerLabel(a.uid).toLowerCase(); vb = ownerLabel(b.uid).toLowerCase(); break;
        case "permissions": va = a.permissions || 0; vb = b.permissions || 0; break;
      }
      if (va < vb) return sort.asc ? -1 : 1;
      if (va > vb) return sort.asc ? 1 : -1;
      return 0;
    });
    const needle = nameFilter.trim().toLowerCase();
    if (!needle) return sorted;
    return sorted.filter(e => e.name.toLowerCase().includes(needle));
  })();
  const filteredOut = nameFilter.trim() ? entries.length - sortedEntries.length : 0;

  // ---- select-all -------------------------------------------------------------
  // Toggles the entire visible (sorted) list. Computed AFTER `sortedEntries`
  // so the const TDZ doesn't fire on first render. Cmd/Ctrl+A is the keyboard
  // counterpart; we let the browser handle Ctrl+A in text inputs by bailing
  // out when the focused element is editable.
  const selectAllVisible = () => {
    if (sortedEntries.length === 0) return;
    setSelected(new Set(sortedEntries.map(e => e.path)));
    lastSelectedPathRef.current = sortedEntries[sortedEntries.length - 1].path;
  };
  const clearSelection = () => {
    setSelected(new Set());
    lastSelectedPathRef.current = null;
  };
  const allSelected = sortedEntries.length > 0 && selected.size === sortedEntries.length;
  const toggleSelectAll = () => { if (allSelected) clearSelection(); else selectAllVisible(); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // Only fire when this panel owns the focus (or nothing specific is focused),
      // so two side-by-side FilePanel instances don't both trigger on the same press.
      const root = dropTargetRef.current;
      if (
        root &&
        document.activeElement &&
        document.activeElement !== document.body &&
        !root.contains(document.activeElement)
      ) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "h") {
        e.preventDefault();
        setShowHiddenFiles((prev) => {
          const next = !prev;
          localStorage.setItem("subterm-sftp-show-hidden", next ? "true" : "false");
          return next;
        });
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        if (selected.size === 1) {
          const selectedPath = Array.from(selected)[0];
          const entry = sortedEntries.find((item) => item.path === selectedPath);
          if (entry) {
            e.preventDefault();
            const name = entry.name;
            const extIndex = name.lastIndexOf(".");
            let defaultCopyName: string;
            if (!entry.isDir && extIndex > 0) {
              defaultCopyName = `${name.slice(0, extIndex)}.copy${name.slice(extIndex)}`;
            } else {
              defaultCopyName = `${name}.copy`;
            }
            setModal({
              type: "duplicate",
              entry,
              v1: defaultCopyName,
            });
            return;
          }
        }
      }

      if (e.altKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        setShowTree((prev) => {
          const next = !prev;
          localStorage.setItem("subterm-filepanel-show-tree", next ? "true" : "false");
          return next;
        });
        return;
      }

      if (e.key === " ") {
        if (editorEntry) {
          e.preventDefault();
          setEditorEntry(null);
          return;
        }
        const targetPath = lastSelectedPathRef.current || (selected.size === 1 ? Array.from(selected)[0] : null);
        if (targetPath) {
          const entry = sortedEntries.find((item) => item.path === targetPath);
          if (entry && !entry.isDir) {
            e.preventDefault();
            setEditorEntry(entry);
            return;
          }
        }
      }

      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "a") return;
      e.preventDefault();
      toggleSelectAll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedEntries, allSelected, showHiddenFiles, selected, editorEntry]);

  const toggleSort = (col: SortColumn) =>
    setSort((p) => ({ column: col, asc: p.column === col ? !p.asc : true }));

  const sortIcon = (col: SortColumn) => {
    if (sort.column !== col) return null;
    return sort.asc
      ? <ChevronUp size={11} className="inline ml-1 text-indigo-400" />
      : <ChevronDown size={11} className="inline ml-1 text-indigo-400" />;
  };

  // ---- HTML5 dragover for visual feedback during OS-level drop ----------------

  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragOver(true); };
  const onDragLeave = (e: React.DragEvent) => { e.preventDefault(); setDragOver(false); };
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); setDragOver(false); };

  const isRemote = provider.id === "remote";
  const showPerms = isRemote; // local entries don't carry perms here
  const showDetails = listWidth >= (showPerms ? 650 : 465);
  const showOwnerColumn = showPerms && listWidth >= 325;
  const showRightsColumn = showPerms && listWidth >= 410;
  const gridColumns = showPerms
    ? showDetails
      ? "grid-cols-[22px_minmax(180px,1fr)_65px_125px_100px_85px]"
      : showRightsColumn
        ? "grid-cols-[22px_minmax(140px,1fr)_100px_85px]"
        : showOwnerColumn
          ? "grid-cols-[22px_minmax(140px,1fr)_100px]"
          : "grid-cols-[22px_1fr]"
    : showDetails
      ? "grid-cols-[22px_minmax(180px,1fr)_75px_125px]"
      : "grid-cols-[22px_1fr]";

  return (
    <div
      data-fs-pane={paneKey}
      data-fs-current-path={currentPath}
      className="flex-1 flex flex-col h-full bg-[#09090b] p-1.5 gap-1.5 overflow-hidden relative select-none"
    >
      {disabled && (
        <div className="absolute inset-0 z-30 bg-black/55 backdrop-blur-[1px] flex items-center justify-center text-zinc-300 text-xs font-mono uppercase">
          <span className="px-3 py-1.5 bg-red-500/15 border border-red-500/30 rounded text-red-300">
            Session disconnected
          </span>
        </div>
      )}

      {(notification || pendingMove) && (
        <div className="absolute bottom-3 right-3 z-50 max-w-[80%] flex flex-col gap-1.5 animate-in fade-in slide-in-from-bottom-4 duration-300">
          {notification && (
            <div className={`px-3 py-1.5 rounded-lg border text-[11px] font-mono shadow-2xl backdrop-blur-md ${
              notification.type === "success" ? "bg-emerald-950/90 border-emerald-500/30 text-emerald-400" :
              notification.type === "error"   ? "bg-rose-950/90 border-rose-500/30 text-rose-400" :
                                                "bg-indigo-950/90 border-indigo-500/30 text-indigo-400"
            }`}>{notification.msg}</div>
          )}
          {pendingMove && (
            <div className="px-3 py-1.5 rounded-lg border text-[11px] font-mono shadow-2xl backdrop-blur-md bg-indigo-950/90 border-indigo-500/30 text-indigo-400 flex items-center gap-2">
              <span className="min-w-0">
                {`Moving ${pendingMove.label} → ${pendingMove.targetDir}…`}
              </span>
              <button
                type="button"
                title="Cancel move"
                onClick={() => cancelPendingMoveRef.current()}
                className="shrink-0 p-0.5 rounded hover:bg-white/15 text-zinc-300 hover:text-rose-300"
              >
                <X size={12} />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Header */}
      <div className="w-full flex items-center justify-between gap-1.5 p-1.5 bg-[#121214] border border-white/5 rounded-lg shrink-0 shadow-lg">
        <span className="text-[10px] font-black uppercase tracking-widest text-zinc-300 px-1.5 shrink-0">
          {provider.label}
        </span>
        <div className="h-5 w-px bg-white/10 shrink-0" />
        <div className="flex-1 flex items-center gap-1.5 min-w-0 relative">
          <button
            onClick={goUp}
            title="Up"
            data-fs-drop-path={provider.parentPath(currentPath)}
            className={`p-1 rounded border text-zinc-200 hover:bg-white/10 shrink-0 transition-colors ${
              dropHover === provider.parentPath(currentPath)
                ? "bg-indigo-500/30 text-white ring-1 ring-indigo-400 border-indigo-400"
                : "bg-white/[0.04] border-white/10"
            }`}
          >
            <ArrowUp size={11} />
          </button>
          <div className="relative shrink-0">
            <button
              onClick={() => setRecentOpen((p) => !p)}
              onBlur={() => setTimeout(() => setRecentOpen(false), 200)}
              disabled={recentDirs.filter((p) => p !== currentPath).length === 0}
              title="Recent directories"
              className="p-1 rounded bg-white/[0.04] border border-white/10 text-zinc-200 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed flex items-center"
            >
              <ChevronDown size={11} />
            </button>
            {recentOpen && (
              <div className="absolute top-[28px] left-0 z-50 min-w-[220px] max-h-[220px] overflow-y-auto bg-[#0c0c0e]/95 border border-white/10 rounded-lg shadow-2xl p-1 backdrop-blur-md font-mono text-[11px] text-zinc-200 no-scrollbar">
                <div className="px-2 py-1 text-[9px] uppercase tracking-wider text-zinc-500 font-bold">Recent</div>
                {recentDirs
                  .filter((p) => p !== currentPath)
                  .map((p) => (
                    <button
                      key={p}
                      onMouseDown={(e) => { e.preventDefault(); setRecentOpen(false); fetch(p); }}
                      className="w-full flex items-center gap-2 p-1.5 rounded text-left hover:bg-white/10 hover:text-white truncate"
                      title={p}
                    >
                      <Folder size={11} className="text-indigo-300 shrink-0" />
                      <span className="truncate">{p}</span>
                    </button>
                  ))}
              </div>
            )}
          </div>
          <div className="flex-1 relative min-w-0">
            {!isEditingPath ? (
              <div
                onDoubleClick={() => {
                  setTempInput(currentPath);
                  setIsEditingPath(true);
                }}
                className="w-full h-6 px-1.5 bg-white/[0.04] border border-white/10 rounded flex items-center justify-between gap-1 overflow-hidden"
              >
                {/* Scrollable Breadcrumbs */}
                <div className="flex-1 flex items-center gap-0.5 overflow-x-auto no-scrollbar font-mono text-[11px] min-w-0">
                  {pathSegments.map((seg, idx) => (
                    <React.Fragment key={seg.fullPath}>
                      {seg.navigable ? (
                        <button
                          onClick={() => fetch(seg.fullPath)}
                          data-fs-drop-path={seg.fullPath}
                          className={`px-1 py-0.5 rounded transition-colors truncate max-w-[140px] shrink-0 ${
                            dropHover === seg.fullPath ? "text-indigo-200 bg-indigo-500/30 rounded ring-1 ring-indigo-400" : ""
                          } ${
                            idx === pathSegments.length - 1
                              ? "text-indigo-300 font-bold bg-white/[0.06]"
                              : "text-zinc-400 hover:text-white hover:bg-white/10"
                          }`}
                          title={seg.fullPath}
                        >
                          {seg.label}
                        </button>
                      ) : (
                        <span
                          className="px-1 py-0.5 text-zinc-500 truncate max-w-[140px] shrink-0"
                          title={seg.fullPath}
                        >
                          {seg.label}
                        </span>
                      )}
                      {idx < pathSegments.length - 1 && (
                        <span className="text-zinc-600 select-none text-[10px] shrink-0">{provider.pathSep}</span>
                      )}
                    </React.Fragment>
                  ))}
                </div>

                {/* Breadcrumb Quick Actions */}
                <div className="flex items-center gap-1 shrink-0 pl-1 border-l border-white/5">
                  <button
                    onClick={async () => {
                      await navigator.clipboard.writeText(currentPath);
                      setCopiedPath(true);
                      setTimeout(() => setCopiedPath(false), 1500);
                    }}
                    title="Copy full path"
                    className="p-0.5 rounded text-zinc-400 hover:text-white hover:bg-white/10"
                  >
                    {copiedPath ? <Check size={10} className="text-emerald-400" /> : <Copy size={10} />}
                  </button>
                  <button
                    onClick={() => {
                      setTempInput(currentPath);
                      setIsEditingPath(true);
                    }}
                    title="Edit path directly (or double click)"
                    className="p-0.5 rounded text-zinc-400 hover:text-white hover:bg-white/10"
                  >
                    <Edit3 size={10} />
                  </button>
                </div>
              </div>
            ) : (
              <div className="relative w-full">
                <input
                  type="text"
                  value={tempInput}
                  autoFocus
                  onChange={(e) => { setTempInput(e.target.value); setActiveSuggestion(-1); }}
                  onFocus={() => setInputFocused(true)}
                  onBlur={() => {
                    setTimeout(() => {
                      setInputFocused(false);
                      setIsEditingPath(false);
                    }, 250);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (activeSuggestion >= 0 && activeSuggestion < suggestions.length) {
                        pickSuggestion(suggestions[activeSuggestion]);
                        setIsEditingPath(false);
                      } else {
                        let target = tempInput.trim();
                        if (provider.pathSep === "\\") {
                          if (/^[a-zA-Z]$/.test(target)) {
                            target = `${target.toUpperCase()}:\\`;
                          } else if (/^[a-zA-Z]:$/.test(target)) {
                            target = `${target.toUpperCase()}\\`;
                          }
                        }
                        if (target) {
                          setInputFocused(false);
                          setIsEditingPath(false);
                          (e.currentTarget as HTMLInputElement).blur();
                          fetch(target);
                        }
                      }
                    } else if (e.key === "ArrowDown" && suggestions.length > 0) {
                      e.preventDefault(); setActiveSuggestion((p) => (p + 1) % suggestions.length);
                    } else if (e.key === "ArrowUp" && suggestions.length > 0) {
                      e.preventDefault(); setActiveSuggestion((p) => (p - 1 + suggestions.length) % suggestions.length);
                    } else if (e.key === "Escape") {
                      setInputFocused(false);
                      setIsEditingPath(false);
                    }
                  }}
                  placeholder="Path…"
                  className="w-full h-6 px-2 bg-white/[0.04] border border-indigo-400/50 rounded text-[11px] text-zinc-100 font-mono focus:outline-none focus:bg-white/10"
                />
                {inputFocused && suggestions.length > 0 && (
                  <div className="absolute top-[28px] left-0 right-0 max-h-[220px] overflow-y-auto z-50 bg-[#0c0c0e]/95 border border-white/10 rounded-lg shadow-2xl p-1 backdrop-blur-md font-mono text-[11px] text-zinc-200 no-scrollbar">
                    {suggestions.map((s, idx) => (
                      <button key={s.path} onClick={() => { pickSuggestion(s); setIsEditingPath(false); }}
                        className={`w-full flex items-center justify-between p-1.5 rounded text-left transition-colors ${
                          idx === activeSuggestion ? "bg-indigo-500/30 text-white font-bold" : "hover:bg-white/5 hover:text-white"
                        }`}>
                        <div className="flex items-center gap-2 truncate">
                          {s.isDir ? <Folder size={11} className="text-indigo-300 shrink-0" /> : <File size={11} className="text-zinc-500 shrink-0" />}
                          <span className="truncate">{s.name}</span>
                        </div>
                        {s.isDir && <span className="text-[9px] bg-indigo-500/20 text-indigo-300 px-1 rounded">dir</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <button onClick={() => fetch(currentPath)} title="Refresh"
            className={`p-1 rounded bg-white/[0.04] border border-white/10 text-zinc-200 hover:bg-white/10 shrink-0 ${loading ? "animate-spin" : ""}`}>
            <RefreshCw size={11} />
          </button>
          {bookmarksEnabled && (
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setBookmarksOpen(!bookmarksOpen)}
                title="Directory Bookmarks & Quick Jumps"
                className={`p-1 rounded bg-white/[0.04] border border-white/10 text-zinc-200 hover:bg-white/10 shrink-0 transition-colors ${
                  isCurrentBookmarked ? "text-amber-400 border-amber-400/40 bg-amber-500/10" : ""
                }`}
              >
                <Bookmark size={11} className={isCurrentBookmarked ? "fill-amber-400 text-amber-400" : ""} />
              </button>
              <SftpBookmarksPopover
                isOpen={bookmarksOpen}
                onClose={() => setBookmarksOpen(false)}
                currentPath={currentPath}
                isRemote={isRemote}
                onNavigate={(targetPath) => fetch(targetPath)}
                sessionId={sessionId}
                serverId={serverId}
                profile={profile}
              />
            </div>
          )}
          {/* Send CD to Terminal */}
          <button
            onClick={() => sendTerminalCd(currentPath)}
            title="Open in Terminal (cd to current directory)"
            className="p-1 rounded bg-white/[0.04] border border-white/10 text-amber-400 hover:bg-white/10 shrink-0"
          >
            <TerminalSquare size={11} />
          </button>

          {/* Follow Terminal CWD */}
          {(terminalId || isRemote) && (
            <button
              onClick={() => {
                setFollowTerminal((prev) => {
                  const next = !prev;
                  localStorage.setItem("subterm-sftp-follow-cwd", next ? "true" : "false");
                  if (next && terminalCwd && terminalCwd !== currentPath) {
                    fetch(terminalCwd);
                  }
                  return next;
                });
              }}
              title={followTerminal ? "Auto-following Terminal CWD (Click to disable)" : "Auto-follow Terminal CWD (Click to enable)"}
              className={`p-1 rounded border shrink-0 transition-colors ${
                followTerminal
                  ? "bg-indigo-500/20 text-indigo-300 border-indigo-500/40"
                  : "bg-white/[0.04] text-zinc-400 hover:text-white border-white/10"
              }`}
            >
              <Compass size={11} className={followTerminal ? "animate-spin" : ""} />
            </button>
          )}

          {/* Jump to Shell CWD Badge */}
          {terminalCwd && terminalCwd !== currentPath && !followTerminal && (
            <button
              onClick={() => fetch(terminalCwd)}
              title={`Terminal is in ${terminalCwd}. Click to jump.`}
              className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 flex items-center gap-1 shrink-0 font-mono transition-colors"
            >
              <TerminalSquare size={10} />
              <span className="truncate max-w-[90px]">Shell: {terminalCwd.split(/[\\/]/).filter(Boolean).pop() || terminalCwd}</span>
            </button>
          )}

          {isRemote && (
            <button
              onClick={() => setFuzzySearchOpen(true)}
              title="Quick Search Files (Ctrl+P)"
              className="p-1 rounded bg-white/[0.04] border border-white/10 text-indigo-400 hover:bg-white/10 shrink-0"
            >
              <Search size={11} />
            </button>
          )}
        </div>
        <div className="h-5 w-px bg-white/10 shrink-0" />
        <div className="flex items-center gap-1 shrink-0 relative">
          {provider.id === "local" && (
            <button
              onClick={async () => {
                if (IS_MOBILE_OS) {
                  // First open pulls the quick-dir list; subsequent opens
                  // reuse the cached list so scoped-storage probes don't
                  // rerun on every click.
                  if (!androidQuickDirs) {
                    try {
                      const dirs = await invoke<{ label: string; path: string }[]>("android_quick_dirs");
                      setAndroidQuickDirs(dirs);
                    } catch (err) {
                      notify(`Browse failed: ${err}`, "error");
                      return;
                    }
                  }
                  setAndroidPickerOpen((v) => !v);
                  return;
                }
                try {
                  const picked = await invoke<string | null>("select_local_folder");
                  if (picked) await fetch(picked);
                } catch (err) {
                  notify(`Browse failed: ${err}`, "error");
                }
              }}
              title="Browse for folder"
              className="p-1 rounded bg-white/[0.04] border border-white/10 text-emerald-300 hover:bg-white/10"
            >
              <FolderSearch size={11} />
            </button>
          )}
          {IS_MOBILE_OS && androidPickerOpen && androidQuickDirs && (
            <div className="absolute top-[24px] right-0 z-50 min-w-[180px] bg-[#0c0c0e]/95 border border-white/10 rounded-lg shadow-2xl p-1 backdrop-blur-md font-mono text-[11px]">
              {androidQuickDirs.length === 0 ? (
                <div className="p-2 text-zinc-400 text-[10.5px]">
                  No writable locations found. On Android 11+ shared storage
                  requires SAF — the app can only read/write its own scoped
                  storage directly.
                </div>
              ) : androidQuickDirs.map((d) => (
                <button
                  key={d.path}
                  onClick={() => { setAndroidPickerOpen(false); fetch(d.path); }}
                  className="w-full flex items-center gap-2 p-1.5 rounded text-left text-zinc-200 hover:bg-white/10 hover:text-white"
                >
                  <Folder size={11} className="text-indigo-300 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{d.label}</div>
                    <div className="truncate text-[9.5px] text-zinc-500">{d.path}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
          <button onClick={() => setModal({ type: "mkdir", v1: "" })} title="New Folder"
            className="p-1 rounded bg-white/[0.04] border border-white/10 text-indigo-300 hover:bg-white/10">
            <Folder size={11} />
          </button>
          <button
            onClick={() => {
              setShowHiddenFiles((prev) => {
                const next = !prev;
                localStorage.setItem("subterm-sftp-show-hidden", next ? "true" : "false");
                return next;
              });
            }}
            title={showHiddenFiles ? "Hide dotfiles / hidden files (Ctrl+H)" : `Show dotfiles / hidden files (${hiddenCount} hidden) (Ctrl+H)`}
            className={`p-1 rounded border border-white/10 hover:bg-white/10 transition-colors ${
              !showHiddenFiles
                ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                : "bg-white/[0.04] text-zinc-400 hover:text-white"
            }`}
          >
            {showHiddenFiles ? <Eye size={11} /> : <EyeOff size={11} />}
          </button>
          <button
            onClick={toggleSelectAll}
            disabled={sortedEntries.length === 0}
            title={allSelected ? "Deselect all (Ctrl+A)" : "Select all (Ctrl+A)"}
            className={`p-1 rounded border border-white/10 hover:bg-white/10 disabled:opacity-30 ${
              allSelected
                ? "bg-indigo-500/20 text-indigo-200"
                : "bg-white/[0.04] text-zinc-300"
            }`}
          >
            {allSelected ? <CheckSquare size={11} /> : <Square size={11} />}
          </button>
          <button
            onClick={() => {
              setShowTree((prev) => {
                const next = !prev;
                localStorage.setItem("subterm-filepanel-show-tree", next ? "true" : "false");
                return next;
              });
            }}
            title={showTree ? "Hide Directory Tree (Alt+T)" : "Show Directory Tree (Alt+T)"}
            className={`p-1 rounded border border-white/10 hover:bg-white/10 transition-colors ${
              showTree
                ? "bg-indigo-500/20 text-indigo-300 border-indigo-500/40"
                : "bg-white/[0.04] text-zinc-400 hover:text-white"
            }`}
          >
            <FolderTree size={11} />
          </button>
        </div>
      </div>

      {/* Body container: optional collapsible Directory Tree sidebar + File list area */}
      <div className="flex-1 flex overflow-hidden min-h-0 w-full gap-1.5 mt-1 relative">
        {showTree && (
          <div className="w-56 shrink-0 h-full rounded-lg overflow-hidden border border-white/5 shadow-lg bg-[#0e0e12]/60">
            <DirectoryTree
              provider={provider}
              currentPath={currentPath}
              onSelectPath={(p) => fetch(p)}
              showHidden={showHiddenFiles}
              sessionId={sessionId}
              terminalId={terminalId}
              onCdTerminal={sendTerminalCd}
            />
          </div>
        )}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 h-full overflow-hidden relative gap-1.5">
          {/* Filter row — always visible, narrow (24 px). Lets the user trim
          the rendered list by name without touching sort or the path bar.
          Sticky across cd so they can hunt the same name across sibling
          dirs; the X clears, Esc on the input clears too. */}
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 bg-[#0e0e10] border border-white/5 rounded text-[10.5px] font-mono">
        <Search size={11} className="text-zinc-500 shrink-0" />
        <input
          type="text"
          value={nameFilter}
          onChange={(e) => setNameFilter(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") { setNameFilter(""); (e.currentTarget as HTMLInputElement).blur(); } }}
          placeholder="Filter by name…"
          className="flex-1 min-w-0 h-5 bg-transparent text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
        />
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as FileTypeFilter)}
          className={`h-5 px-1 rounded text-[10px] border outline-none font-mono transition-colors shrink-0 ${
            typeFilter !== "all"
              ? "bg-indigo-500/20 text-indigo-300 border-indigo-500/40 font-bold"
              : "bg-white/[0.04] text-zinc-400 border-white/5 hover:text-white"
          }`}
          title="Filter by file type"
        >
          <option value="all">All types</option>
          <option value="dirs">📁 Folders</option>
          <option value="code">⚙️ Code/Config</option>
          <option value="logs">📜 Logs</option>
          <option value="archives">📦 Archives</option>
          <option value="media">🖼️ Media</option>
        </select>
        {!showHiddenFiles && hiddenCount > 0 && (
          <span
            className="text-[9px] px-1.5 py-0.5 bg-amber-500/10 text-amber-300/90 border border-amber-500/20 rounded shrink-0 cursor-pointer hover:bg-amber-500/20 transition-colors"
            title="Click to reveal dotfiles (Ctrl+H)"
            onClick={() => {
              setShowHiddenFiles(true);
              localStorage.setItem("subterm-sftp-show-hidden", "true");
            }}
          >
            {hiddenCount} hidden
          </span>
        )}
        {nameFilter && (
          <>
            <span className="text-[9.5px] text-zinc-500 shrink-0">
              {sortedEntries.length}/{entries.length}
            </span>
            <button
              onClick={() => setNameFilter("")}
              title="Clear filter"
              className="shrink-0 p-0.5 rounded text-zinc-400 hover:text-white hover:bg-white/10"
            >
              <X size={10} />
            </button>
          </>
        )}
      </div>

      {/* Bulk action bar — shows for any non-empty selection so the user can
          send / move / delete with one click without right-clicking. It is a
          FLOATING overlay (absolute, pinned bottom-center) rather than a flex
          sibling, so its appearance never pushes the file list down — the rows
          stay exactly where they are when a selection starts. */}
      {selected.size > 0 && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 max-w-[calc(100%-1rem)] flex flex-wrap items-center justify-center gap-1.5 px-2.5 py-1.5 bg-indigo-950/95 border border-indigo-500/40 rounded-lg shadow-2xl shadow-black/50 backdrop-blur-md text-[10.5px] text-indigo-100 font-mono">
          <span className="font-bold uppercase tracking-wider text-[9.5px] text-indigo-300 shrink-0">
            {selected.size} selected
          </span>
          <div className="flex-1" />
          {peerTransfer && (
            <button
              onClick={() => copyToPeer(sortedEntries.filter(e => selected.has(e.path)))}
              title={getOppositeDir?.() ? `Copy to ${peerTransfer.label}: ${getOppositeDir!()}` : "Open a folder in the other pane first"}
              disabled={!getOppositeDir?.()}
              className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Copy size={10} /> Copy to {peerTransfer.label}
            </button>
          )}
          {isRemote && !peerTransfer && (
            <button
              onClick={() => downloadItems(sortedEntries.filter(e => selected.has(e.path)))}
              title={getOppositeDir?.()
                ? `Download to ${getOppositeDir!()}`
                : "Pick a destination folder…"}
              className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 flex items-center gap-1"
            >
              <Download size={10} /> Download
            </button>
          )}
          {!isRemote && sessionId && (
            <button
              onClick={() => uploadItems(sortedEntries.filter(e => selected.has(e.path)))}
              title={getOppositeDir?.()
                ? `Upload to ${getOppositeDir!()}`
                : "Open a remote directory first…"}
              disabled={!getOppositeDir?.()}
              className="px-2 py-0.5 rounded bg-sky-500/15 text-sky-300 hover:bg-sky-500/25 flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Upload size={10} /> Upload
            </button>
          )}
          <button
            onClick={() => setModal({ type: "move-bulk", v1: currentPath })}
            className="px-2 py-0.5 rounded bg-white/5 text-zinc-200 hover:bg-white/10 flex items-center gap-1"
          >
            <Move size={10} /> Move…
          </button>
          <button
            onClick={() => removeItems(sortedEntries.filter(e => selected.has(e.path)))}
            className="px-2 py-0.5 rounded bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 flex items-center gap-1"
          >
            <Trash2 size={10} /> Delete
          </button>
          <button
            onClick={() => { setSelected(new Set()); lastSelectedPathRef.current = null; }}
            className="px-2 py-0.5 rounded bg-white/5 text-zinc-400 hover:bg-white/10 flex items-center gap-1"
          >
            <X size={10} /> Clear
          </button>
        </div>
      )}

      {/* List */}
      <div
        ref={dropTargetRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`flex-1 min-h-0 border rounded-lg bg-[#121214] flex flex-col overflow-y-auto transition-all duration-200 border-indigo-500/30 shadow-2xl shadow-indigo-950/10 ${dragOver ? "border-indigo-400 bg-indigo-950/10" : ""}`}
      >
        {/* The select column is conditionally injected — only present when
            there's at least one selected row. With nothing selected the row
            content reclaims the 22px and the list reads cleanly. Discovery
            paths into multi-select that work without the column visible:
            row click (single select), Ctrl/Shift-click (extend), Ctrl+A
            (select all), right-click → context menu, and the header bar's
            select-all toggle to the right of the address bar. */}
        <div className={`group min-w-full grid ${gridColumns} gap-1.5 px-2.5 bg-[#161619] border-b border-white/5 font-mono text-[10.5px] text-zinc-300 select-none font-bold shrink-0 sticky top-0 z-10 shadow-md`}>
          {/* Select-all — the 22px column is ALWAYS reserved (both here and in
              every row) so starting a selection never shifts the columns
              sideways. The control is revealed on header hover, or whenever a
              selection is already active. */}
          <div
            className={`bg-[#161619] flex items-center justify-center py-1.5 cursor-pointer hover:text-white transition-opacity ${selected.size > 0 ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
            onClick={(e) => { e.stopPropagation(); toggleSelectAll(); }}
            title={allSelected ? "Deselect all" : "Select all"}
          >
            {allSelected ? <CheckSquare size={12} className="text-indigo-300" /> : <Square size={12} className="text-zinc-500" />}
          </div>
          <div className="bg-[#161619] cursor-pointer hover:text-white py-1.5" onClick={() => toggleSort("name")}>
            NAME {sortIcon("name")}
          </div>
          {showDetails && (
            <>
              <div className="bg-[#161619] cursor-pointer hover:text-white text-right py-1.5" onClick={() => toggleSort("size")}>
                SIZE {sortIcon("size")}
              </div>
              <div className="bg-[#161619] cursor-pointer hover:text-white text-right py-1.5" onClick={() => toggleSort("modified")}>
                CHANGED {sortIcon("modified")}
              </div>
            </>
          )}
          {showOwnerColumn && (
            <div className="bg-[#161619] cursor-pointer hover:text-white text-left py-1.5" onClick={() => toggleSort("owner")}>
              OWNER {sortIcon("owner")}
            </div>
          )}
          {showRightsColumn && (
            <div className="bg-[#161619] cursor-pointer hover:text-white text-right py-1.5" onClick={() => toggleSort("permissions")}>
              RIGHTS {sortIcon("permissions")}
            </div>
          )}
        </div>

        <div className="min-w-full p-1 pb-16 font-mono text-[11px]"
             onClick={(e) => {
               // Click landed on the bare list background (not on a row, since
               // rows stopPropagation via their own onClick chain implicitly
               // by being the click target). Clear selection so users can
               // escape a multi-selection without a keyboard shortcut.
               if (e.target === e.currentTarget && !dragJustEndedRef.current) {
                 setSelected(new Set());
                 lastSelectedPathRef.current = null;
               }
             }}>
          {loading && sortedEntries.length === 0 ? (
            <div className="text-center py-14 text-zinc-400">Loading…</div>
          ) : sortedEntries.length === 0 ? (
            <div className="text-center py-14 text-zinc-500">Empty</div>
          ) : (
            sortedEntries.map((entry) => {
              const isSel = selected.has(entry.path);
              return (
              <div
                key={entry.path}
                onMouseDown={(e) => handleRowMouseDown(e, entry)}
                onContextMenu={(e) => openMenu(e, entry)}
                onClick={(e) => onRowClick(e, entry, sortedEntries)}
                onDoubleClick={() => {
                  if (entry.isDir) { fetch(entry.path); return; }
                  if (isTextFile(entry.name) || isImage(entry.name)) {
                    setEditorEntry(entry);
                    return;
                  }
                  if (IS_MOBILE_OS) return;
                  if (isRemote) liveEditEntry(entry);
                  else openLocalEntry(entry);
                }}
                data-fs-row-path={entry.path}
                data-fs-row-isdir={entry.isDir ? "1" : "0"}
                data-fs-drop-path={entry.isDir ? entry.path : undefined}
                className={`group grid ${gridColumns} gap-1.5 px-2.5 py-1 border-l-2 cursor-pointer transition-colors items-center ${
                  dropHover === entry.path
                    ? "bg-indigo-500/20 ring-1 ring-inset ring-indigo-400 border-indigo-400 text-white"
                    : isSel
                    ? "bg-indigo-950/40 border-indigo-400 text-indigo-100 font-bold"
                    : "border-transparent text-zinc-200 hover:bg-white/5 hover:text-white"
                }`}
              >
                {/* Per-row checkbox. Its 22px column is always reserved, so the
                    box appearing never shifts the row's content sideways. Hidden
                    at rest, revealed on row hover or whenever a selection is
                    already active (so any row can be toggled). */}
                <div
                  className={`flex items-center justify-center transition-opacity ${isSel || selected.size > 0 ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    // Pure toggle for this row — doesn't replace the
                    // selection the way a bare row click does. Keeps
                    // existing selection intact and just flips this entry
                    // in/out.
                    e.stopPropagation();
                    const next = new Set(selected);
                    if (next.has(entry.path)) next.delete(entry.path);
                    else next.add(entry.path);
                    setSelected(next);
                    lastSelectedPathRef.current = entry.path;
                  }}
                  title={isSel ? "Deselect" : "Select"}
                >
                  {isSel
                    ? <CheckSquare size={12} className="text-indigo-300" />
                    : <Square size={12} className="text-zinc-500 hover:text-zinc-300" />}
                </div>
                <div className="flex items-center gap-2 min-w-0 pr-1">
                  <div className="relative shrink-0">
                    {entry.isDir
                      ? <Folder size={12} className="text-indigo-300" />
                      : <File size={12} className="text-zinc-500" />}
                    {entry.isSymlink && (
                      <span
                        className="absolute -bottom-0.5 -right-1 leading-none"
                        title="Symlink"
                      >
                        <ExternalLink size={7} className="text-zinc-300 bg-zinc-900 rounded-sm" />
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="truncate text-zinc-100 text-[11px]">{entry.name}</span>
                      {gitFileStatuses[entry.name] && (
                        <span
                          className={`text-[8px] font-mono font-bold px-1 rounded uppercase tracking-wider shrink-0 select-none ${
                            gitFileStatuses[entry.name].includes("M")
                              ? "bg-amber-500/20 text-amber-300"
                              : gitFileStatuses[entry.name].includes("A") || gitFileStatuses[entry.name].includes("?")
                              ? "bg-emerald-500/20 text-emerald-300"
                              : gitFileStatuses[entry.name].includes("D")
                              ? "bg-rose-500/20 text-rose-300"
                              : "bg-zinc-700/50 text-zinc-300"
                          }`}
                          title={`Git Status: ${gitFileStatuses[entry.name]}`}
                        >
                          {gitFileStatuses[entry.name].includes("?") ? "U" : gitFileStatuses[entry.name].trim()}
                        </span>
                      )}
                    </div>
                    {/* Panel-width fallback for metadata columns that do not fit.
                        Their values stay visible below the filename instead of
                        forcing horizontal scrolling in a narrow tool pane. */}
                    {(!showDetails || (showPerms && (!showOwnerColumn || !showRightsColumn))) && (
                      <div className="truncate text-[10px] text-zinc-500 font-mono">
                        {[
                          !showDetails && !entry.isDir ? formatSize(entry.size) : null,
                          !showDetails ? formatTime(entry.modified) : null,
                          showPerms && !showOwnerColumn && entry.uid != null ? `Owner ${ownerLabel(entry.uid)}` : null,
                          showPerms && !showRightsColumn ? formatRights(entry.isDir, entry.permissions) : null,
                        ].filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </div>
                </div>
                {showDetails && (
                  <>
                    <div className="text-right text-[10.5px] text-zinc-300 font-sans">
                      {entry.isDir ? "" : formatSize(entry.size)}
                    </div>
                    <div className="text-right text-[9.5px] text-zinc-400 truncate">
                      {formatTime(entry.modified)}
                    </div>
                  </>
                )}
                {showOwnerColumn && (
                  <div
                    className="text-left text-[10.5px] text-zinc-300 font-mono truncate"
                    title={entry.uid == null ? undefined : `${ownerLabel(entry.uid)} (UID ${entry.uid})`}
                  >
                    {ownerLabel(entry.uid)}
                  </div>
                )}
                {showRightsColumn && (
                  <div className="flex text-right text-[10.5px] text-zinc-300 font-mono opacity-90 items-center justify-end gap-1">
                    <span className="truncate">{formatRights(entry.isDir, entry.permissions)}</span>
                    <button onClick={(e) => openMenu(e, entry)} title="Options"
                      className="opacity-60 hover:opacity-100 p-0.5 rounded hover:bg-white/10 text-zinc-400 hover:text-white shrink-0">
                      <MoreVertical size={11} />
                    </button>
                  </div>
                )}
              </div>
              );
            })
          )}
        </div>
      </div>
        </div>
      </div>

      {/* Context menu (portal) — bulk-aware. When the right-click anchor is
          part of a multi-selection, actions like Download / Move / Delete
          apply to the whole set; per-item actions (Rename, Properties,
          Edit) only show when exactly one row is selected. */}
      {contextMenu && createPortal((() => {
        const selectedEntries = sortedEntries.filter(e => selected.has(e.path));
        const acting = selectedEntries.length > 0 ? selectedEntries : [contextMenu.entry];
        const multi = acting.length > 1;
        const selectedFileCount = acting.filter(e => !e.isDir).length;
        return (
        <div ref={menuRef}
          style={{ top: contextMenu.y, left: contextMenu.x }}
          className="fixed z-[9999] min-w-[180px] bg-[#0c0c0e] border border-white/10 rounded-lg shadow-2xl p-1 backdrop-blur-md font-mono text-[11.5px] text-zinc-200">

          {/* Primary action: open folder, or transfer/edit file. The exact
              set depends on which side this panel is on. */}
          {contextMenu.entry.isDir && !multi ? (
            <button onClick={() => { setContextMenu(null); fetch(contextMenu.entry.path); }}
              className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white">
              <Folder size={11} className="text-indigo-400" /><span>Open</span>
            </button>
          ) : isRemote ? (
            <>
              {peerTransfer ? (
                <button onClick={() => { setContextMenu(null); void copyToPeer(acting); }}
                  className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white">
                  <Copy size={11} className="text-emerald-400" />
                  <span>Copy to {peerTransfer.label}</span>
                </button>
              ) : (
                <button onClick={() => { setContextMenu(null); downloadItems(acting); }}
                  className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white">
                  <Download size={11} className="text-emerald-400" />
                  <span>Download{multi ? ` (${selectedFileCount})` : "…"}</span>
                </button>
              )}
              {/* Live-edit needs a local temp file + a native OS editor + a
                  filesystem watcher. Android has none of those in a form we
                  can bridge, so the backend command returns an error there
                  — hide the menu item entirely rather than surface it. */}
              {!multi && !contextMenu.entry.isDir && !IS_MOBILE_OS && (
                <button onClick={() => { setContextMenu(null); liveEditEntry(contextMenu.entry); }}
                  className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white">
                  <ExternalLink size={11} className="text-indigo-400" /><span>Edit (auto-upload)</span>
                </button>
              )}
            </>
          ) : (
            !multi && !contextMenu.entry.isDir && !IS_MOBILE_OS && (
              <button onClick={() => { setContextMenu(null); openLocalEntry(contextMenu.entry); }}
                className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white">
                <ExternalLink size={11} className="text-indigo-400" /><span>Open</span>
              </button>
            )
          )}

          {/* Quick Preview */}
          {!multi && !contextMenu.entry.isDir && (
            <button onClick={() => { setContextMenu(null); setEditorEntry(contextMenu.entry); }}
              className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white">
              <Eye size={11} className="text-cyan-400" /><span>Quick Preview (Space)</span>
            </button>
          )}

          {/* Edit in SubTerm */}
          {!multi && !contextMenu.entry.isDir && isTextFile(contextMenu.entry.name) && (
            <button onClick={() => { setContextMenu(null); setEditorEntry(contextMenu.entry); }}
              className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white">
              <FileCode size={11} className="text-indigo-400" /><span>Edit in SubTerm</span>
            </button>
          )}

          {/* Compare with the same-named file in the opposite pane */}
          {!multi && !contextMenu.entry.isDir && onCompareWithOpposite && (
            <button onClick={() => { setContextMenu(null); onCompareWithOpposite(contextMenu.entry); }}
              className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white">
              <GitCompare size={11} className="text-sky-400" /><span>Compare with Other Pane</span>
            </button>
          )}

          {/* Deep link: Open in Terminal (cd) */}
          {!multi && (
            <button onClick={() => {
                setContextMenu(null);
                const target = contextMenu.entry.isDir ? contextMenu.entry.path : provider.parentPath(contextMenu.entry.path);
                sendTerminalCd(target);
              }}
              className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white">
              <TerminalSquare size={11} className="text-amber-400" /><span>Open in Terminal (cd)</span>
            </button>
          )}

          {/* Extract / Compress for remote archives */}
          {isRemote && !multi && Boolean(archiveKind(contextMenu.entry.name)) && (
            <button onClick={() => { setContextMenu(null); extractArchive(contextMenu.entry); }}
              className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white">
              <Archive size={11} className="text-violet-400" /><span>Extract Archive Here</span>
            </button>
          )}
          {isRemote && (
            <button onClick={() => { setContextMenu(null); compressToTar(acting); }}
              className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white">
              <Archive size={11} className="text-violet-400" /><span>Compress (.tar.gz)</span>
            </button>
          )}

          {/* Copy name / path */}
          {!multi ? (
            <>
              <button onClick={async () => {
                  setContextMenu(null);
                  await navigator.clipboard.writeText(contextMenu.entry.name);
                  notify(`Copied name: ${contextMenu.entry.name}`, "info");
                }}
                className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white">
                <Copy size={11} className="text-zinc-400" /><span>Copy Name</span>
              </button>
              <button onClick={async () => {
                  setContextMenu(null);
                  await navigator.clipboard.writeText(contextMenu.entry.path);
                  notify(`Copied path: ${contextMenu.entry.path}`, "info");
                }}
                className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white">
                <Copy size={11} className="text-zinc-400" /><span>Copy Path</span>
              </button>
            </>
          ) : (
            <button onClick={async () => {
                setContextMenu(null);
                const allPaths = acting.map(e => e.path).join("\n");
                await navigator.clipboard.writeText(allPaths);
                notify(`Copied ${acting.length} paths`, "info");
              }}
              className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white">
              <Copy size={11} className="text-zinc-400" /><span>{`Copy ${acting.length} Paths`}</span>
            </button>
          )}

          {!isRemote && !multi && !IS_MOBILE_OS && (
            <button onClick={() => { setContextMenu(null); revealLocalEntry(contextMenu.entry); }}
              className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white">
              <FolderSearch size={11} className="text-emerald-300" /><span>Reveal in Explorer</span>
            </button>
          )}

          <div className="h-px bg-white/5 my-1" />

          <button onClick={() => { setContextMenu(null); setModal({ type: "mkdir", v1: "" }); }}
            className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white">
            <Plus size={11} className="text-indigo-300" /><span>New Folder</span>
          </button>
          {!multi && (
            <button onClick={() => { setContextMenu(null); setModal({ type: "rename", entry: contextMenu.entry, v1: contextMenu.entry.name }); }}
              className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white">
              <Edit3 size={11} /><span>Rename</span>
            </button>
          )}
          {!multi && (
            <button
              onClick={() => {
                setContextMenu(null);
                const name = contextMenu.entry.name;
                const extIndex = name.lastIndexOf(".");
                let defaultCopyName: string;
                if (!contextMenu.entry.isDir && extIndex > 0) {
                  defaultCopyName = `${name.slice(0, extIndex)}.copy${name.slice(extIndex)}`;
                } else {
                  defaultCopyName = `${name}.copy`;
                }
                setModal({
                  type: "duplicate",
                  entry: contextMenu.entry,
                  v1: defaultCopyName,
                });
              }}
              className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white"
            >
              <Copy size={11} className="text-sky-300" /><span>Duplicate / Clone…</span>
            </button>
          )}
          <button onClick={() => {
              setContextMenu(null);
              // Both single and bulk move ask for a destination *directory*
              // (we auto-append the original name). Defaulting v1 to the
              // current path means the user only edits the directory part —
              // no chance to fat-finger the filename and rename by accident.
              if (multi) setModal({ type: "move-bulk", v1: currentPath });
              else setModal({ type: "move", entry: contextMenu.entry, v1: currentPath });
            }}
            className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white">
            <Move size={11} /><span>{multi ? `Move (${acting.length}) to…` : "Move to…"}</span>
          </button>
          {!multi && provider.chmod && (
            <button onClick={() => { setContextMenu(null); setModal({ type: "properties", entry: contextMenu.entry, v1: (contextMenu.entry.permissions ? (contextMenu.entry.permissions & 0o777).toString(8) : "755"), v2: contextMenu.entry.uid?.toString() }); }}
              className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white">
              <Shield size={11} /><span>Properties</span>
            </button>
          )}

          <div className="h-px bg-white/5 my-1" />
          <button onClick={() => { setContextMenu(null); removeItems(acting); }}
            className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-rose-950/20 text-left text-rose-400">
            <Trash2 size={11} /><span>Delete{multi ? ` (${acting.length})` : ""}</span>
          </button>
        </div>
        );
      })(),
        document.body
      )}

      {/* Modal */}
      {modal && (
        <div className="fixed inset-0 z-[9998] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setModal(null)}>
          <div onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[320px] bg-[#121214] border border-white/5 rounded-xl shadow-2xl p-4 font-mono text-[11px]">
            <div className="flex items-center justify-between mb-3">
              <span className="font-black uppercase tracking-wider text-zinc-300">
                {modal.type === "rename" ? "Rename" :
                 modal.type === "mkdir" ? "New Directory" :
                 modal.type === "move" ? "Move to…" :
                 modal.type === "move-bulk" ? `Move ${selected.size} items to…` :
                 modal.type === "duplicate" ? "Duplicate / Clone" : "Properties"}
              </span>
              <button onClick={() => setModal(null)} className="text-zinc-500 hover:text-white"><X size={12} /></button>
            </div>
            <div className="space-y-3">
              {modal.type === "properties" ? (
                <>
                  <div>Name: <span className="text-zinc-100 font-bold">{modal.entry?.name}</span></div>
                  <div>Path: <span className="text-zinc-400 text-[10px] block truncate">{modal.entry?.path}</span></div>

                  {/* RWX matrix — owner/group/other × read/write/execute. The
                      checkbox grid is the source of truth; the octal input
                      below mirrors it and accepts manual edits both ways. */}
                  {(() => {
                    const parsed = parseInt(modal.v1 || "0", 8);
                    const mode = isNaN(parsed) ? 0 : parsed & 0o777;
                    const roles: { key: "owner" | "group" | "other"; label: string; shift: number }[] = [
                      { key: "owner", label: "Owner", shift: 6 },
                      { key: "group", label: "Group", shift: 3 },
                      { key: "other", label: "Other", shift: 0 },
                    ];
                    const bits: { key: "r" | "w" | "x"; label: string; bit: number }[] = [
                      { key: "r", label: "R", bit: 4 },
                      { key: "w", label: "W", bit: 2 },
                      { key: "x", label: "X", bit: 1 },
                    ];
                    const toggle = (shift: number, bit: number) => {
                      const next = mode ^ (bit << shift);
                      setModal({ ...modal, v1: (next & 0o777).toString(8).padStart(3, "0") });
                    };
                    return (
                      <div className="pt-1">
                        <label className="text-[10px] text-zinc-400 block mb-1.5 uppercase tracking-wider">Permissions</label>
                        <div className="grid grid-cols-[60px_repeat(3,1fr)] gap-1 text-center text-[10px] text-zinc-400 font-mono">
                          <div />
                          {bits.map((b) => <div key={b.key} className="font-bold">{b.label}</div>)}
                          {roles.map((role) => (
                            <React.Fragment key={role.key}>
                              <div className="text-left text-zinc-300 self-center">{role.label}</div>
                              {bits.map((b) => {
                                const on = ((mode >> role.shift) & b.bit) !== 0;
                                return (
                                  <button
                                    key={b.key}
                                    type="button"
                                    onClick={() => toggle(role.shift, b.bit)}
                                    className={`h-6 rounded border transition-colors ${
                                      on
                                        ? "bg-indigo-500/20 border-indigo-400/40 text-indigo-200"
                                        : "bg-white/[0.04] border-white/10 text-zinc-500 hover:bg-white/[0.08]"
                                    }`}
                                  >
                                    {on ? "✓" : ""}
                                  </button>
                                );
                              })}
                            </React.Fragment>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  <div className="flex gap-2 pt-1">
                    <div className="flex-1">
                      <label className="text-[10px] text-zinc-400 block mb-1">Octal</label>
                      <input type="text" value={modal.v1 || ""}
                        onChange={(e) => {
                          // Only accept 0–3 digits, each 0–7 — anything else is
                          // ignored so the checkbox grid never sees garbage.
                          const v = e.target.value.replace(/[^0-7]/g, "").slice(0, 3);
                          setModal({ ...modal, v1: v });
                        }}
                        className="w-full h-7 px-2 bg-white/5 border border-white/5 rounded text-zinc-200 focus:outline-none focus:border-indigo-400/40 text-[11.5px] font-mono" />
                    </div>
                    <div className="flex-1">
                      <label className="text-[10px] text-zinc-400 block mb-1">Owner UID</label>
                      <input type="text" value={modal.v2 || ""} onChange={(e) => setModal({ ...modal, v2: e.target.value })}
                        className="w-full h-7 px-2 bg-white/5 border border-white/5 rounded text-zinc-200 focus:outline-none focus:border-indigo-400/40 text-[11.5px]" />
                    </div>
                  </div>
                </>
              ) : (
                <div>
                  <label className="text-[10px] text-zinc-400 block mb-1">
                    {modal.type === "move" || modal.type === "move-bulk"
                      ? "Destination directory"
                      : modal.type === "duplicate"
                      ? `Duplicate "${modal.entry?.name}" as:`
                      : "Name"}
                  </label>
                  <input type="text" autoFocus value={modal.v1 || ""}
                    onChange={(e) => setModal({ ...modal, v1: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && submitModal()}
                    className="w-full h-7 px-2 bg-white/5 border border-white/5 rounded text-zinc-200 focus:outline-none focus:border-indigo-400/40 text-[11.5px] font-mono" />
                </div>
              )}
              <div className="flex gap-2 justify-end pt-2">
                <button onClick={() => setModal(null)} className="px-3 h-7 rounded border border-white/5 text-zinc-400 hover:text-white">Cancel</button>
                <button onClick={submitModal} className="px-3 h-7 rounded bg-indigo-500 text-white font-bold hover:bg-indigo-600">
                  {modal.type === "duplicate" ? "Duplicate" : "Apply"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Quick In-App Code Editor */}
      {editorEntry && (
        <QuickEditorModal
          isOpen={Boolean(editorEntry)}
          onClose={() => setEditorEntry(null)}
          entry={editorEntry}
          provider={provider}
          sessionId={sessionId}
          onSaved={() => fetch(currentPath)}
        />
      )}

      {/* Quick Fuzzy File Search */}
      {fuzzySearchOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-100">
          <div className="w-full max-w-lg bg-[#0e0e12] border border-white/10 rounded-xl shadow-2xl flex flex-col overflow-hidden">
            <div className="p-3 border-b border-white/10 flex items-center gap-2.5 bg-[#121217]">
              <Search size={14} className="text-indigo-400 shrink-0" />
              <input
                type="text"
                autoFocus
                value={fuzzyQuery}
                onChange={(e) => setFuzzyQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setFuzzySearchOpen(false);
                }}
                placeholder="Search files in current directory..."
                className="flex-1 bg-transparent text-xs text-white placeholder-zinc-500 focus:outline-none font-mono"
              />
              <button onClick={() => setFuzzySearchOpen(false)} className="text-zinc-500 hover:text-white">
                <X size={14} />
              </button>
            </div>
            <div className="max-h-[50vh] overflow-y-auto p-1 font-mono text-xs no-scrollbar">
              {entries
                .filter(e => !fuzzyQuery.trim() || e.name.toLowerCase().includes(fuzzyQuery.toLowerCase()))
                .slice(0, 30)
                .map((e) => (
                  <button
                    key={e.path}
                    onClick={() => {
                      setFuzzySearchOpen(false);
                      if (e.isDir) {
                        fetch(e.path);
                      } else if (isTextFile(e.name)) {
                        setEditorEntry(e);
                      } else {
                        onRowClick({ shiftKey: false, ctrlKey: false, metaKey: false } as React.MouseEvent, e, entries);
                      }
                    }}
                    className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-white/10 text-left transition-colors"
                  >
                    <div className="flex items-center gap-2 truncate">
                      {e.isDir ? <Folder size={12} className="text-indigo-400 shrink-0" /> : <File size={12} className="text-zinc-400 shrink-0" />}
                      <span className="truncate text-zinc-200">{e.name}</span>
                    </div>
                    <span className="text-[10px] text-zinc-500 shrink-0">
                      {e.isDir ? "Folder" : formatSize(e.size)}
                    </span>
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

FilePanel.displayName = "FilePanel";

export default FilePanel;
