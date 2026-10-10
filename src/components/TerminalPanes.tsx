import React from "react";

export interface PaneInfo {
  /** Index within the split (-1 when this terminal isn't a tile). */
  slotIdx: number;
  /** True when this terminal is currently rendered as a split tile. */
  inTile: boolean;
  /** True when the whole area is in split layout. */
  inSplit: boolean;
  isFocused: boolean;
  /** True when another tile follows this one (i.e. a divider belongs after it). */
  notLast: boolean;
}

interface TerminalPanesProps<T extends { id: string }> {
  terminals: T[];
  /** Ordered ids that share the main area; fewer than 2 means "no split". */
  splitTerminals: string[];
  orientation: "h" | "v";
  ratios: number[];
  isCompact: boolean;
  activeTab: string;
  onFocusPane: (id: string) => void;
  renderPane: (terminal: T, info: PaneInfo) => React.ReactNode;
}

/**
 * Lays terminals out as either a stack (one visible) or split tiles.
 *
 * INVARIANT (do not break): both layouts render the SAME flat, id-keyed list of
 * wrappers inside the SAME container element, and only wrapper styles change.
 * Rendering the two layouts as separate trees makes React remount every
 * terminal on split/unsplit, which recreates xterm and wipes its scrollback.
 * See TerminalPanes.test.ts.
 */
export function TerminalPanes<T extends { id: string }>({
  terminals, splitTerminals, orientation, ratios, isCompact, activeTab, onFocusPane, renderPane,
}: TerminalPanesProps<T>) {
  const inSplit = splitTerminals.length >= 2 && !isCompact;
  return (
    <div className={inSplit ? `absolute inset-0 flex ${orientation === "h" ? "flex-row" : "flex-col"}` : "contents"}>
      {terminals.map((t) => {
        const slotIdx = inSplit ? splitTerminals.indexOf(t.id) : -1;
        const inTile = slotIdx >= 0;
        const isFocused = activeTab === t.id;
        const grow = ratios[slotIdx] ?? 1;
        const notLast = inTile && slotIdx < splitTerminals.length - 1;
        return (
          <div
            key={t.id}
            data-terminal-pane={t.id}
            style={inTile ? { flexGrow: grow, flexBasis: 0, order: slotIdx } : undefined}
            onMouseDown={inTile ? () => onFocusPane(t.id) : undefined}
            onTouchStart={inTile ? () => onFocusPane(t.id) : undefined}
            className={
              inTile
                ? `group/pane relative min-w-0 min-h-0 border ${
                    isFocused
                      ? "border-primary/40 shadow-[inset_0_0_0_1px_rgba(var(--primary),0.15)]"
                      : "border-white/[0.03]"
                  }`
                : inSplit
                  ? "hidden"
                  : `absolute inset-0 ${isFocused ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"}`
            }
          >
            {renderPane(t, { slotIdx, inTile, inSplit, isFocused, notLast })}
          </div>
        );
      })}
    </div>
  );
}
