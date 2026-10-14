// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("AI copilot open event targeting", () => {
  const sessionId = "session-test";

  // Simulate two panes in a split session registering their handleOpenCopilot listeners
  // exactly as implemented in TerminalView.
  function createPane(terminalId: string, getIsActive: () => boolean, isAiEnabled: () => boolean = () => true) {
    let showCopilot = false;
    const handleOpenCopilot = (e?: Event) => {
      if (!isAiEnabled()) return;
      const targetTerminalId = (e as CustomEvent<{ terminalId?: string } | undefined>)?.detail?.terminalId;
      if (targetTerminalId ? targetTerminalId !== terminalId : !getIsActive()) return;
      showCopilot = true;
    };

    window.addEventListener(`submarine-open-copilot-${sessionId}`, handleOpenCopilot);
    return {
      get showCopilot() {
        return showCopilot;
      },
      cleanup: () => {
        window.removeEventListener(`submarine-open-copilot-${sessionId}`, handleOpenCopilot);
      },
    };
  }

  let pane1: ReturnType<typeof createPane>;
  let pane2: ReturnType<typeof createPane>;
  let activeTab = "pane-1";

  beforeEach(() => {
    activeTab = "pane-1";
    pane1 = createPane("pane-1", () => activeTab === "pane-1");
    pane2 = createPane("pane-2", () => activeTab === "pane-2");
  });

  afterEach(() => {
    pane1.cleanup();
    pane2.cleanup();
  });

  it("opens the assistant only in the active pane when target terminalId is dispatched", () => {
    // Toolbar AI button dispatches with detail.terminalId = activeTab
    window.dispatchEvent(
      new CustomEvent(`submarine-open-copilot-${sessionId}`, {
        detail: { terminalId: activeTab },
      })
    );

    expect(pane1.showCopilot).toBe(true);
    expect(pane2.showCopilot).toBe(false);
  });

  it("opens the assistant in pane 2 when pane 2 is the active window", () => {
    activeTab = "pane-2";

    window.dispatchEvent(
      new CustomEvent(`submarine-open-copilot-${sessionId}`, {
        detail: { terminalId: activeTab },
      })
    );

    expect(pane1.showCopilot).toBe(false);
    expect(pane2.showCopilot).toBe(true);
  });

  it("falls back to checking active status if detail.terminalId is omitted", () => {
    // Legacy / external event dispatch without detail
    window.dispatchEvent(new CustomEvent(`submarine-open-copilot-${sessionId}`));

    expect(pane1.showCopilot).toBe(true);
    expect(pane2.showCopilot).toBe(false);
  });
});
