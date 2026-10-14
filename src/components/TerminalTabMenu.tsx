import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Palette, PenLine, Copy, SplitSquareHorizontal, ArrowLeftRight, Save, Search, X, ChevronRight, Check, Pin } from "lucide-react";
import { RenameInput } from "../ui/renameInput";

// Right-click menu for one terminal sub-tab, modelled on Windows Terminal's. Shared by the
// in-session tab strip and the sidebar's Local shell list (which reach it through an event).

export const TAB_COLORS = ["#e74856", "#f7630c", "#fce100", "#16c60c", "#0078d4", "#886ce4", "#e3008c", "#767676"];

export type TabMenuAction =
  | "pin" | "duplicate" | "split" | "moveLeft" | "moveRight" | "export" | "find"
  | "closeOthers" | "closeRight" | "close";

interface Props {
  x: number;
  y: number;
  title: string;
  color?: string;
  isPinned?: boolean;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  canClose: boolean;
  canCloseRight: boolean;
  onAction: (a: TabMenuAction) => void;
  onRename: (title: string) => void;
  onColor: (color: string | undefined) => void;
  onDismiss: () => void;
}

export function TerminalTabMenu({ x, y, title, color, isPinned, canMoveLeft, canMoveRight, canClose, canCloseRight, onAction, onRename, onColor, onDismiss }: Props) {
  const [sub, setSub] = useState<"color" | "rename" | "move" | "close" | null>(null);
  const row = "w-full flex items-center gap-2.5 px-3 py-1.5 rounded text-left text-zinc-200 hover:bg-white/[0.07] disabled:opacity-35 disabled:hover:bg-transparent";
  const act = (a: TabMenuAction) => () => { onAction(a); onDismiss(); };
  const flyout = "absolute left-full top-0 ml-1 w-44 bg-[#1b1b21] border border-white/10 rounded-lg shadow-2xl p-1";
  const parent = (key: typeof sub, icon: ReactNode, label: string, children: ReactNode, disabled = false) => (
    <div className="relative" onMouseEnter={() => !disabled && setSub(key)}>
      <button type="button" disabled={disabled} aria-haspopup="menu" aria-expanded={sub === key} onClick={() => setSub(sub === key ? null : key)} className={row}>
        {icon}<span className="flex-1">{label}</span><ChevronRight size={13} className="text-zinc-500" />
      </button>
      {sub === key && <div role="menu" className={flyout}>{children}</div>}
    </div>
  );
  const plain = (icon: ReactNode, label: string, onClick: () => void, disabled = false) => (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick} onMouseEnter={() => sub !== "rename" && setSub(null)} className={row}>
      {icon}<span className="flex-1">{label}</span>
    </button>
  );

  return createPortal(
    <>
      <div className="fixed inset-0 z-[9998]" onClick={onDismiss} onContextMenu={(e) => { e.preventDefault(); onDismiss(); }} />
      <div
        role="menu"
        aria-label={`Tab ${title}`}
        style={{ left: Math.min(x, window.innerWidth - 410), top: Math.min(y, window.innerHeight - 330) }}
        className="fixed z-[9999] w-52 bg-[#1b1b21] border border-white/10 rounded-lg shadow-2xl p-1 text-[12px]"
        onKeyDown={(e) => { if (e.key === "Escape") onDismiss(); }}
      >
        {parent("color", <Palette size={14} />, "Change tab color", (
          <div className="p-1.5 flex flex-col gap-1.5">
            <div className="grid grid-cols-4 gap-1.5">
              {TAB_COLORS.map((c) => (
                <button key={c} type="button" aria-label={`Color ${c}`} onClick={() => { onColor(c); onDismiss(); }}
                  className="h-6 rounded flex items-center justify-center border border-white/10 hover:scale-110 transition-transform" style={{ background: c }}>
                  {color === c && <Check size={12} className="text-white drop-shadow" />}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => { onColor(undefined); onDismiss(); }} className="text-left px-1 py-0.5 rounded text-zinc-300 hover:bg-white/[0.07]">Reset</button>
          </div>
        ))}
        {sub === "rename"
          ? <RenameInput initialValue={title} placeholder="Tab title…" onCommit={(v) => { if (v.trim()) onRename(v.trim()); onDismiss(); }} onCancel={onDismiss} />
          : plain(<PenLine size={14} />, "Rename tab", () => setSub("rename"))}
        {plain(
          <Pin size={14} className={isPinned ? "text-primary" : ""} />,
          isPinned ? "Unpin tab" : "Pin tab",
          act("pin")
        )}
        {plain(<Copy size={14} />, "Duplicate tab", act("duplicate"))}
        {plain(<SplitSquareHorizontal size={14} />, "Split tab", act("split"))}
        {parent("move", <ArrowLeftRight size={14} />, "Move tab", <>
          {plain(<span className="w-3.5" />, "Move up / left", act("moveLeft"), !canMoveLeft)}
          {plain(<span className="w-3.5" />, "Move down / right", act("moveRight"), !canMoveRight)}
        </>, !canMoveLeft && !canMoveRight)}
        {plain(<Save size={14} />, "Export text", act("export"))}
        {plain(<Search size={14} />, "Find", act("find"))}
        <div className="my-1 border-t border-white/5" />
        {parent("close", <span className="w-3.5" />, "Close", <>
          {plain(<span className="w-3.5" />, "Close other tabs", act("closeOthers"), !canClose)}
          {plain(<span className="w-3.5" />, "Close tabs below / right", act("closeRight"), !canCloseRight)}
        </>, !canClose)}
        {plain(<X size={14} />, "Close tab", act("close"), !canClose)}
      </div>
    </>,
    document.body,
  );
}
