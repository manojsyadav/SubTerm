import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Home,
  HardDrive,
  TerminalSquare,
  Copy,
  FolderTree,
  Minimize2,
} from "lucide-react";
import { FileProvider } from "../fs/types";

export interface DirectoryTreeProps {
  provider: FileProvider;
  currentPath: string;
  onSelectPath: (path: string) => void;
  showHidden?: boolean;
  sessionId?: string;
  terminalId?: string;
  onCdTerminal?: (path: string) => void;
  className?: string;
}

interface TreeNode {
  path: string;
  name: string;
  isExpanded: boolean;
  isLoading: boolean;
  children: TreeNode[] | null;
}

function normalizePath(p: string, sep: string): string {
  if (!p) return sep;
  const trimmed = p.replace(/[\\/]+$/, "");
  return trimmed || sep;
}

function isAncestorOrEqual(parentPath: string, childPath: string, sep: string): boolean {
  const pNorm = normalizePath(parentPath, sep);
  const cNorm = normalizePath(childPath, sep);
  if (pNorm === cNorm) return true;
  if (pNorm === sep) return true;
  return cNorm.startsWith(pNorm.endsWith(sep) ? pNorm : `${pNorm}${sep}`);
}

export const DirectoryTree: React.FC<DirectoryTreeProps> = ({
  provider,
  currentPath,
  onSelectPath,
  showHidden = true,
  sessionId,
  terminalId: _terminalId,
  onCdTerminal,
  className = "",
}) => {
  const [rootNodes, setRootNodes] = useState<TreeNode[]>([]);
  const [loadingRoot, setLoadingRoot] = useState(false);
  const [homeDir, setHomeDir] = useState<string>("");
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    node: TreeNode;
  } | null>(null);

  const sep = provider.pathSep;
  const currentNorm = normalizePath(currentPath, sep);

  // Load children for a folder
  const fetchChildren = useCallback(
    async (dirPath: string): Promise<TreeNode[]> => {
      try {
        const res = await provider.list(dirPath);
        return res.entries
          .filter((e) => e.isDir && (showHidden || !e.name.startsWith(".")))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
          .map((e) => ({
            path: e.path,
            name: e.name,
            isExpanded: false,
            isLoading: false,
            children: null,
          }));
      } catch {
        return [];
      }
    },
    [provider, showHidden]
  );

  // Initialize or reload root nodes
  const initTree = useCallback(async () => {
    setLoadingRoot(true);
    try {
      let home = "";
      try {
        home = await provider.homePath();
        setHomeDir(home);
      } catch {
        home = sep;
      }

      const roots: TreeNode[] = [];

      if (provider.id === "local" && sep === "\\") {
        // Windows local filesystem: query all available drives
        let drives: string[] = [];
        try {
          drives = await invoke<string[]>("local_drives");
        } catch {
          drives = ["C:\\"];
        }
        if (!drives.length) drives = ["C:\\"];

        // If currentPath is on a drive not in list, add it
        const curMatch = currentPath.match(/^([A-Za-z]:[\\/]?)/);
        const curDrive = curMatch
          ? (curMatch[1].toUpperCase().endsWith("\\") ? curMatch[1].toUpperCase() : `${curMatch[1].toUpperCase()}\\`)
          : null;
        if (curDrive && !drives.some((d) => d.toUpperCase() === curDrive)) {
          drives.push(curDrive);
        }

        const activeDrive = curDrive || drives[0];

        for (const drive of drives) {
          const isActive = drive.toUpperCase() === activeDrive.toUpperCase();
          const children = isActive ? await fetchChildren(drive) : null;
          roots.push({
            path: drive,
            name: `Drive (${drive.slice(0, 2).toUpperCase()})`,
            isExpanded: isActive,
            isLoading: false,
            children,
          });
        }

        // Add Home Directory shortcut node if home is distinct
        if (home && !roots.some((r) => normalizePath(r.path, sep) === normalizePath(home, sep))) {
          const homeChildren = await fetchChildren(home);
          roots.push({
            path: home,
            name: "Home (~)",
            isExpanded: false,
            isLoading: false,
            children: homeChildren,
          });
        }
      } else {
        // Unix or Remote SFTP
        const rootPath = "/";
        const rootChildren = await fetchChildren(rootPath);
        roots.push({
          path: rootPath,
          name: "Root (/)",
          isExpanded: true,
          isLoading: false,
          children: rootChildren,
        });

        if (home && normalizePath(home, sep) !== "/" && !home.startsWith("//")) {
          const homeChildren = await fetchChildren(home);
          roots.push({
            path: home,
            name: "Home (~)",
            isExpanded: false,
            isLoading: false,
            children: homeChildren,
          });
        }
      }

      setRootNodes(roots);
    } finally {
      setLoadingRoot(false);
    }
  }, [fetchChildren, provider, currentPath, sep]);

  useEffect(() => {
    initTree();
  }, [initTree]);

  // Toggle node expansion
  const toggleNode = (nodePath: string) => {
    const findNode = (nodes: TreeNode[]): TreeNode | null => {
      for (const n of nodes) {
        if (n.path === nodePath) return n;
        if (n.children) {
          const found = findNode(n.children);
          if (found) return found;
        }
      }
      return null;
    };

    const target = findNode(rootNodes);
    const needFetch = target ? !target.isExpanded && target.children === null : false;

    setRootNodes((prev) => {
      const toggleRec = (nodes: TreeNode[]): TreeNode[] =>
        nodes.map((node) => {
          if (node.path === nodePath) {
            const nextExpanded = !node.isExpanded;
            const isLoading = nextExpanded && node.children === null;
            return {
              ...node,
              isExpanded: nextExpanded,
              isLoading,
            };
          }
          if (node.children) {
            return {
              ...node,
              children: toggleRec(node.children),
            };
          }
          return node;
        });
      return toggleRec(prev);
    });

    if (needFetch) {
      fetchChildren(nodePath).then((kids) => {
        setRootNodes((currRoots) => {
          const patchKids = (list: TreeNode[]): TreeNode[] =>
            list.map((item) => {
              if (item.path === nodePath) {
                return { ...item, isLoading: false, children: kids };
              }
              if (item.children) {
                return { ...item, children: patchKids(item.children) };
              }
              return item;
            });
          return patchKids(currRoots);
        });
      });
    }
  };

  // Collapse all nodes
  const collapseAll = () => {
    const collapseRec = (nodes: TreeNode[]): TreeNode[] =>
      nodes.map((n) => ({
        ...n,
        isExpanded: false,
        children: n.children ? collapseRec(n.children) : null,
      }));
    setRootNodes((prev) => collapseRec(prev));
  };

  // Render node recursively
  const renderTreeNode = (node: TreeNode, depth: number) => {
    const nodeNorm = normalizePath(node.path, sep);
    const isSelected = nodeNorm === currentNorm;
    const isAncestor = !isSelected && isAncestorOrEqual(node.path, currentPath, sep);

    return (
      <div key={node.path} className="select-none">
        <div
          data-fs-drop-path={node.path}
          style={{ paddingLeft: `${depth * 14 + 6}px` }}
          className={`group flex items-center gap-1.5 py-1 pr-2 rounded text-[11px] cursor-pointer transition-colors relative ${
            isSelected
              ? "bg-indigo-500/25 text-white font-semibold ring-1 ring-indigo-500/40"
              : isAncestor
              ? "text-indigo-300/90 hover:bg-white/5"
              : "text-zinc-300 hover:text-white hover:bg-white/5"
          }`}
          onClick={() => onSelectPath(node.path)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setContextMenu({ x: e.clientX, y: e.clientY, node });
          }}
          title={node.path}
        >
          {/* Chevron */}
          <button
            type="button"
            className="p-0.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-white/10 shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              toggleNode(node.path);
            }}
          >
            {node.isLoading ? (
              <RefreshCw size={10} className="animate-spin text-indigo-400" />
            ) : node.isExpanded ? (
              <ChevronDown size={11} className="text-zinc-400" />
            ) : (
              <ChevronRight size={11} className="text-zinc-500 group-hover:text-zinc-300" />
            )}
          </button>

          {/* Folder Icon */}
          {node.name.startsWith("Drive (") ? (
            <HardDrive size={12} className="text-emerald-400 shrink-0" />
          ) : node.name === "Home (~)" ? (
            <Home size={12} className="text-amber-400 shrink-0" />
          ) : node.isExpanded ? (
            <FolderOpen size={12} className="text-indigo-400 shrink-0" />
          ) : (
            <Folder size={12} className="text-indigo-300/80 shrink-0" />
          )}

          {/* Label */}
          <span className="truncate flex-1 font-mono text-[11px]">{node.name}</span>
        </div>

        {/* Children */}
        {node.isExpanded && node.children && node.children.length > 0 && (
          <div className="relative">
            {/* Tree branch line */}
            <div
              className="absolute left-0 top-0 bottom-0 border-l border-white/5"
              style={{ left: `${depth * 14 + 11}px` }}
            />
            {node.children.map((child) => renderTreeNode(child, depth + 1))}
          </div>
        )}

        {node.isExpanded && node.children && node.children.length === 0 && (
          <div
            style={{ paddingLeft: `${(depth + 1) * 14 + 16}px` }}
            className="py-1 text-[10px] text-zinc-600 font-mono italic"
          >
            (empty folder)
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className={`flex flex-col h-full bg-[#09090b]/80 border-r border-white/10 overflow-hidden ${className}`}
    >
      {/* Header bar */}
      <div className="h-7 px-2 shrink-0 flex items-center justify-between border-b border-white/5 bg-white/[0.02]">
        <div className="flex items-center gap-1.5 text-zinc-400 text-[10px] font-semibold uppercase tracking-wider">
          <FolderTree size={11} className="text-indigo-400" />
          <span>Folders</span>
        </div>

        <div className="flex items-center gap-0.5">
          {homeDir && (
            <button
              onClick={() => onSelectPath(homeDir)}
              title={`Jump to Home (${homeDir})`}
              className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10"
            >
              <Home size={11} />
            </button>
          )}
          <button
            onClick={collapseAll}
            title="Collapse all"
            className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10"
          >
            <Minimize2 size={11} />
          </button>
          <button
            onClick={initTree}
            title="Refresh directory tree"
            className={`p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 ${
              loadingRoot ? "animate-spin text-indigo-400" : ""
            }`}
          >
            <RefreshCw size={11} />
          </button>
        </div>
      </div>

      {/* Tree body */}
      <div className="flex-1 overflow-y-auto p-1 font-mono text-[11px] no-scrollbar">
        {loadingRoot && rootNodes.length === 0 ? (
          <div className="flex items-center justify-center p-6 text-zinc-500 gap-2">
            <RefreshCw size={12} className="animate-spin text-indigo-400" />
            <span className="text-[11px]">Loading folders…</span>
          </div>
        ) : rootNodes.length === 0 ? (
          <div className="p-4 text-center text-zinc-600 text-[11px]">No folders found</div>
        ) : (
          rootNodes.map((r) => renderTreeNode(r, 0))
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-[9998]" onClick={() => setContextMenu(null)} />
          <div
            style={{
              top: Math.min(contextMenu.y, window.innerHeight - 150),
              left: Math.min(contextMenu.x, window.innerWidth - 180),
            }}
            className="fixed z-[9999] min-w-[170px] bg-[#0c0c0e]/95 border border-white/10 rounded-lg shadow-2xl p-1 backdrop-blur-md font-mono text-[11px] text-zinc-200"
          >
            <button
              onClick={() => {
                const p = contextMenu.node.path;
                setContextMenu(null);
                onSelectPath(p);
              }}
              className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white"
            >
              <Folder size={11} className="text-indigo-400" />
              <span>Open Folder</span>
            </button>

            <button
              onClick={() => {
                const p = contextMenu.node.path;
                setContextMenu(null);
                if (onCdTerminal) {
                  onCdTerminal(p);
                } else if (sessionId) {
                  window.dispatchEvent(
                    new CustomEvent(`submarine-terminal-cd-${sessionId}`, { detail: { path: p } })
                  );
                }
              }}
              className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white"
            >
              <TerminalSquare size={11} className="text-amber-400" />
              <span>Open in Terminal (cd)</span>
            </button>

            <button
              onClick={async () => {
                const p = contextMenu.node.path;
                setContextMenu(null);
                await navigator.clipboard.writeText(p);
              }}
              className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white"
            >
              <Copy size={11} className="text-zinc-400" />
              <span>Copy Full Path</span>
            </button>

            <div className="my-1 border-t border-white/5" />

            <button
              onClick={() => {
                const p = contextMenu.node.path;
                setContextMenu(null);
                toggleNode(p);
              }}
              className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-white/10 text-left hover:text-white"
            >
              <RefreshCw size={11} className="text-emerald-400" />
              <span>Refresh this folder</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
};
