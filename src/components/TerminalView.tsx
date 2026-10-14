import { parseOsc7, parsePromptCwd, parsePromptGitBranch, setTerminalCwd, setTerminalGitBranch, forgetTerminalCwd } from "../terminal/cwd";
import { isFeatureEnabled, useFeatureFlag } from "../featureFlags";
import { getFileLinkRegex } from "../terminal/fileLinkTypes";
import { saveTextFile } from "../terminal/saveFile";
import { startRecording, stopRecording, getRecorder, isRecording, onRecordingChange, castToPlainText } from "../terminal/recorder";
import { isAlwaysRecorded, setAlwaysRecorded, markAutoRecording, unmarkAutoRecording, isAutoRecording, saveAutoRecording } from "../terminal/autoRecord";
import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import { Terminal, ILink } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { SearchAddon, ISearchOptions } from 'xterm-addon-search';
import { WebglAddon } from 'xterm-addon-webgl';
import { invoke, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { localShellKind, quotePaths, remoteDropPath, toCssPoint } from '../terminal/dropPaths';
import { MoreVertical, AlertTriangle, FileCode, Play, X, Copy, Check, Sparkles, ChevronUp, ChevronDown } from 'lucide-react';
import 'xterm/css/xterm.css';
import { useIsNarrow } from '../hooks/useViewport';
import { MobileKeyBar, ModifiersState, ModKey } from './MobileKeyBar';
import { useBroadcast } from '../ui/broadcast';
import HistorySearchOverlay from './HistorySearchOverlay';
import type { AiSeed } from './AiPanel';
const AiPanel = lazy(() => import('./AiPanel').then((m) => ({ default: m.AiPanel })));
import { matchesKeyCombo, getActiveShortcut } from '../shortcuts';
import { TerminalContextMenu, ContextMenuState } from './TerminalContextMenu';
import { IS_MOBILE_OS } from '../util/platform';
import { windowsPtyFor } from '../terminal/windowsPty';
import { parseSshCommand, parseSshFromScreen, sshTargetKey, SshTarget, SSH_ENDED_RE, endsWithWindowsShellPrompt } from '../terminal/sshCommand';
import { getTerminalTheme } from '../terminal/themes';
import { withCursorColor } from '../terminal/cursorColor';
import { readOpacity, withBackgroundOpacity } from '../ui/windowOpacity';
import { notifyDesktop, shouldNotifyLongCommand } from '../util/desktopNotify';
import { playTerminalBellChime } from '../terminal/bell';
import { looksLikePasswordPrompt, looksLikeSudoPrompt, probeWasEchoed } from '../terminal/passwordPrompt';
import { compileTriggers, getTerminalTriggers, matchTriggers, TRIGGERS_CHANGED_EVENT } from '../terminal/triggers';

const DESTRUCTIVE_REGEX = /\b(rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--force|-[a-zA-Z]*f[a-zA-Z]*r)|mkfs|dd\s+if=.*of=|drop\s+(database|table)|shutdown|reboot|systemctl\s+(stop|disable|restart)|docker\s+rm\s+-f|docker\s+system\s+prune|kubeadm\s+reset|kubectl\s+delete\s+(ns|node|pod\s+--all)|:\(\)\s*\{\s*:\|:&\s*\};:)\b/i;

// Shared search options — highlight all matches in yellow, the active
// match in orange. `decorations` uses the marker overlay so the highlight
// survives scrollback and repaints (the addon's built-in selection-based
// mode would clobber the user's own selection every keystroke). The
// overview-ruler fields are typed as required in xterm-addon-search 0.13
// but we don't render an overview ruler (no `overviewRulerLane` on the
// terminal), so their values are cosmetic — mirror the match colors so
// they'd still read sensibly if a ruler were ever enabled.
const SEARCH_OPTIONS: ISearchOptions = {
  caseSensitive: false,
  decorations: {
    matchBackground: '#facc15',
    matchBorder: '#facc15',
    matchOverviewRuler: '#facc15',
    activeMatchBackground: '#f97316',
    activeMatchBorder: '#f97316',
    activeMatchColorOverviewRuler: '#f97316',
  },
};

// State machine for the modifier stickies on the mobile key bar.
// off → armed → locked → off (cycled by repeated taps).
const cycleMod = (s: "off" | "armed" | "locked"): "off" | "armed" | "locked" =>
  s === "off" ? "armed" : s === "armed" ? "locked" : "off";

const TerminalView = ({
  sessionId,
  terminalId,
  disabled = false,
  isActive = true,
  containerExec,
  connectionEpoch = 0,
  serverId = 0,
  serverName = "",
  attachOnly = false,
  isProd = false,
  isLocal = false,
  localShell,
  localCwd,
  profile,
  onTerminalClosed,
}: {
  sessionId: string;
  terminalId: string;
  disabled?: boolean;
  attachOnly?: boolean;
  isActive?: boolean;
  containerExec?: { container: string; useSudo: boolean };
  connectionEpoch?: number;
  serverId?: number;
  serverName?: string;
  isProd?: boolean;
  isLocal?: boolean;
  localShell?: string;
  /** Unlocked profile; per-server settings such as "always record" are keyed by it. */
  profile?: string;
  localCwd?: string;
  onTerminalClosed?: (details: { cleanExit: boolean; transcript: string }) => void;
}) => {
  const onTerminalClosedRef = useRef(onTerminalClosed);
  useEffect(() => { onTerminalClosedRef.current = onTerminalClosed; }, [onTerminalClosed]);
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  // One binary Channel per TerminalView instance, reused across reconnects so
  // the backend's dedupe-by-id in register_output_channel doesn't pile up
  // sinks. Created lazily (not via useState) since it's write-only plumbing
  // that should never trigger a re-render.
  const outputChannelRef = useRef<Channel<ArrayBuffer> | null>(null);
  if (!outputChannelRef.current) {
    outputChannelRef.current = new Channel<ArrayBuffer>();
  }
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const openedRef = useRef(false);
  // Terminal Triggers & Alert Keywords: compiled once, refreshed whenever
  // the Settings UI saves an updated list — see src/terminal/triggers.ts.
  const compiledTriggersRef = useRef(compileTriggers(getTerminalTriggers()));
  useEffect(() => {
    const refresh = () => { compiledTriggersRef.current = compileTriggers(getTerminalTriggers()); };
    window.addEventListener(TRIGGERS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(TRIGGERS_CHANGED_EVENT, refresh);
  }, []);
  // The xterm `onData` callback is bound once and persists for the life of the
  // component. We read this ref inside the callback so the latest `disabled`
  // state is observed without having to tear down and rebuild xterm.
  const disabledRef = useRef(disabled);
  useEffect(() => {
    const wasDisabled = disabledRef.current;
    disabledRef.current = disabled;
    // Auto-focus xterm when terminal transitions from disabled (connecting) to enabled (connected)
    if (wasDisabled && !disabled && isActive) {
      const timer = setTimeout(() => {
        xtermRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [disabled, isActive]);
  // Mirror of `isActive` readable inside the ResizeObserver callback. The
  // observer is bound once at mount and runs for the lifetime of the
  // terminal, so a stale closure over the initial `isActive` would block
  // the gate from ever flipping. A ref is the cheapest way to expose live
  // state to that callback.
  const isActiveRef = useRef(isActive);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);
  // Mirror of containerExec for the reconnect effect — same reason as
  // isActiveRef. The reconnect effect is keyed on `connectionEpoch`
  // alone (the parent re-creates the containerExec object every render
  // so including it in deps would re-fire every paint).
  const containerExecRef = useRef(containerExec);
  useEffect(() => { containerExecRef.current = containerExec; }, [containerExec]);
  // Last connectionEpoch we acted on. Initial mount's PTY is opened by
  // the main effect, so we should NOT re-open on the first run of the
  // reconnect effect — only on subsequent value changes.
  const lastEpochRef = useRef(connectionEpoch);

  // Mobile-only sticky modifiers (Ctrl / Alt / Shift) for the on-screen
  // key bar. State doubles as render input (highlighting) and is mirrored
  // into a ref so the long-lived `term.onData` callback can read it without
  // re-binding every state change. Armed modifiers consume themselves on
  // the next typed char; locked modifiers persist until the user taps the
  // chip a third time.
  const isMobile = useIsNarrow();
  const [modifiers, setModifiers] = useState<ModifiersState>({ ctrl: "off", alt: "off", shift: "off" });
  const modifiersRef = useRef<ModifiersState>(modifiers);
  useEffect(() => { modifiersRef.current = modifiers; }, [modifiers]);

  // In-terminal search (Ctrl+F / Cmd+F). Query state is component-scoped so
  // reopening the chip pre-fills the last search — matches VS Code / Chrome
  // muscle memory. showSearch drives the floating chip's mount so xterm
  // isn't burdened with a hidden overlay when the user isn't searching.
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchResults, setSearchResults] = useState<{ resultIndex: number; resultCount: number } | null>(null);

  const [bellActive, setBellActive] = useState(false);
  const bellTimerRef = useRef<number | null>(null);

  // Command-history overlay (Ctrl+R / Cmd+R). Same document-level keydown
  // gate as search: only pop it when the user is focused inside this
  // terminal's DOM subtree, so multi-tab windows don't fire N overlays.
  const [showHistory, setShowHistory] = useState(false);
  const [showCopilot, setShowCopilot] = useState(false);
  // Mounted on first open and then only hidden, so closing the panel keeps the conversation.
  const [copilotMounted, setCopilotMounted] = useState(false);
  useEffect(() => { if (showCopilot) setCopilotMounted(true); }, [showCopilot]);
  const [copilotSeed, setCopilotSeed] = useState<AiSeed | undefined>(undefined);
  const copilotEnabled = useFeatureFlag('aiCopilot');
  const recordingEnabled = useFeatureFlag('sessionRecording');
  const [recording, setRecording] = useState(() => isRecording(terminalId));
  // "Always record this server": the running recording was started automatically and
  // is saved without a dialog when the tab closes.
  const canAlwaysRecord = recordingEnabled && !isLocal && !attachOnly && serverId > 0;
  const [alwaysRecord, setAlwaysRecord] = useState(() => isAlwaysRecorded(profile, serverId));
  const serverNameRef = useRef(serverName);
  serverNameRef.current = serverName;
  useEffect(() => {
    setRecording(isRecording(terminalId));
    const off = onRecordingChange(() => setRecording(isRecording(terminalId)));
    // A manual recording lives only as long as its terminal; closing the tab discards it.
    return () => {
      off();
      if (isAutoRecording(terminalId)) saveAutoRecording(terminalId).catch(console.error);
      else stopRecording(terminalId);
    };
  }, [terminalId]);
  const startAutoRecording = useCallback(() => {
    const term = xtermRef.current;
    if (!term || isRecording(terminalId)) return;
    startRecording(terminalId, { cols: term.cols, rows: term.rows, title: serverNameRef.current || undefined, captureInput: false });
    markAutoRecording(terminalId, serverNameRef.current);
  }, [terminalId]);
  const toggleAlwaysRecord = () => {
    const on = !alwaysRecord;
    setAlwaysRecorded(profile, serverId, on);
    setAlwaysRecord(on);
    if (on) {
      startAutoRecording();
      invoke<string>('recordings_dir')
        .then((dir) => notify(`Recording this server every time; saved to ${dir} when the tab closes`))
        .catch(() => notify('Recording this server every time'));
    } else {
      notify('This server will no longer be recorded automatically');
    }
  };

  const isProdServer = isProd || Boolean(serverName && (
    serverName.toLowerCase().includes("prod") ||
    serverName.toLowerCase().includes("production")
  ));
  const [safetyWarningCmd, setSafetyWarningCmd] = useState<string | null>(null);
  const [scriptPasteModal, setScriptPasteModal] = useState<{ text: string; lines: string[] } | null>(null);
  const [pasteSafetyBypass, setPasteSafetyBypass] = useState(false);

  // Broadcast context. `stateRef` gives us live access from inside the
  // xterm.onData closure without re-binding on every state change.
  // Callback identities on `broadcast` are stable (useCallback) so the
  // register effect below can depend on those directly without churn.
  const broadcast = useBroadcast();
  const broadcastRef = broadcast.stateRef;
  const registerActiveTerminal = broadcast.registerActiveTerminal;
  const unregisterActiveTerminal = broadcast.unregisterActiveTerminal;

  // Register this terminal as the "active" one for its session whenever
  // isActive flips true. Broadcast fan-out reads from sessionTerminalMap
  // to know which of a session's tabs is currently visible / receiving
  // input; a stale mapping to a background terminal would silently swallow
  // the mirrored keystrokes. Unregister only if we still hold the slot —
  // avoids racing with the newly-active terminal during a tab swap.
  useEffect(() => {
    if (!isActive) return;
    registerActiveTerminal(sessionId, terminalId);
    return () => {
      unregisterActiveTerminal(sessionId, terminalId);
    };
  }, [isActive, sessionId, terminalId, registerActiveTerminal, unregisterActiveTerminal]);

  // Buffer keystrokes locally so we can log "the command line the user
  // typed" on each Enter press. Best-effort: pastes, arrow-key edits,
  // multi-line entries will produce noisy or wrong rows — we accept that
  // rather than reimplement a shell parser in the browser. `commandBufRef`
  // is mutated inside the long-lived onData closure so a ref (not state)
  // is the right container.
  const commandBufRef = useRef<string>("");
  // Small tail of recent remote OUTPUT, kept only to detect no-echo password
  // prompts (see looksLikePasswordPrompt) — never persisted or displayed.
  const recentOutputRef = useRef<string>("");
  // One streaming decoder per terminal, so a UTF-8 character split across two chunks still decodes.
  const outputDecoderRef = useRef(new TextDecoder());
  // Track terminal's current working directory (via OSC 7 or shell prompt parsing)
  const currentCwdRef = useRef<string>("");
  useEffect(() => () => forgetTerminalCwd(terminalId), [terminalId]);

  const toggleModifier = (m: ModKey) => {
    setModifiers(prev => ({ ...prev, [m]: cycleMod(prev[m]) }));
  };
  // Called after a transformed char is sent so armed modifiers reset back
  // to "off" while locked ones survive (matches Termux's behavior). Skipped
  // when nothing was actually armed — avoids a useless setState ping.
  const consumeArmedModifiers = () => {
    setModifiers(prev => {
      if (prev.ctrl !== "armed" && prev.alt !== "armed" && prev.shift !== "armed") return prev;
      return {
        ctrl:  prev.ctrl  === "armed" ? "off" : prev.ctrl,
        alt:   prev.alt   === "armed" ? "off" : prev.alt,
        shift: prev.shift === "armed" ? "off" : prev.shift,
      };
    });
  };

  // Esc / Tab from the bar bypass the onData modifier pipeline (those keys
  // produce escape sequences directly, not printable chars), but Shift+Tab
  // still has a meaningful encoding so we honor it here.
  const sendSpecialKey = (key: "esc" | "tab") => {
    if (disabledRef.current) return;
    let bytes: number[];
    let consumes = false;
    if (key === "esc") {
      bytes = [0x1b];
    } else {
      if (modifiersRef.current.shift !== "off") {
        // ESC [ Z = CSI Z = back-tab (the standard Shift+Tab sequence).
        bytes = [0x1b, 0x5b, 0x5a];
        consumes = true;
      } else {
        bytes = [0x09];
      }
    }
    invoke('write_terminal_data', { terminalId, data: bytes }).catch(console.error);
    if (consumes) consumeArmedModifiers();
  };

  // Reconnect handler: when the parent bumps connectionEpoch we re-open
  // the PTY against the new SSH handle and write a divider line into the
  // existing xterm so the user can scroll up to see everything they did
  // before the disconnect. The backend's `terminal_txs` HashMap.insert
  // overwrites the dead entry transparently, so write_terminal_data
  // routes to the new task without changing the terminal_id.
  useEffect(() => {
    if (connectionEpoch === lastEpochRef.current) return;
    lastEpochRef.current = connectionEpoch;
    const term = xtermRef.current;
    if (!term) return;
    // Visible separator. \x1b[33m = yellow, \x1b[0m = reset.
    term.write('\r\n\x1b[33m── reconnected ──\x1b[0m\r\n');
    // Attach-only viewers piggyback on someone else's PTY, so they
    // must not re-open the PTY on reconnect either — the owner
    // already did it and this instance just needs to keep reading
    // events off the same terminal_id.
    if (attachOnly) return;
    if (isLocal) {
      invoke('open_local_terminal', {
        terminalId,
        cols: term.cols || 80,
        rows: term.rows || 24,
        cwd: localCwd || null,
        shell: localShell || null,
        channel: outputChannelRef.current,
        shellIntegrationOn: isFeatureEnabled('terminalCommandBlocks'),
        gitPromptOn: isFeatureEnabled('terminalGitPrompt'),
      }).catch(e => {
        term.writeln(`\x1b[31mRestart local terminal failed: ${e}\x1b[0m`);
      });
    } else {
      const ce = containerExecRef.current;
      if (ce) {
        invoke('open_container_terminal', {
          sessionId,
          terminalId,
          container: ce.container,
          cols: term.cols || 80,
          rows: term.rows || 24,
          useSudo: ce.useSudo,
          channel: outputChannelRef.current,
        }).catch(e => {
          term.writeln(`\x1b[31mReconnect into container failed: ${e}\x1b[0m`);
        });
      } else {
        invoke('open_terminal', {
          sessionId,
          terminalId,
          cols: term.cols || 80,
          rows: term.rows || 24,
          channel: outputChannelRef.current,
        }).catch(e => {
          term.writeln(`\x1b[31mReconnect failed: ${e}\x1b[0m`);
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionEpoch]);

  // Repaint when this terminal becomes the active one. The parent uses
  // opacity (within a session) or display:none (across sessions/tabs) to
  // swap visible terminals — neither triggers xterm's internal redraw, so
  // the canvas can end up showing a stale row of glyphs from before the
  // switch. Calling `fit()` recomputes cols/rows and `refresh()` forces
  // every visible row to repaint. rAF defers until the layout has settled
  // — without it `fit()` would measure 0×0 in the display:none case.
  useEffect(() => {
    if (!isActive) return;
    const id = requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit();
        const t = xtermRef.current;
        if (t) {
          t.refresh(0, Math.max(0, t.rows - 1));
          if (!disabledRef.current) {
            t.focus();
          }
        }
      } catch { /* terminal not ready yet — next tick will catch it */ }
    });
    return () => cancelAnimationFrame(id);
  }, [isActive]);

  // Ctrl+F / Cmd+F opens the search chip — but only when the user is
  // focused inside this terminal's DOM subtree. Document-level listener is
  // needed because xterm's textarea steals keyboard focus, so the wrapper
  // never sees the keydown via bubbling within React's synthetic tree.
  // Gate on `document.activeElement` so multiple terminals in tabs / split
  // panes don't all pop their search chip on a single Ctrl+F.
  //
  // The same gate is reused for Ctrl+R / Cmd+R which opens the command
  // history overlay. Browsers normally reload the page on Ctrl+R; inside
  // the Tauri webview a document-level preventDefault stops that dead.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const wrapper = terminalRef.current;
      if (!wrapper) return;
      const active = document.activeElement;
      if (!(active instanceof Node) || !wrapper.contains(active)) return;

      if (e.altKey && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault();
        if (lastCommandRef.current) {
          copyCommandOutput(lastCommandRef.current);
        }
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        setShowSearch(true);
        // If already open, refocus the input so a second Ctrl+F selects the
        // existing query for a quick overwrite.
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        setShowHistory(true);
      } else if ((e.key === 'i' || e.key === 'I') && isFeatureEnabled('aiCopilot')) {
        e.preventDefault();
        setShowCopilot(true);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const getSearchOptions = (custom?: Partial<ISearchOptions>): ISearchOptions => ({
    ...SEARCH_OPTIONS,
    caseSensitive: searchCaseSensitive,
    wholeWord: searchWholeWord,
    regex: searchRegex,
    ...custom,
  });

  // Close + clear search decorations. Refocuses xterm so the user's next
  // keystroke goes to the shell, not to nowhere.
  const closeSearch = () => {
    const addon = searchAddonRef.current;
    addon?.clearDecorations?.();
    setShowSearch(false);
    setSearchResults(null);
    // Return focus to xterm so keystrokes resume typing at the prompt.
    xtermRef.current?.focus();
  };

  const runFind = (direction: 'next' | 'prev', overrideQuery?: string, overrideOptions?: Partial<ISearchOptions>) => {
    const addon = searchAddonRef.current;
    const targetQuery = overrideQuery !== undefined ? overrideQuery : query;
    if (!addon || !targetQuery) {
      setSearchResults(null);
      return;
    }
    const opts = getSearchOptions(overrideOptions);
    if (direction === 'next') addon.findNext(targetQuery, opts);
    else addon.findPrevious(targetQuery, opts);
  };

  useEffect(() => {
    if (!showSearch) return;
    const addon = searchAddonRef.current;
    if (!addon) return;
    if (!query) {
      addon.clearDecorations?.();
      setSearchResults(null);
      return;
    }
    addon.findNext(query, getSearchOptions({ incremental: true }));
  }, [query, searchCaseSensitive, searchWholeWord, searchRegex, showSearch]);

  // Tiny inline toast for clipboard feedback (copy / paste / errors). Pattern
  // matches the per-component notify() used in SftpWorkspace / FilePanel —
  // keeps the component self-contained without a global toast provider.
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "err" } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const notify = (msg: string, tone: "ok" | "err" = "ok") => {
    setToast({ msg, tone });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 1400);
  };

  // Offer shown after `ssh`/`sftp` is typed in a local shell: open the matching saved
  // server, or save the host / quick-connect it.
  interface SshOffer {
    target: SshTarget;
    resolved: { host: string; port: number; username: string; private_key: string | null; user_explicit: boolean };
    matches: { id: number; name: string }[];
  }
  const [sshOffer, setSshOffer] = useState<SshOffer | null>(null);
  const sshOfferTimerRef = useRef<number | null>(null);
  const sshDismissedRef = useRef<Set<string>>(new Set());
  // True from the moment a typed ssh/sftp line is detected until the client reports an end
  // (closed / refused / unreachable / auth failure). While set, typed lines go to the remote
  // shell, so ssh typed there must not trigger an offer. Best effort: it is cleared from output text.
  const sshForegroundRef = useRef(false);
  // Tab / escape sequences seen on the current line: the keystroke buffer no longer matches what the shell shows.
  const lineEditedRef = useRef(false);
  const clearSshOfferTimer = () => {
    if (sshOfferTimerRef.current) window.clearTimeout(sshOfferTimerRef.current);
  };
  const dismissSshOffer = () => {
    clearSshOfferTimer();
    setSshOffer((cur) => {
      if (cur) sshDismissedRef.current.add(sshTargetKey(cur.target));
      return null;
    });
  };
  // Stop the shell's own ssh (still running when the user accepts) so only the native session remains.
  const interruptShellSsh = () => {
    invoke('write_terminal_data', { terminalId, data: [0x03] }).catch(() => {});
    // Ctrl+C ends ssh without printing anything, so the output-based reset would never fire.
    sshForegroundRef.current = false;
  };
  // `how`: 'saved' opens a matching saved server, 'save' saves + opens, 'quick' opens without saving.
  const openSshOffer = (offer: SshOffer, how: 'saved' | 'save' | 'quick', serverId?: number) => {
    clearSshOfferTimer();
    setSshOffer(null);
    sshDismissedRef.current.add(sshTargetKey(offer.target));
    interruptShellSsh();
    window.dispatchEvent(new CustomEvent('subterm-open-ssh-target', {
      detail: { ...offer.resolved, openSftp: offer.target.kind === 'sftp', how, serverId },
    }));
  };
  // Resolve + match a typed target, then either auto-open (mode "auto" with exactly one
  // saved match) or show the offer bar.
  const handleSshTyped = async (target: SshTarget) => {
    try {
      const resolved = await invoke<SshOffer['resolved']>('resolve_ssh_target', {
        host: target.host, username: target.username ?? null, port: target.port ?? null, identityFile: target.identityFile ?? null,
      });
      const matches = await invoke<SshOffer['matches']>('find_saved_servers', {
        host: resolved.host, alias: target.host, port: resolved.port,
        username: resolved.user_explicit ? resolved.username : null,
      });
      const offer: SshOffer = { target, resolved, matches };
      if ((localStorage.getItem('subterm-ssh-detect-mode') || 'prompt') === 'auto' && matches.length === 1) {
        openSshOffer(offer, 'saved', matches[0].id);
        return;
      }
      setSshOffer(offer);
      clearSshOfferTimer();
      sshOfferTimerRef.current = window.setTimeout(() => dismissSshOffer(), 20000);
    } catch { /* ProxyJump host or lookup failure: stay out of the way */ }
  };

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // The logical command line as rendered (wrapped rows joined), cut at the cursor.
  const readScreenCommand = (): string => {
    const term = xtermRef.current;
    if (!term) return '';
    const buf = term.buffer.active;
    let y = buf.baseY + buf.cursorY;
    const last = buf.getLine(y);
    if (!last) return '';
    const parts = [last.translateToString(false, 0, buf.cursorX)];
    let row = last;
    while (row.isWrapped && y > 0) {
      y -= 1;
      const prev = buf.getLine(y);
      if (!prev) break;
      parts.unshift(prev.translateToString(false));
      row = prev;
    }
    return parts.join('');
  };
  const openMenuAt = (x: number, y: number) => {
    const term = xtermRef.current;
    if (!term) return;
    setContextMenu({ x, y, hasSelection: !!term.getSelection(), hasSavedPassword: !isLocal });
  };

  const handleStartRecording = (withInput: boolean) => {
    const term = xtermRef.current;
    if (!term) return;
    startRecording(terminalId, { cols: term.cols, rows: term.rows, title: serverName || undefined, captureInput: withInput });
    unmarkAutoRecording(terminalId);
    notify(withInput ? 'Recording output and keystrokes' : 'Recording output');
  };

  const handleStopRecording = (format: 'cast' | 'text') => {
    const rec = getRecorder(terminalId);
    if (!rec) return;
    const body = format === 'cast' ? rec.toCast() : castToPlainText(rec.events);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const extension = format === 'cast' ? 'cast' : 'log';
    saveTextFile(body, `session-${serverName || 'terminal'}-${stamp}.${extension}`, extension)
      .then((path) => {
        if (path === null) {
          notify('Save cancelled - still recording', 'err');
          return;
        }
        stopRecording(terminalId);
        unmarkAutoRecording(terminalId);
        notify(rec.truncated ? 'Recording saved (size limit reached, end cut off)' : `Recording saved (${rec.durationSeconds.toFixed(0)}s)`);
      })
      .catch((e) => notify(`Could not save recording: ${e}`, 'err'));
  };
  const handlePasteRef = useRef<(text: string) => void>(() => {});

  const handleContextCopy = async () => {
    const term = xtermRef.current;
    if (!term) return;
    const sel = term.getSelection();
    if (sel) {
      try {
        await navigator.clipboard.writeText(sel);
        notify('Copied');
      } catch (err) {
        console.error('Failed to copy', err);
      }
    }
  };

  const handleContextPaste = async () => {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      notify('Clipboard read denied', 'err');
      return;
    }
    if (!text) {
      const image = await readClipboardImage();
      if (image) await pasteImageRef.current(image).catch((e) => notify(`Image paste failed: ${e}`, 'err'));
      return;
    }
    if (text) {
      handlePasteRef.current(text);
    }
  };

  const handleContextSelectAll = () => {
    xtermRef.current?.selectAll();
  };

  // Sudo prompt seen on a session with a saved password: offer to fill it.
  const [sudoOffer, setSudoOffer] = useState(false);
  const sudoOfferRef = useRef(false);
  const showSudoOffer = (on: boolean) => {
    if (sudoOfferRef.current === on) return;
    sudoOfferRef.current = on;
    setSudoOffer(on);
  };
  const fillSudoPassword = () => {
    showSudoOffer(false);
    void handlePasteSavedPassword();
    xtermRef.current?.focus();
  };

  // Output received while the echo probe is running; null when no probe is active.
  const probeOutputRef = useRef<string | null>(null);
  // Files dropped onto this terminal are typed as paths, so a tool in the shell (Claude
  // Code, say) can read them. On an SSH session the local path means nothing to the
  // server, so each file is uploaded to /tmp there first and that path is typed.
  // Tauri delivers OS drops as one global event; only the terminal under the cursor acts.
  const dropRef = useRef<{ disabled: boolean; isLocal: boolean; localShell?: string }>({ disabled, isLocal, localShell });
  dropRef.current = { disabled, isLocal, localShell };
  // Type local file paths into this terminal (uploading them first on SSH sessions).
  const insertFiles = async (paths: string[]) => {
    const write = (text: string) =>
      invoke('write_terminal_data', { terminalId, data: Array.from(new TextEncoder().encode(text)) }).catch(console.error);
    if (dropRef.current.isLocal) {
      const kind = localShellKind(dropRef.current.localShell, navigator.userAgent.includes('Windows'));
      void write(quotePaths(paths, kind));
      xtermRef.current?.focus();
      return;
    }
    const uploaded: string[] = [];
    for (const p of paths) {
      const remote = remoteDropPath(p);
      notify(`Uploading ${p.split(/[\\/]/).pop()}...`);
      try {
        await invoke('sftp_upload_file', { sessionId, localPath: p, remotePath: remote, overwrite: false });
        uploaded.push(remote);
      } catch (e) {
        notify(`Upload failed: ${e}`, 'err');
      }
    }
    if (uploaded.length) {
      void write(uploaded.join(' ') + ' ');
      notify(uploaded.length === 1 ? `Uploaded to ${uploaded[0]}` : `Uploaded ${uploaded.length} files to /tmp`);
      xtermRef.current?.focus();
    }
  };
  const insertFilesRef = useRef(insertFiles);
  insertFilesRef.current = insertFiles;
  // A pasted image (a screenshot, say) is saved as a temp PNG and inserted like a dropped file.
  const pasteImageRef = useRef(async (blob: Blob) => {
    const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type.replace(/^image\//, '') || 'png';
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const path = await invoke<string>('save_temp_file', bytes, { headers: { 'x-filename': `clipboard-${Date.now()}.${ext}` } });
    await insertFilesRef.current([path]);
  });
  /** Image on the clipboard (via the async Clipboard API); null if there is none or no access. */
  const readClipboardImage = async (): Promise<Blob | null> => {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) return await item.getType(type);
      }
    } catch { /* no permission or nothing readable */ }
    return null;
  };
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let alive = true;
    listen<{ paths: string[]; position: { x: number; y: number } }>('tauri://drag-drop', async (event) => {
      const { paths, position } = event.payload || ({} as { paths?: string[]; position: { x: number; y: number } });
      const root = terminalRef.current?.parentElement;
      if (!paths?.length || !root || dropRef.current.disabled) return;
      const pt = toCssPoint(position);
      const hit = document.elementFromPoint(pt.x, pt.y);
      if (!hit || !root.contains(hit)) return;
      await insertFilesRef.current(paths);
    }).then((fn) => { if (alive) unlisten = fn; else fn(); });
    return () => { alive = false; unlisten?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, terminalId]);

  const handlePasteSavedPassword = async () => {
    try {
      // Type "x" + Backspace and listen: a hidden prompt shows nothing back, so the
      // password is only sent where it cannot end up on screen or in a shell line.
      probeOutputRef.current = '';
      await invoke('write_terminal_data', { terminalId, data: [0x78, 0x7f] });
      // shortcut: fixed wait, an echo slower than this on a laggy link is missed; upgrade to a measured round trip if that shows up.
      await new Promise((r) => setTimeout(r, 600));
      const echoed = probeWasEchoed(probeOutputRef.current ?? '');
      probeOutputRef.current = null;
      if (echoed) {
        notify('Not filled: this prompt shows what you type', 'err');
        return;
      }
      const injected = await invoke<boolean>('write_saved_password', { sessionId, terminalId });
      if (!injected) notify('No saved password for this session', 'err');
    } catch {
      notify('Failed to paste saved password', 'err');
    }
  };

  const handleContextFind = () => {
    setShowSearch(true);
  };

  const handleContextClear = () => {
    xtermRef.current?.clear();
    notify('Scrollback cleared');
  };

  const handleContextReset = () => {
    xtermRef.current?.reset();
    notify('Terminal reset');
  };

  const handleContextExport = () => {
    const term = xtermRef.current;
    if (!term) return;
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    const text = lines.join('\n');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    saveTextFile(text, `terminal-${serverName || 'session'}-${stamp}.log`, 'log')
      .then((path) => { if (path !== null) notify('Buffer exported to .log'); })
      .catch((e) => notify(`Could not export buffer: ${e}`, 'err'));
  };

  // "Find" and "Export text" from the tab menu, which lives in SessionView.
  const tabActionRef = useRef({ find: handleContextFind, export: handleContextExport });
  tabActionRef.current = { find: handleContextFind, export: handleContextExport };
  useEffect(() => {
    const onAction = (e: Event) => {
      const a = (e as CustomEvent<string>).detail;
      if (a === 'find' || a === 'export') tabActionRef.current[a]();
    };
    window.addEventListener(`subterm-terminal-action-${terminalId}`, onAction);
    return () => window.removeEventListener(`subterm-terminal-action-${terminalId}`, onAction);
  }, [terminalId]);

  // Command block separation and output capture (OSC 133 + buffer parsing)
  const lastCommandRef = useRef<{
    command: string;
    startedAt?: number;
    exitCode?: number;
    startLine: number;
    outputStartLine: number;
    endLine?: number;
    running: boolean;
  } | null>(null);

  const [lastCommand, setLastCommand] = useState<{
    command: string;
    startedAt?: number;
    exitCode?: number;
    startLine: number;
    outputStartLine: number;
    endLine?: number;
    running: boolean;
  } | null>(null);

  const commandSettleTimerRef = useRef<number | null>(null);

  const bufferLines = (from: number, to: number) => {
    const buf = xtermRef.current?.buffer.active;
    if (!buf) return '';
    const lines: string[] = [];
    for (let i = Math.max(0, from); i <= Math.min(to, buf.length - 1); i++) {
      const l = buf.getLine(i);
      if (l) lines.push(l.translateToString(true));
    }
    return lines.join('\n').replace(/\s+$/, '');
  };

  const readTerminal = (count: number) => {
    const buf = xtermRef.current?.buffer.active;
    if (!buf) return '';
    const end = buf.baseY + buf.cursorY;
    return bufferLines(end - count + 1, end);
  };

  const explainFailure = (block: { command: string; exitCode?: number; outputStartLine: number; endLine?: number }) => {
    const buf = xtermRef.current?.buffer.active;
    const end = block.endLine ?? (buf ? buf.baseY + buf.cursorY : block.outputStartLine);
    // The tail is where the error usually is.
    const output = bufferLines(Math.max(block.outputStartLine, end - 60), end);
    setCopilotSeed({
      text: `This command failed with exit code ${block.exitCode}:\n${block.command}\n\nOutput:\n<terminal>\n${output}\n</terminal>\n\nExplain why, and how to fix it.`,
      nonce: Date.now(),
    });
    setShowCopilot(true);
  };

  const commandDismissTimerRef = useRef<number | null>(null);

  const copyCommandOutput = (block: { outputStartLine: number; endLine?: number }) => {
    const term = xtermRef.current;
    if (!term) return;
    const lines: string[] = [];
    const fromLine = block.outputStartLine;
    const toLine = block.endLine ?? (term.buffer.active.cursorY + term.buffer.active.baseY);
    for (let i = fromLine; i <= toLine; i++) {
      const l = term.buffer.active.getLine(i);
      if (l) lines.push(l.translateToString(true));
    }
    const text = lines.join("\n").trim();
    if (text) {
      navigator.clipboard.writeText(text);
      notify("Command output copied!");
    } else {
      notify("No output to copy", "err");
    }
  };

  useEffect(() => {
    if (!terminalRef.current) return;

    const themeId = localStorage.getItem('subterm-terminal-theme') || 'subterm-dark';
    const cursorBlink = localStorage.getItem('subterm-terminal-cursor-blink') !== 'false';
    const cursorStyle = (localStorage.getItem('subterm-terminal-cursor-style') || 'block') as 'block' | 'underline' | 'bar';

    const fontFamily = localStorage.getItem('subterm-terminal-font-family') || 'JetBrains Mono, Menlo, Monaco, Consolas, "Courier New", monospace';
    const lineHeight = parseFloat(localStorage.getItem('subterm-terminal-line-height') || '1.15');
    const scrollback = parseInt(localStorage.getItem('subterm-terminal-scrollback') || '5000', 10);

    const term = new Terminal({
      cursorBlink,
      cursorStyle,
      fontSize: parseInt(localStorage.getItem('subterm-terminal-font-size') || localStorage.getItem('submarine-terminal-font-size') || '14'),
      fontFamily,
      lineHeight,
      scrollback,
      theme: withBackgroundOpacity(withCursorColor(getTerminalTheme(themeId))),
      allowTransparency: readOpacity() < 100,
      wordSeparator: localStorage.getItem('subterm-word-separators') ?? undefined,
      scrollOnUserInput: localStorage.getItem('subterm-scroll-on-input') !== 'false',
      allowProposedApi: true
    });
    if (isLocal && navigator.userAgent.includes('Windows')) {
      term.options.windowsPty = windowsPtyFor();
      (navigator as Navigator & { userAgentData?: { getHighEntropyValues(h: string[]): Promise<{ platformVersion?: string }> } })
        .userAgentData?.getHighEntropyValues(['platformVersion'])
        .then((v) => { term.options.windowsPty = windowsPtyFor(v.platformVersion); })
        .catch(() => {});
    }
    if (terminalRef.current) terminalRef.current.style.padding = `${Math.max(0, parseInt(localStorage.getItem('subterm-terminal-padding') || '0', 10) || 0)}px`;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    const searchAddon = new SearchAddon();
    searchAddonRef.current = searchAddon;
    term.loadAddon(searchAddon);
    searchAddon.onDidChangeResults((e) => {
      setSearchResults(e);
    });

    const onBellDisposable = term.onBell(() => {
      const mode = localStorage.getItem('subterm-terminal-bell') || 'visual';
      if (mode === 'audio' || mode === 'both') {
        playTerminalBellChime();
      }
      if (mode === 'visual' || mode === 'both') {
        setBellActive(true);
        if (bellTimerRef.current) window.clearTimeout(bellTimerRef.current);
        bellTimerRef.current = window.setTimeout(() => setBellActive(false), 250);
      }
    });

    // OSC 133 Shell Integration handler (FinalTerm / iTerm / VS Code spec)
    try {
      term.parser.registerOscHandler(133, (data: string) => {
        const parts = data.split(';');
        // Only SubTerm's own local shell hook adds this tag, so a remote prompt seen through ssh can't trigger it.
        if (isLocal && parts[0] === 'A' && parts.includes('subterm=local')) sshForegroundRef.current = false;
        if (!isFeatureEnabled('terminalCommandBlocks')) return true; // swallow the marker, track nothing
        const action = parts[0]?.trim();
        const currentLine = term.buffer.active.cursorY + term.buffer.active.baseY;

        if (action === 'A') {
          // Prompt start: mark previous command output finished
          if (lastCommandRef.current && lastCommandRef.current.running) {
            const updated = {
              ...lastCommandRef.current,
              endLine: Math.max(lastCommandRef.current.outputStartLine, currentLine - 1),
              running: false,
            };
            lastCommandRef.current = updated;
            setLastCommand(updated);
          }
        } else if (action === 'C') {
          // Command output start
          if (lastCommandRef.current) {
            const updated = {
              ...lastCommandRef.current,
              outputStartLine: currentLine,
              running: true,
            };
            lastCommandRef.current = updated;
            setLastCommand(updated);
          }
        } else if (action === 'D') {
          // Command finished [; exit_code]
          const code = parts[1] !== undefined ? parseInt(parts[1], 10) : 0;
          if (lastCommandRef.current) {
            const updated = {
              ...lastCommandRef.current,
              exitCode: isNaN(code) ? 0 : code,
              endLine: Math.max(lastCommandRef.current.outputStartLine, currentLine),
              running: false,
            };
            lastCommandRef.current = updated;
            setLastCommand(updated);

            // Only this path knows the command really ended (the shell said so); the output-settling
            // fallback below cannot tell a finished command from a quiet one, so it never notifies.
            const longSec = Math.max(0, parseInt(localStorage.getItem('subterm-notify-long-sec') || '0', 10) || 0);
            if (updated.startedAt && shouldNotifyLongCommand(Date.now() - updated.startedAt, longSec)) {
              void notifyDesktop(
                updated.exitCode ? `Command failed (exit ${updated.exitCode})` : 'Command finished',
                `${serverName || 'Terminal'}: ${updated.command.slice(0, 120)}`,
              );
            }

            if (localStorage.getItem('subterm-auto-copy-output') === 'true') {
              copyCommandOutput(updated);
            }

            const rawSec = localStorage.getItem('subterm-command-dismiss-sec');
            const dismissSec = rawSec !== null ? Math.max(0, parseInt(rawSec, 10) || 0) : 4;
            if (dismissSec > 0) {
              if (commandDismissTimerRef.current) window.clearTimeout(commandDismissTimerRef.current);
              commandDismissTimerRef.current = window.setTimeout(() => {
                setLastCommand(null);
              }, dismissSec * 1000);
            }
          }
        }
        return true;
      });
    } catch (e) {
      console.warn("OSC 133 handler registration failed:", e);
    }

    // OSC 7 (Current Working Directory)
    try {
      term.parser.registerOscHandler(7, (data: string) => {
        const p = parseOsc7(data);
        if (p) {
          currentCwdRef.current = p;
          setTerminalCwd(terminalId, p);
        }
        return true;
      });
    } catch (e) {
      console.warn("OSC 7 registration failed:", e);
    }

    // Custom Key Event Handler: intercept configured shortcuts BEFORE xterm generates or sends chars to PTY
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      // 1. Quick open file
      if (matchesKeyCombo(e, getActiveShortcut("quickOpenFile"))) {
        if (e.type === "keydown") {
          window.dispatchEvent(
            new CustomEvent(`submarine-quick-open-file-session-${sessionId}`)
          );
        }
        return false; // Prevent xterm from sending character (e.g. ē) to shell
      }

      // 2. Prevent xterm from sending control sequences for other configured SubTerm actions
      if (
        matchesKeyCombo(e, getActiveShortcut("commandPalette")) ||
        matchesKeyCombo(e, getActiveShortcut("newTerminal")) ||
        matchesKeyCombo(e, getActiveShortcut("splitHorizontal")) ||
        matchesKeyCombo(e, getActiveShortcut("splitVertical")) ||
        matchesKeyCombo(e, getActiveShortcut("focusNextPane")) ||
        matchesKeyCombo(e, getActiveShortcut("focusPrevPane")) ||
        matchesKeyCombo(e, getActiveShortcut("toggleSftp")) ||
        matchesKeyCombo(e, getActiveShortcut("toggleDocker")) ||
        matchesKeyCombo(e, getActiveShortcut("toggleProcesses")) ||
        matchesKeyCombo(e, getActiveShortcut("toggleServices")) ||
        matchesKeyCombo(e, getActiveShortcut("toggleInfo")) ||
        matchesKeyCombo(e, getActiveShortcut("closeSession"))
      ) {
        return false;
      }

      return true;
    });

    // Clickable links for URLs and file paths in output
    try {
      term.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
          const line = term.buffer.active.getLine(bufferLineNumber - 1);
          if (!line) {
            callback(undefined);
            return;
          }
          const lineText = line.translateToString(true);
          const links: ILink[] = [];

          // 1. URLs
          const urlRegex = /(https?:\/\/[^\s"'`<>]+)/g;
          let match: RegExpExecArray | null;
          while ((match = urlRegex.exec(lineText)) !== null) {
            const url = match[1];
            const startX = match.index + 1;
            const endX = startX + url.length - 1;
            links.push({
              range: {
                start: { x: startX, y: bufferLineNumber },
                end: { x: endX, y: bufferLineNumber },
              },
              text: url,
              activate: (_ev, text) => {
                invoke('open_url', { url: text }).catch(() => {
                  window.open(text, '_blank');
                });
              },
            });
          }

          // File-path links are optional (Settings -> Feature Toggles). When off,
          // none of the path regexes below run on terminal output.
          if (isFeatureEnabled("terminalFileLinks")) {
            // 2. Absolute or home-relative file paths (/path/to/file or ~/file)
            const pathRegex = /(?:^|[\s"'`])((?:\/[\w.-]+)+\/?|~\/[\w.-]+(?:\/[\w.-]+)*)/g;
            while ((match = pathRegex.exec(lineText)) !== null) {
              const fullPath = match[1];
              if (fullPath.length >= 3 && !fullPath.startsWith('//') && !fullPath.includes('://')) {
                const startX = match.index + (match[0].length - fullPath.length) + 1;
                const endX = startX + fullPath.length - 1;
                links.push({
                  range: {
                    start: { x: startX, y: bufferLineNumber },
                    end: { x: endX, y: bufferLineNumber },
                  },
                  text: fullPath,
                  activate: (_ev, pathText) => {
                    window.dispatchEvent(
                      new CustomEvent(`submarine-open-editor-${sessionId}`, {
                        detail: { path: pathText, cwd: currentCwdRef.current },
                      })
                    );
                  },
                });
              }
            }

            // 2b. Relative paths (./x, ../x, dir/file.ext, dir/sub/) with an optional
            // :line[:col] suffix. Resolved against the shell's cwd (or searched
            // for) by the editor-open handler, so no cwd is needed here.
            const relRegex = /(?:^|[\s"'`(])((?:\.{1,2}\/|[\w@.-]+\/)(?:[\w@.-]+\/)*[\w@.-]*(?::\d+(?::\d+)?)?)/g;
            while ((match = relRegex.exec(lineText)) !== null) {
              const relPath = match[1];
              if (relPath.length < 3 || relPath.includes('://')) continue;
              const startX = match.index + (match[0].length - relPath.length) + 1;
              const endX = startX + relPath.length - 1;
              const overlapsAbs = links.some(
                (l) =>
                  l.range.start.y === bufferLineNumber &&
                  !(endX < l.range.start.x || startX > l.range.end.x)
              );
              if (overlapsAbs) continue;
              links.push({
                range: {
                  start: { x: startX, y: bufferLineNumber },
                  end: { x: endX, y: bufferLineNumber },
                },
                text: relPath,
                activate: (_ev, pathText) => {
                  window.dispatchEvent(
                    new CustomEvent(`submarine-open-editor-${sessionId}`, {
                      detail: { path: pathText, cwd: currentCwdRef.current },
                    })
                  );
                },
              });
            }

            // 3. Standalone filenames with recognizable text/code/config extensions (e.g. services.yaml, config.json, Dockerfile)
            // Extensions / names are user-configurable (Settings -> Clickable file types).
            const fileRegex = getFileLinkRegex();
            while (fileRegex && (match = fileRegex.exec(lineText)) !== null) {
              const fileName = match[1];
              const startX = match.index + (match[0].length - fileName.length) + 1;
              const endX = startX + fileName.length - 1;

              const overlaps = links.some(
                (l) =>
                  l.range.start.y === bufferLineNumber &&
                  !(endX < l.range.start.x || startX > l.range.end.x)
              );

              if (!overlaps) {
                links.push({
                  range: {
                    start: { x: startX, y: bufferLineNumber },
                    end: { x: endX, y: bufferLineNumber },
                  },
                  text: fileName,
                  activate: (_ev, pathText) => {
                    window.dispatchEvent(
                      new CustomEvent(`submarine-open-editor-${sessionId}`, {
                        detail: { path: pathText, cwd: currentCwdRef.current },
                      })
                    );
                  },
                });
              }
            }

          }

          // Links open on Ctrl/Cmd+Click by default so a plain click (focus /
          // start of a selection) never opens anything by accident. Touch
          // devices have no modifier key, so they always open on tap.
          const hintEl = terminalRef.current;
          for (const link of links) {
            const open = link.activate;
            link.activate = (ev, text) => {
              const mode = localStorage.getItem('subterm-link-open-mode') || 'ctrl-click';
              if (mode === 'ctrl-click' && !IS_MOBILE_OS && !(ev.ctrlKey || ev.metaKey)) return;
              open(ev, text);
            };
            link.hover = () => {
              const mode = localStorage.getItem('subterm-link-open-mode') || 'ctrl-click';
              if (hintEl && mode === 'ctrl-click' && !IS_MOBILE_OS) {
                hintEl.title = `${/Mac/i.test(navigator.platform) ? 'Cmd' : 'Ctrl'}+Click to open`;
              }
            };
            link.leave = () => { if (hintEl) hintEl.removeAttribute('title'); };
          }

          callback(links.length > 0 ? links : undefined);
        },
      });
    } catch (e) {
      console.warn("LinkProvider registration failed:", e);
    }

    term.open(terminalRef.current);

    // Hardware-accelerated WebGL rendering with automatic canvas/DOM fallback
    let webglAddon: WebglAddon | null = null;
    const isWebglEnabled = localStorage.getItem('subterm-terminal-webgl') !== 'false';
    if (isWebglEnabled) {
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          console.warn("Terminal WebGL context lost; falling back to canvas.");
          addon.dispose();
          webglAddon = null;
        });
        term.loadAddon(addon);
        webglAddon = addon;
      } catch (err) {
        console.warn("WebGL addon unavailable, falling back to standard renderer:", err);
      }
    }
    
    setTimeout(() => {
      fitAddon.fit();
      if (isActiveRef.current && !disabledRef.current) {
        term.focus();
      }
      
      // Start PTY Session with correct dimensions only ONCE. Attach-only
      // instances skip this entirely — they hitch onto an existing PTY
      // opened by the primary instance and would collide with it if they
      // tried to open the same terminal_id a second time.
      if (!openedRef.current && !attachOnly) {
        openedRef.current = true;
        // Branch: a `containerExec` prop means we want a docker-exec
        // session into a specific container, not the regular login
        // shell. Same xterm wiring, different backend command — the
        // PTY/data/resize event topology is identical so xterm doesn't
        // notice the difference.
        if (isLocal) {
          invoke('open_local_terminal', {
            terminalId,
            cols: term.cols || 80,
            rows: term.rows || 24,
            cwd: localCwd || null,
            shell: localShell || null,
            channel: outputChannelRef.current,
            shellIntegrationOn: isFeatureEnabled('terminalCommandBlocks'),
            gitPromptOn: isFeatureEnabled('terminalGitPrompt'),
          }).catch(e => {
            term.writeln(`\x1b[31mFailed to open local terminal: ${e}\x1b[0m`);
          });
        } else if (containerExec) {
          invoke('open_container_terminal', {
            sessionId,
            terminalId,
            container: containerExec.container,
            cols: term.cols || 80,
            rows: term.rows || 24,
            useSudo: containerExec.useSudo,
            channel: outputChannelRef.current,
          }).catch(e => {
            term.writeln(`\x1b[31mFailed to attach to container: ${e}\x1b[0m`);
          });
        } else {
          invoke('open_terminal', {
            sessionId,
            terminalId,
            cols: term.cols || 80,
            rows: term.rows || 24,
            channel: outputChannelRef.current,
          }).catch(e => {
            term.writeln(`\x1b[31mFailed to open terminal: ${e}\x1b[0m`);
          });
        }
      }
    }, 50);

    xtermRef.current = term;

    // Handle Input — swallow keystrokes once the session is disconnected so
    // they don't pile up against a dead backend channel. When a mobile-key-bar
    // modifier is armed/locked we transform single printable characters into
    // the matching control sequence before sending (Ctrl+letter → 0x01-0x1a,
    // Alt+char → ESC-prefix). Multi-char inputs (paste, IME composition) are
    // forwarded verbatim because we can't sensibly "Ctrl" a phrase.
    const onDataDisposable = term.onData((data) => {
      if (disabledRef.current) return;
      // Typing at the prompt means the user answers it themselves.
      showSudoOffer(false);
      const mods = modifiersRef.current;
      const hasMod = mods.ctrl !== "off" || mods.alt !== "off";
      let bytes: number[];
      if (hasMod && data.length === 1) {
        const code = data.charCodeAt(0);
        let ch = code;
        if (mods.ctrl !== "off") {
          if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
            // Letters → C0 control (Ctrl+A = 0x01 … Ctrl+Z = 0x1a). `code & 0x1f`
            // does the right thing for both upper- and lower-case letters.
            ch = code & 0x1f;
          }
          // Non-letters under Ctrl are left as-is — Android's soft keyboard
          // rarely lets the user type the ones with defined C0 mappings
          // (Ctrl+@, Ctrl+[, Ctrl+\, Ctrl+] etc.) anyway, and silently
          // mangling normal punctuation while a Ctrl chip is lit would
          // confuse more than help.
        }
        bytes = [];
        if (mods.alt !== "off") bytes.push(0x1b); // ESC prefix → Meta
        bytes.push(ch);
        consumeArmedModifiers();
      } else {
        bytes = Array.from(new TextEncoder().encode(data));
      }
      getRecorder(terminalId)?.input(data);
      invoke('write_terminal_data', {
        terminalId,
        data: bytes,
      }).catch(console.error);

      // ── Broadcast fan-out ────────────────────────────────────────────────
      // Broadcast writes AFTER the local write so if the fan-out throws
      // synchronously it doesn't drop the source shell's own byte. We only
      // fan out when there are 2+ selected targets — a single target would
      // let the user broadcast to a single foreign session, which is
      // technically fine but almost always a footgun ("wait, why did that
      // command run there instead of here?"). 2+ makes the intent explicit.
      const bcast = broadcastRef.current;
      // Fan out ONLY when the source session is itself one of the armed
      // targets. Without this guard, typing into an unrelated session (not in
      // the target set) still wrote to every target — so a command meant only
      // for the focused server would silently execute on the broadcast group.
      // Requiring the source to be a member makes "this pane broadcasts to the
      // group" the explicit, safe model.
      if (bcast.enabled && bcast.targetSessionIds.size >= 2 && bcast.targetSessionIds.has(sessionId)) {
        for (const targetSid of bcast.targetSessionIds) {
          if (targetSid === sessionId) continue; // skip source; already written
          const targetTid = bcast.sessionTerminalMap[targetSid];
          if (!targetTid) continue; // target has no live terminal — silently skip
          invoke('write_terminal_data', {
            terminalId: targetTid,
            data: bytes,
          }).catch(() => {
            // Dead target — do NOT surface. The user asked for fire-and-forget
            // fan-out; failures here would spam their console every keystroke.
          });
        }
      }

      // ── Command history capture (best-effort) ────────────────────────────
      // Bufffer up bytes until we see a CR (Enter), then log the accumulated
      // line if it looks like a real command. Purely local heuristic — we do
      // not parse the shell's echo, so pastes / arrow-key edits will
      // over-count or mis-count. Skip anything under 3 chars to weed out
      // "y\r" prompts and stray Enters.
      for (let i = 0; i < data.length; i++) {
        const ch = data.charCodeAt(i);
        if (ch === 0x0d /* CR */ || ch === 0x0a /* LF */) {
          const line = commandBufRef.current.trim();
          if (isProdServer && DESTRUCTIVE_REGEX.test(line)) {
            setSafetyWarningCmd(line);
            return;
          }
          if (!isFeatureEnabled('terminalCommandBlocks')) {
            // command blocks disabled: skip tracking
          } else if (line.length > 0 && !/^(exit|logout)$/i.test(line)) {
            const currentLine = term.buffer.active.cursorY + term.buffer.active.baseY;
            const newBlock = {
              command: line,
              startedAt: Date.now(),
              startLine: currentLine,
              outputStartLine: currentLine + 1,
              running: true,
            };
            lastCommandRef.current = newBlock;
            setLastCommand(newBlock);
            if (commandDismissTimerRef.current) window.clearTimeout(commandDismissTimerRef.current);
          } else if (/^(exit|logout)$/i.test(line)) {
            setLastCommand(null);
          }
          commandBufRef.current = "";
          lineEditedRef.current = false;
          // Local shell only: offer to save/open a typed ssh/sftp target natively.
          if (isLocal && isFeatureEnabled('sshDetect') && !sshForegroundRef.current && !looksLikePasswordPrompt(recentOutputRef.current)) {
            // Prefer what the shell shows (Tab completion, history recall); the keystroke
            // buffer is only trusted when the line was typed plainly. Cut at the cursor so
            // inline predictions (PSReadLine, zsh-autosuggestions) are not read as typed.
            const edited = lineEditedRef.current;
            const target = parseSshFromScreen(readScreenCommand(), line, edited) ?? (edited ? null : parseSshCommand(line));
            if (target) {
              sshForegroundRef.current = true;
              if (!sshDismissedRef.current.has(sshTargetKey(target))) void handleSshTyped(target);
            }
          }
          // Do NOT persist what was typed at a no-echo password/passphrase
          // prompt — otherwise sudo/su/mysql -p/gpg secrets land verbatim in
          // searchable history. The onData handler can't see the PTY echo
          // mode, so we infer it from the remote output tail.
          if (line.length >= 3 && isFeatureEnabled('commandHistory') && !looksLikePasswordPrompt(recentOutputRef.current)) {
            invoke('cmd_history_add', {
              serverId: serverId > 0 ? serverId : null,
              serverName: serverName || "",
              command: line,
              maxEntries: Math.min(50000, Math.max(50, parseInt(localStorage.getItem('subterm-history-max') || '1000', 10) || 1000)),
            }).catch(() => { /* silent — history logging is best-effort */ });
          }
        } else if (ch === 0x7f /* DEL */ || ch === 0x08 /* BS */) {
          commandBufRef.current = commandBufRef.current.slice(0, -1);
        } else if (ch === 0x03 /* Ctrl+C */ || ch === 0x15 /* Ctrl+U */) {
          // Reset the buffer — the shell just cleared the line.
          commandBufRef.current = "";
          lineEditedRef.current = false;
        } else if (ch === 0x09 /* Tab — shell completion */) {
          lineEditedRef.current = true;
        } else if (ch === 0x1b /* ESC — arrow keys etc. */) {
          lineEditedRef.current = true;
          // Skip the whole ESC sequence rather than treating the following
          // bytes as literal characters. Simple heuristic:
          //   ESC [ ... <final>   → CSI, final byte is 0x40-0x7e
          //   ESC O <char>         → SS3 (function keys); consume one byte
          //   ESC <char>           → any other simple sequence; consume one
          const nxt = i + 1 < data.length ? data.charCodeAt(i + 1) : -1;
          if (nxt === 0x5b /* [ */) {
            i += 1; // consume '['
            while (i + 1 < data.length) {
              const fin = data.charCodeAt(i + 1);
              i++;
              if (fin >= 0x40 && fin <= 0x7e) break;
            }
          } else if (nxt !== -1) {
            i += 1; // consume the byte after ESC
          }
        } else if (ch >= 0x20 && ch <= 0x7e) {
          commandBufRef.current += data[i];
          if (commandBufRef.current.length > 4096) {
            // Cap to keep pathological pastes from ballooning memory.
            commandBufRef.current = commandBufRef.current.slice(-4096);
          }
        }
        // Other control chars are ignored on the assumption they don't
        // contribute to the user's visible command line.
      }
    });

    // ---- Copy on select / paste on right-click --------------------------------
    // Selection-change fires per mouse move during a drag — that's noisy AND
    // it would clobber the clipboard mid-drag. We instead wait for the user
    // to release the mouse, then copy whatever is currently selected.
    const writeClipboard = async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    };
    // term.getSelection() emits one '\n' per buffer row, including rows that
    // are mid-wrap continuations of the previous logical line — paste that
    // into anything and you get a phantom blank between every wrapped
    // segment. Walk the buffer ourselves using `isWrapped` so a wrapped
    // line round-trips as a single line. Plain (non-wrapped) row breaks
    // stay '\n'.
    const buildSelectedText = (): string => {
      const range = term.getSelectionPosition();
      if (!range) return '';
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let y = range.start.y; y <= range.end.y; y++) {
        const line = buf.getLine(y);
        if (!line) continue;
        const startX = y === range.start.y ? range.start.x : 0;
        const endX   = y === range.end.y   ? range.end.x   : undefined;
        const text = line.translateToString(true, startX, endX);
        if (y > range.start.y && line.isWrapped && lines.length > 0) {
          lines[lines.length - 1] += text;
        } else {
          lines.push(text);
        }
      }
      return lines.join('\n');
    };
    const copySelectionIfAny = async () => {
      if (localStorage.getItem('subterm-copy-on-select') === 'false') return;
      const text = buildSelectedText();
      if (!text) return;
      const ok = await writeClipboard(text);
      if (ok) notify('Copied');
    };
    // Copy-on-select must fire wherever the mouse is RELEASED — not only inside
    // the terminal. A user who drags a selection and lets go past the terminal's
    // edge (a very natural motion) still expects the copy, but the old handler
    // listened for `mouseup` on the terminal element itself, so a release
    // outside it never fired and only left the text selected.
    //
    // Instead: ARM on a left-button mousedown that starts inside this terminal,
    // then catch `mouseup` on the DOCUMENT so the release is seen anywhere.
    // Requiring the drag to have started here keeps an unrelated release
    // elsewhere from touching the clipboard, and copySelectionIfAny() no-ops
    // when there's no real selection — so a plain click (which clears the
    // selection) still can't clobber it. The selection end is set by the last
    // mousemove, so it's final by the time we read it on mouseup.
    let selectionArmed = false;
    const onMouseDown = (ev: MouseEvent) => {
      // Assign (not just set-true) so a non-left mousedown re-disarms a flag
      // that got stuck from an earlier drag whose mouseup we never saw.
      selectionArmed = ev.button === 0;
    };
    const onDocMouseUp = (ev: MouseEvent) => {
      if (ev.button !== 0 || !selectionArmed) return;
      selectionArmed = false;
      void copySelectionIfAny();
    };
    // If the window loses focus mid-drag (Alt-Tab, a focus-stealing dialog),
    // the button is released over another window and the matching `mouseup`
    // never reaches `document`, leaving selectionArmed stuck true. A later
    // unrelated left-click would then copy this terminal's stale selection and
    // clobber the clipboard. Disarm on blur so only a release we actually see
    // can copy.
    const onWindowBlur = () => { selectionArmed = false; };

    const sendPastedData = (raw: string) => {
      const normalized = raw.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
      invoke('write_terminal_data', {
        terminalId,
        data: Array.from(new TextEncoder().encode(normalized)),
      }).catch(console.error);
      notify('Pasted');
    };

    const handlePaste = (text: string) => {
      if (disabledRef.current) return;
      if (!text) return;

      if (isProdServer && DESTRUCTIVE_REGEX.test(text)) {
        setSafetyWarningCmd(text.trim());
        return;
      }

      const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
      // 0 turns the review off; the default of 3 matches the old fixed limit.
      const reviewAt = Math.max(0, parseInt(localStorage.getItem('subterm-paste-review-lines') || '3', 10) || 0);
      if (reviewAt > 0 && lines.length >= reviewAt && !pasteSafetyBypass) {
        setScriptPasteModal({ text, lines });
        return;
      }

      sendPastedData(text);
    };
    handlePasteRef.current = handlePaste;

    const onContextMenu = async (ev: MouseEvent) => {
      ev.preventDefault();
      if (disabledRef.current) return;
      const rightClickAction = localStorage.getItem('subterm-right-click-action') || 'smart';
      // Keep keyboard focus in this pane; the contextmenu event alone
      // doesn't focus xterm (matters for split panes).
      term.focus();
      if (rightClickAction === 'smart' && !ev.shiftKey) {
        const sel = term.getSelection();
        if (sel) {
          try {
            await navigator.clipboard.writeText(sel);
            term.clearSelection();
            notify('Copied');
          } catch { notify('Clipboard write denied', 'err'); }
          return;
        }
      }
      if ((rightClickAction === 'paste' || rightClickAction === 'smart') && !ev.shiftKey) {
        let text = '';
        try { text = await navigator.clipboard.readText(); }
        catch { notify('Clipboard read denied', 'err'); return; }
        if (!text) {
          const image = await readClipboardImage();
          if (image) pasteImageRef.current(image).catch((e) => notify(`Image paste failed: ${e}`, 'err'));
          return;
        }
        handlePaste(text);
        return;
      }

      setContextMenu({
        x: ev.clientX,
        y: ev.clientY,
        hasSelection: !!term.getSelection(),
        // Only remote sessions can have a saved SSH password; the backend
        // additionally no-ops (with a toast) if this particular session
        // authenticated via key instead.
        hasSavedPassword: !isLocal,
      });
    };

    const onPaste = (ev: ClipboardEvent) => {
      const text = ev.clipboardData?.getData('text');
      if (text) {
        ev.preventDefault();
        handlePaste(text);
        return;
      }
      const image = [...(ev.clipboardData?.items ?? [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile();
      if (image && !disabledRef.current) {
        ev.preventDefault();
        pasteImageRef.current(image).catch((e) => notify(`Image paste failed: ${e}`, 'err'));
      }
    };

    let touchCount = 0;
    let touchStartTime = 0;
    let touchStartX1 = 0;
    let touchStartY1 = 0;
    let touchStartX2 = 0;
    let touchStartY2 = 0;
    let initialPinchDist: number | null = null;
    let isPinching = false;
    let isSwiping = false;

    const onTouchStart = (ev: TouchEvent) => {
      touchCount = ev.touches.length;
      touchStartTime = Date.now();
      if (ev.touches.length === 2) {
        const t1 = ev.touches[0];
        const t2 = ev.touches[1];
        touchStartX1 = t1.clientX;
        touchStartY1 = t1.clientY;
        touchStartX2 = t2.clientX;
        touchStartY2 = t2.clientY;
        initialPinchDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        isPinching = false;
        isSwiping = false;
      } else {
        initialPinchDist = null;
      }
    };

    const onTouchMove = (ev: TouchEvent) => {
      if (ev.touches.length === 2 && initialPinchDist !== null) {
        const t1 = ev.touches[0];
        const t2 = ev.touches[1];
        const currentDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        const distDelta = currentDist - initialPinchDist;

        // Check if fingers are moving in the same direction (swipe) or opposite (pinch)
        const dx1 = t1.clientX - touchStartX1;
        const dx2 = t2.clientX - touchStartX2;
        const sameDirX = (dx1 * dx2 > 0) && Math.abs(dx1) > 25 && Math.abs(dx2) > 25;

        if (sameDirX && !isPinching) {
          isSwiping = true;
        } else if (Math.abs(distDelta) > 20 && !isSwiping) {
          isPinching = true;
          const currentFont = term.options.fontSize || 14;
          const fontDelta = distDelta > 0 ? 1 : -1;
          const newSize = Math.max(9, Math.min(30, currentFont + fontDelta));
          if (newSize !== currentFont) {
            term.options.fontSize = newSize;
            try { fitAddon.fit(); } catch {}
            localStorage.setItem('submarine-terminal-font-size', String(newSize));
            notify(`Font: ${newSize}px`);
            if (navigator.vibrate) navigator.vibrate(10);
            initialPinchDist = currentDist;
          }
        }
      }
    };

    const onTouchEnd = async (ev: TouchEvent) => {
      const elapsed = Date.now() - touchStartTime;

      if (touchCount === 2) {
        if (isSwiping) {
          const changed = ev.changedTouches;
          const lastTouch = changed[0];
          const avgStartX = (touchStartX1 + touchStartX2) / 2;
          const totalDx = lastTouch.clientX - avgStartX;
          if (Math.abs(totalDx) > 40) {
            const delta = totalDx > 0 ? -1 : 1;
            window.dispatchEvent(new CustomEvent('submarine-switch-tab-relative', { detail: { delta } }));
            notify(delta > 0 ? "Next Session →" : "← Previous Session");
            if (navigator.vibrate) navigator.vibrate(15);
          }
        } else if (!isPinching && elapsed < 350 && ev.touches.length === 0) {
          // Fast 2-finger tap -> paste from clipboard
          try {
            const text = await navigator.clipboard.readText();
            if (text) {
              handlePaste(text);
              notify("Pasted from clipboard");
              if (navigator.vibrate) navigator.vibrate(15);
            }
          } catch {
            notify("Clipboard access denied", "err");
          }
        }
      }

      touchCount = ev.touches.length;
      if (touchCount === 0) {
        initialPinchDist = null;
        isPinching = false;
        isSwiping = false;
      }
    };

    const handleOpenCopilot = (e?: Event) => {
      if (!isFeatureEnabled('aiCopilot')) return;
      const targetTerminalId = (e as CustomEvent<{ terminalId?: string } | undefined>)?.detail?.terminalId;
      if (targetTerminalId ? targetTerminalId !== terminalId : !isActiveRef.current) return;
      setShowCopilot(true);
    };

    const onDocKeyDown = (ev: KeyboardEvent) => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
      if (ev.key.toLowerCase() !== 'v') return;
      const container = terminalRef.current;
      if (!container) return;
      const active = document.activeElement;
      if (!(active instanceof Node) || !container.contains(active)) return;
      if (active instanceof HTMLElement) {
        const tag = active.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || active.isContentEditable) return;
      }
      ev.preventDefault();
      navigator.clipboard?.readText().then((text) => {
        if (text) handlePaste(text);
      }).catch(() => {});
    };

    terminalRef.current.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onDocMouseUp);
    document.addEventListener('keydown', onDocKeyDown);
    window.addEventListener('blur', onWindowBlur);
    terminalRef.current.addEventListener('contextmenu', onContextMenu);
    terminalRef.current.addEventListener('paste', onPaste);
    terminalRef.current.addEventListener('touchstart', onTouchStart, { passive: true });
    terminalRef.current.addEventListener('touchmove', onTouchMove, { passive: true });
    terminalRef.current.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener(`submarine-open-copilot-${sessionId}`, handleOpenCopilot);

    // Handle Resize
    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      getRecorder(terminalId)?.resize(cols, rows);
      invoke('resize_terminal', { terminalId, cols, rows }).catch(console.error);
    });

    // Handle Output. The backend sends coalesced batches as raw bytes through
    // a Tauri 2 binary Channel (see outputChannelRef below) instead of a
    // base64-encoded event payload — small batches arrive as a zero-copy
    // ArrayBuffer via a direct eval, larger ones via the binary fetch-channel-
    // data path. Either way `onmessage` hands us an ArrayBuffer directly, no
    // atob/JSON decode needed.
    let hasReceivedFirstOutput = false;
    const outputChannel = outputChannelRef.current!;
    outputChannel.onmessage = (raw) => {
      const data = new Uint8Array(raw as ArrayBuffer);
      term.write(data);
      getRecorder(terminalId)?.output(data);
      if (!hasReceivedFirstOutput) {
        hasReceivedFirstOutput = true;
        if (isActiveRef.current && !disabledRef.current) {
          const activeEl = document.activeElement;
          const isInputFocused = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.getAttribute('contenteditable') === 'true');
          if (!isInputFocused) {
            term.focus();
          }
        }
      }
      // Keep a short tail of decoded output so command-history capture can
      // recognize a no-echo password prompt and skip the typed secret.
      try {
        const txt = outputDecoderRef.current.decode(data, { stream: true });
        const combined = recentOutputRef.current + txt;
        recentOutputRef.current = combined.length > 512 ? combined.slice(-512) : combined;
        if (probeOutputRef.current !== null) probeOutputRef.current += txt;
        if (sshForegroundRef.current && (SSH_ENDED_RE.test(txt) || endsWithWindowsShellPrompt(recentOutputRef.current))) sshForegroundRef.current = false;
        // Output that no longer ends in the prompt (sudo timed out, the command ended) retires the offer.
        if (sudoOfferRef.current && !looksLikeSudoPrompt(recentOutputRef.current)) showSudoOffer(false);
        else if (!isLocal && !sudoOfferRef.current && isFeatureEnabled('sudoFill') && looksLikeSudoPrompt(recentOutputRef.current)) {
          invoke<boolean>('has_saved_password', { sessionId })
            .then((has) => { if (has && looksLikeSudoPrompt(recentOutputRef.current)) showSudoOffer(true); })
            .catch(() => {});
        }

        // Best-effort prompt CWD detection (e.g. user@hostname:path$ or user@hostname:path#)
        // ANSI colours are stripped first: stock Debian/Ubuntu prompts are coloured, which hid the path.
        const promptCwd = parsePromptCwd(txt);
        if (promptCwd) {
          currentCwdRef.current = promptCwd;
          setTerminalCwd(terminalId, promptCwd);
        }

        const promptBranch = parsePromptGitBranch(txt);
        if (promptBranch) {
          setTerminalGitBranch(terminalId, promptBranch);
        }

        // Terminal Triggers & Alert Keywords — scanned against just this
        // chunk (not the sliding tail buffer above) so a persistent match
        // doesn't re-fire on every subsequent batch. See triggers.ts for why.
        if (compiledTriggersRef.current.length) {
          for (const trigger of matchTriggers(txt, compiledTriggersRef.current)) {
            switch (trigger.action) {
              case 'notify':
                notify(`Trigger matched: ${trigger.pattern}`, 'err');
                break;
              case 'chime':
                playTerminalBellChime();
                break;
              case 'highlight':
                setBellActive(true);
                if (bellTimerRef.current) window.clearTimeout(bellTimerRef.current);
                bellTimerRef.current = window.setTimeout(() => setBellActive(false), 400);
                break;
              case 'log':
                window.dispatchEvent(new CustomEvent('subterm-add-log', {
                  detail: { msg: `[Trigger "${trigger.pattern}"] ${txt.trim().slice(0, 200)}`, type: 'warning' },
                }));
                break;
            }
          }
        }
      } catch { /* decode hiccup on a split multibyte chunk — ignore */ }

      // If a command was started without OSC 133 shell integration, detect output settling
      if (lastCommandRef.current && lastCommandRef.current.running) {
        if (commandSettleTimerRef.current) window.clearTimeout(commandSettleTimerRef.current);
        commandSettleTimerRef.current = window.setTimeout(() => {
          if (lastCommandRef.current && lastCommandRef.current.running && xtermRef.current) {
            const currentLine = xtermRef.current.buffer.active.cursorY + xtermRef.current.buffer.active.baseY;
            const updated = {
              ...lastCommandRef.current,
              endLine: currentLine,
              running: false,
              exitCode: 0,
            };
            lastCommandRef.current = updated;
            setLastCommand(updated);

            if (localStorage.getItem('subterm-auto-copy-output') === 'true') {
              copyCommandOutput(updated);
            }

            const rawSec = localStorage.getItem('subterm-command-dismiss-sec');
            const dismissSec = rawSec !== null ? Math.max(0, parseInt(rawSec, 10) || 0) : 4;
            if (dismissSec > 0) {
              if (commandDismissTimerRef.current) window.clearTimeout(commandDismissTimerRef.current);
              commandDismissTimerRef.current = window.setTimeout(() => {
                setLastCommand(null);
              }, dismissSec * 1000);
            }
          }
        }, 500);
      }
    };

    // If this instance watches a terminal it doesn't own (split-pane attach),
    // register the channel as an additional output sink now. The owner
    // passes its channel directly to open_terminal/open_local_terminal/
    // open_container_terminal below instead, so it isn't double-registered.
    if (attachOnly) {
      invoke('subscribe_terminal_output', { terminalId, channel: outputChannelRef.current }).catch(console.error);
    }

    // Handle Terminal Closure (Server exit / EOF / drop)
    const unlistenClosedPromise = listen(`terminal-closed-${terminalId}`, (event: { payload?: { clean_exit?: boolean } }) => {
      if (commandSettleTimerRef.current) window.clearTimeout(commandSettleTimerRef.current);
      if (commandDismissTimerRef.current) window.clearTimeout(commandDismissTimerRef.current);
      setLastCommand(null);
      const cleanExit = !!event.payload?.clean_exit;
      let transcript = "";
      if (xtermRef.current) {
        const t = xtermRef.current;
        const lines: string[] = [];
        const total = t.buffer.active.length;
        for (let i = 0; i < total; i++) {
          const l = t.buffer.active.getLine(i);
          if (l) lines.push(l.translateToString(true));
        }
        while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
          lines.pop();
        }
        transcript = lines.join("\n");
      }
      onTerminalClosedRef.current?.({ cleanExit, transcript });
    });

    // Coalesce resize bursts via rAF, and skip the refit on hidden tabs
    // so SIGWINCH doesn't leak to background PTYs (the become-visible
    // effect refits when the tab is shown again).
    let rafId = 0;
    const resizeObserver = new ResizeObserver(() => {
      if (!xtermRef.current) return;
      if (!isActiveRef.current) return;
      if (rafId) return; // a rAF is already queued; coalesce
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (!xtermRef.current) return;
        if (!isActiveRef.current) return;
        try {
          fitAddon.fit();
          const t = xtermRef.current;
          t.refresh(0, Math.max(0, t.rows - 1));
        } catch { /* swallow — xterm tolerates transient 0×0 sizes */ }
      });
    });
    resizeObserver.observe(terminalRef.current);
    
    // Handle Settings Change
    const handleSettingsChange = () => {
      let needsFit = false;
      const newSize = parseInt(localStorage.getItem('subterm-terminal-font-size') || localStorage.getItem('submarine-terminal-font-size') || '14');
      if (term.options.fontSize !== newSize) {
        term.options.fontSize = newSize;
        needsFit = true;
      }
      const newFontFamily = localStorage.getItem('subterm-terminal-font-family') || 'JetBrains Mono, Menlo, Monaco, Consolas, "Courier New", monospace';
      if (term.options.fontFamily !== newFontFamily) {
        term.options.fontFamily = newFontFamily;
        needsFit = true;
      }
      const newLineHeight = parseFloat(localStorage.getItem('subterm-terminal-line-height') || '1.15');
      if (term.options.lineHeight !== newLineHeight) {
        term.options.lineHeight = newLineHeight;
        needsFit = true;
      }
      const newScrollback = parseInt(localStorage.getItem('subterm-terminal-scrollback') || '5000', 10);
      if (term.options.scrollback !== newScrollback) {
        term.options.scrollback = newScrollback;
      }
      const newThemeId = localStorage.getItem('subterm-terminal-theme') || 'subterm-dark';
      term.options.allowTransparency = readOpacity() < 100;
      term.options.theme = withBackgroundOpacity(withCursorColor(getTerminalTheme(newThemeId)));
      const newSeparators = localStorage.getItem('subterm-word-separators');
      if (newSeparators !== null && term.options.wordSeparator !== newSeparators) term.options.wordSeparator = newSeparators;
      term.options.scrollOnUserInput = localStorage.getItem('subterm-scroll-on-input') !== 'false';
      const newPadding = Math.max(0, parseInt(localStorage.getItem('subterm-terminal-padding') || '0', 10) || 0);
      if (terminalRef.current && terminalRef.current.style.padding !== `${newPadding}px`) {
        terminalRef.current.style.padding = `${newPadding}px`;
        needsFit = true;
      }
      const newCursorStyle = (localStorage.getItem('subterm-terminal-cursor-style') || 'block') as 'block' | 'underline' | 'bar';
      term.options.cursorStyle = newCursorStyle;
      const newCursorBlink = localStorage.getItem('subterm-terminal-cursor-blink') !== 'false';
      term.options.cursorBlink = newCursorBlink;
      if (needsFit) {
        fitAddon.fit();
      }
    };
    window.addEventListener('subterm-settings-changed', handleSettingsChange);
    window.addEventListener('submarine-settings-changed', handleSettingsChange);

    // ── Mobile QoL ───────────────────────────────────────────────────────────
    // Capture the container ref here so the listener add/remove calls and the
    // cleanup closure all reference the same element — the live ref can flip
    // to null between mount and cleanup if React tears the subtree down out
    // of order, and we'd leak event handlers in that case.
    const container = terminalRef.current;
    // On soft-keyboard open (`visualViewport.resize` shrinks) refit so xterm's
    // row count matches the now-shorter visible area and scroll to the
    // prompt so the cursor row sits just above the kb.
    //
    // We deliberately do NOT hook mousedown / touchstart here. Those fire at
    // the START of a selection drag, and a scrollToBottom() there yanks the
    // viewport out from under the user's finger and destroys the selection
    // anchor (v0.2.30-v0.2.31 regression). xterm already scrolls on user
    // keystrokes via `scrollOnUserInput` (default true) and on PTY writes,
    // so tapping to focus + typing already reveals the prompt without our
    // help. This handler is what actually implements "keyboard opens →
    // prompt in view" and is the only trigger we want.
    //
    // No-op on desktop: visualViewport.resize doesn't fire from window resizes,
    // only virtual-keyboard / pinch-zoom.
    const scrollPromptIntoView = () => {
      requestAnimationFrame(() => {
        try { fitAddon.fit(); } catch { /* terminal not ready */ }
        term.scrollToBottom();
      });
    };

    let lastVvHeight = window.visualViewport?.height ?? window.innerHeight;
    const onVvResize = () => {
      const h = window.visualViewport?.height ?? window.innerHeight;
      if (h < lastVvHeight - 80) {
        // Drop ≥80px almost always means the soft keyboard opened (not a
        // small browser-UI reflow). 80px is comfortably above the URL-bar
        // collapse delta on Chrome/Android.
        scrollPromptIntoView();
      }
      lastVvHeight = h;
    };
    window.visualViewport?.addEventListener('resize', onVvResize);

    return () => {
      window.removeEventListener('subterm-settings-changed', handleSettingsChange);
      window.removeEventListener('submarine-settings-changed', handleSettingsChange);
      resizeObserver.disconnect();
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
      onBellDisposable.dispose();
      if (bellTimerRef.current) window.clearTimeout(bellTimerRef.current);
      if (container) {
        container.removeEventListener('mousedown', onMouseDown);
        container.removeEventListener('contextmenu', onContextMenu);
        container.removeEventListener('paste', onPaste);
        container.removeEventListener('touchstart', onTouchStart);
        container.removeEventListener('touchend', onTouchEnd);
      }
      window.removeEventListener(`submarine-open-copilot-${sessionId}`, handleOpenCopilot);
      document.removeEventListener('mouseup', onDocMouseUp);
      document.removeEventListener('keydown', onDocKeyDown);
      window.removeEventListener('blur', onWindowBlur);
      window.visualViewport?.removeEventListener('resize', onVvResize);
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      if (commandSettleTimerRef.current) window.clearTimeout(commandSettleTimerRef.current);
      if (commandDismissTimerRef.current) window.clearTimeout(commandDismissTimerRef.current);
      unlistenClosedPromise.then(unlisten => unlisten());
      if (webglAddon) {
        try {
          webglAddon.dispose();
        } catch { /* ignore */ }
        webglAddon = null;
      }
      searchAddon.dispose();
      searchAddonRef.current = null;
      term.dispose();
      // Only the PTY owner tears the backend PTY down on unmount.
      // Attach-only viewers unmount without closing so the primary
      // xterm (in the session tab) keeps working.
      if (!attachOnly) {
        invoke('close_terminal', { terminalId }).catch(console.error);
      }
    };
  }, [sessionId, terminalId]);

  // Runs after the xterm above exists: start the automatic recording for an always-recorded server.
  useEffect(() => {
    if (canAlwaysRecord && alwaysRecord) startAutoRecording();
  }, [canAlwaysRecord, alwaysRecord, startAutoRecording]);

  return (
    // flex-col so the MobileKeyBar can pin to the bottom of the terminal
    // pane (between xterm and the system soft keyboard). On desktop the bar
    // isn't rendered at all, so the xterm child claims the full height as
    // before.
    <div
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (!target.closest('button, input, select, textarea, [role="button"]')) {
          xtermRef.current?.focus();
        }
      }}
      className={`terminal-surface h-full w-full bg-[#09090b] p-2 pr-2 pb-0 relative flex flex-col transition-all duration-150 ${
        bellActive ? "ring-2 ring-amber-400 shadow-[inset_0_0_24px_rgba(251,191,36,0.25)]" : ""
      }`}
    >
      <div
        ref={terminalRef}
        className="flex-1 min-h-0 w-full overflow-hidden select-text"
      />
      {/* Search chip — floats above xterm; positioned inside the outer
          flex column so it never displaces the terminal grid. Absolute
          top-2 right-2 keeps it clear of the disconnected badge (which
          centers) and the clipboard toast (bottom-right). */}
      {showSearch && (
        <div className="absolute top-2 right-2 z-20 flex items-center gap-1.5 rounded-lg bg-[#141419]/95 backdrop-blur-md border border-white/10 px-2 py-1 shadow-2xl font-sans select-none animate-in fade-in duration-100">
          <input
            ref={searchInputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setQuery('');
                closeSearch();
              } else if (e.key === 'Enter') {
                e.preventDefault();
                runFind(e.shiftKey ? 'prev' : 'next');
              } else if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
                e.preventDefault();
                (e.currentTarget as HTMLInputElement).select();
              }
              e.stopPropagation();
            }}
            placeholder="Find in terminal…"
            className="bg-transparent outline-none text-[11px] text-zinc-100 placeholder:text-zinc-500 w-36 px-1 font-mono"
          />

          {/* Results counter badge */}
          {query.trim() && (
            <span className="text-[10px] font-mono text-zinc-400 px-1 whitespace-nowrap">
              {searchResults
                ? searchResults.resultCount === 0
                  ? "No matches"
                  : `${searchResults.resultIndex + 1} of ${searchResults.resultCount}`
                : "No matches"}
            </span>
          )}

          {/* Search options toggles */}
          <div className="flex items-center gap-0.5 border-l border-white/10 pl-1">
            <button
              type="button"
              onClick={() => setSearchCaseSensitive((v) => !v)}
              title="Match Case (Alt+C)"
              className={`px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors ${
                searchCaseSensitive
                  ? "bg-primary/20 text-primary font-bold"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
              }`}
            >
              Aa
            </button>
            <button
              type="button"
              onClick={() => setSearchWholeWord((v) => !v)}
              title="Match Whole Word (Alt+W)"
              className={`px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors ${
                searchWholeWord
                  ? "bg-primary/20 text-primary font-bold"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
              }`}
            >
              \b
            </button>
            <button
              type="button"
              onClick={() => setSearchRegex((v) => !v)}
              title="Use Regular Expression (Alt+R)"
              className={`px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors ${
                searchRegex
                  ? "bg-primary/20 text-primary font-bold"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
              }`}
            >
              .*
            </button>
          </div>

          {/* Nav arrows & close */}
          <div className="flex items-center gap-0.5 border-l border-white/10 pl-1">
            <button
              type="button"
              onClick={() => runFind('prev')}
              title="Previous match (Shift+Enter)"
              className="p-1 text-[11px] text-zinc-400 hover:text-white hover:bg-white/10 rounded transition-colors"
            >
              <ChevronUp size={12} />
            </button>
            <button
              type="button"
              onClick={() => runFind('next')}
              title="Next match (Enter)"
              className="p-1 text-[11px] text-zinc-400 hover:text-white hover:bg-white/10 rounded transition-colors"
            >
              <ChevronDown size={12} />
            </button>
            <button
              type="button"
              onClick={() => { setQuery(''); closeSearch(); }}
              title="Close (Esc)"
              className="p-1 text-[11px] text-zinc-400 hover:text-red-400 hover:bg-white/10 rounded transition-colors"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {!contextMenu && (
        <button
          type="button"
          // mousedown default would move focus off the terminal before the menu opens
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenuAt(r.right, r.bottom + 4); }}
          title="Terminal menu (same as Shift+Right-Click)"
          aria-label="Terminal menu"
          className="absolute top-1.5 right-4 z-10 h-5 w-5 rounded flex items-center justify-center text-zinc-500 opacity-40 hover:opacity-100 hover:bg-white/10 hover:text-white transition-opacity select-none"
        >
          <MoreVertical size={13} />
        </button>
      )}

      {recording && recordingEnabled && (
        <button
          type="button"
          onClick={() => handleStopRecording('cast')}
          title="Recording - click to stop and save (.cast)"
          className="absolute bottom-2 right-3 z-20 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-500/15 border border-red-500/40 text-[10px] font-bold text-red-300 hover:bg-red-500/25 transition-colors select-none"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
          REC
        </button>
      )}

      {/* Floating Command Output Quick Actions & OSC 133 Status */}
      {lastCommand && isFeatureEnabled('terminalCommandBlocks') && (
        <div
          className={`absolute ${showSearch ? 'top-12' : 'top-2'} right-2 z-20 flex items-center gap-1.5 p-1 bg-[#121217]/95 backdrop-blur-md border border-white/10 rounded-lg shadow-xl text-xs font-mono select-none animate-in fade-in slide-in-from-top-1 duration-150`}
        >
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/[0.04]">
            {lastCommand.running ? (
              <span className="flex items-center gap-1 text-sky-400">
                <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-ping" />
                <span className="text-[10px] uppercase font-bold">running</span>
              </span>
            ) : lastCommand.exitCode === 0 ? (
              <span className="flex items-center gap-1 text-emerald-400">
                <Check size={11} />
                <span className="text-[10px] font-bold">0</span>
              </span>
            ) : lastCommand.exitCode !== undefined ? (
              <span className="flex items-center gap-1 text-rose-400">
                <span className="text-[10px] font-bold">exit {lastCommand.exitCode}</span>
              </span>
            ) : (
              <span className="text-[10px] text-zinc-400">cmd</span>
            )}
            <span className="text-zinc-300 font-semibold max-w-[130px] truncate text-[10.5px]">
              {lastCommand.command}
            </span>
          </div>

          <button
            type="button"
            onClick={() => copyCommandOutput(lastCommand)}
            title="Copy command output without prompt (Alt+O)"
            className="h-6 px-2 rounded bg-white/[0.05] hover:bg-white/10 text-zinc-300 hover:text-white flex items-center gap-1 text-[10.5px] transition-colors"
          >
            <Copy size={11} />
            <span>Copy Output</span>
          </button>

          {copilotEnabled && lastCommand.exitCode !== undefined && lastCommand.exitCode !== 0 && (
            <button
              type="button"
              onClick={() => explainFailure(lastCommand)}
              title="Ask the AI assistant why this failed (Ctrl+I opens the panel)"
              className="h-6 px-2 rounded bg-rose-500/15 border border-rose-500/30 hover:bg-rose-500/25 text-rose-300 flex items-center gap-1 text-[10.5px] font-bold transition-colors"
            >
              <Sparkles size={11} />
              <span>Explain</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setLastCommand(null)}
            className="w-5 h-5 rounded hover:bg-white/10 text-zinc-500 hover:text-zinc-300 flex items-center justify-center transition-colors"
            title="Dismiss command status"
          >
            <X size={10} />
          </button>
        </div>
      )}
      {isMobile && !disabled && (
        <MobileKeyBar
          modifiers={modifiers}
          onToggleModifier={toggleModifier}
          onSpecialKey={sendSpecialKey}
        />
      )}
      {sudoOffer && (
        <div className="absolute bottom-3 left-3 right-3 sm:right-auto z-20 flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg bg-[#121217]/95 border border-white/10 shadow-xl text-[11px] font-sans text-zinc-200">
          <span>sudo is asking for a password. Fill in the saved password for this server?</span>
          <button
            type="button"
            onClick={fillSudoPassword}
            className="px-2 py-0.5 rounded bg-primary/20 border border-primary/40 text-primary font-bold hover:bg-primary/30"
          >
            Fill password
          </button>
          <button
            type="button"
            onClick={() => { showSudoOffer(false); xtermRef.current?.focus(); }}
            className="px-2 py-0.5 rounded text-zinc-400 hover:text-white hover:bg-white/10"
          >
            Dismiss
          </button>
        </div>
      )}
      {sshOffer && (
        <div className="absolute bottom-3 left-3 right-3 sm:right-auto z-20 flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg bg-[#121217]/95 border border-white/10 shadow-xl text-[11px] font-sans text-zinc-200">
          {sshOffer.matches.length > 0 ? (
            <>
              <span>
                <b className="text-white">{sshOffer.resolved.host}</b> is a saved server. Open it
                {sshOffer.target.kind === 'sftp' ? ' with the file panel' : ''}?
              </span>
              {sshOffer.matches.slice(0, 3).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => openSshOffer(sshOffer, 'saved', m.id)}
                  className="px-2 py-0.5 rounded bg-primary/20 border border-primary/40 text-primary font-bold hover:bg-primary/30"
                >
                  {m.name}
                </button>
              ))}
            </>
          ) : (
            <>
              <span>
                <b className="text-white">{sshOffer.resolved.username}@{sshOffer.resolved.host}</b> is not saved. Add it to your servers
                {sshOffer.target.kind === 'sftp' ? ' (opens the file panel)' : ''}?
              </span>
              <button
                type="button"
                onClick={() => openSshOffer(sshOffer, 'save')}
                className="px-2 py-0.5 rounded bg-primary/20 border border-primary/40 text-primary font-bold hover:bg-primary/30"
              >
                Save &amp; open
              </button>
              <button
                type="button"
                onClick={() => openSshOffer(sshOffer, 'quick')}
                className="px-2 py-0.5 rounded border border-white/15 text-zinc-200 hover:bg-white/10"
              >
                Quick Connect
              </button>
            </>
          )}
          <button
            type="button"
            onClick={dismissSshOffer}
            className="px-2 py-0.5 rounded text-zinc-400 hover:text-white hover:bg-white/10"
          >
            Dismiss
          </button>
        </div>
      )}
      {/* Clipboard toast — bottom-right of the terminal pane. Pointer-events
          off so a stray hover never blocks selection / right-click. */}
      {toast && (
        <div className="absolute bottom-3 right-3 z-20 pointer-events-none">
          <span
            className={`px-2.5 py-1 rounded text-[10.5px] font-mono uppercase tracking-wider border ${
              toast.tone === 'err'
                ? 'bg-rose-500/15 border-rose-500/30 text-rose-300'
                : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
            }`}
          >
            {toast.msg}
          </span>
        </div>
      )}
      <HistorySearchOverlay
        isOpen={showHistory}
        onClose={() => {
          setShowHistory(false);
          // Return focus to xterm so the user can keep typing at the prompt
          // instead of losing keystrokes into the void.
          xtermRef.current?.focus();
        }}
        filterServerId={serverId > 0 ? serverId : null}
        onInsert={(command, execute) => {
          if (disabledRef.current) return;
          const payload = execute ? command + "\r" : command;
          const bytes = Array.from(new TextEncoder().encode(payload));
          invoke('write_terminal_data', { terminalId, data: bytes }).catch(console.error);
          // Mirror the inserted command into the local buffer so the next
          // Enter (if the user typed one manually) still logs correctly.
          if (!execute) commandBufRef.current = command;
        }}
      />
      {copilotEnabled && copilotMounted && (
        <Suspense fallback={null}>
          <div className={showCopilot ? '' : 'hidden'}>
            <AiPanel
              sessionId={sessionId}
              target={serverName || 'this server'}
              isLocal={isLocal}
              localCwd={localCwd}
              localShell={localShell}
              canRun={!containerExec}
              isProd={isProdServer}
              readTerminal={readTerminal}
              seed={copilotSeed}
              open={showCopilot}
              onClose={() => {
                setShowCopilot(false);
                xtermRef.current?.focus();
              }}
              onInsertCommand={(command, execute) => {
                if (disabledRef.current) return;
                const payload = execute ? command + "\r" : command;
                const bytes = Array.from(new TextEncoder().encode(payload));
                invoke('write_terminal_data', { terminalId, data: bytes }).catch(console.error);
                if (!execute) commandBufRef.current = command;
                xtermRef.current?.focus();
              }}
            />
          </div>
        </Suspense>
      )}
      {/* Disabled badge */}
      {disabled && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
          <span className="px-2.5 py-1 rounded text-[10.5px] font-mono uppercase tracking-wider border bg-rose-500/15 border-rose-500/30 text-rose-300 shadow-lg">
            Disconnected — buffer is read-only
          </span>
        </div>
      )}

      {/* Production Safety Guardrail Dialog */}
      {safetyWarningCmd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs animate-in fade-in duration-150">
          <div className="w-full max-w-lg bg-[#141216] border border-rose-500/30 rounded-xl shadow-2xl p-5 flex flex-col gap-4 animate-in zoom-in-95 duration-150">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 shrink-0">
                <AlertTriangle size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-[14px] font-bold text-white flex items-center gap-2">
                  <span>Destructive Command Guardrail</span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30 uppercase">
                    PROD
                  </span>
                </h3>
                <p className="text-[12px] text-zinc-400">
                  Potentially destructive command intercepted on <span className="font-semibold text-zinc-200">{serverName || "Production"}</span>:
                </p>
              </div>
            </div>

            <div className="bg-black/70 rounded-lg p-3 border border-white/5 font-mono text-[12px] text-rose-300 overflow-x-auto whitespace-pre-wrap break-all max-h-36 custom-scrollbar">
              {safetyWarningCmd}
            </div>

            <p className="text-[11px] text-zinc-400 leading-relaxed">
              This server is marked as a production environment. Executing this command could cause system instability, data loss, or service interruption.
            </p>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/5">
              <button
                type="button"
                onClick={() => {
                  invoke('write_terminal_data', { terminalId, data: [0x03] }).catch(console.error);
                  setSafetyWarningCmd(null);
                  commandBufRef.current = "";
                  notify("Command aborted", "err");
                }}
                className="px-3.5 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/10 text-zinc-300 hover:text-white text-[12px] font-medium transition-colors"
              >
                Cancel (Abort)
              </button>
              <button
                type="button"
                onClick={() => {
                  const cmd = safetyWarningCmd + "\r";
                  const bytes = Array.from(new TextEncoder().encode(cmd));
                  invoke('write_terminal_data', { terminalId, data: bytes }).catch(console.error);
                  setSafetyWarningCmd(null);
                  commandBufRef.current = "";
                }}
                className="px-3.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[12px] font-bold shadow-md shadow-rose-600/30 transition-all flex items-center gap-1.5"
              >
                <Play size={13} />
                Execute Anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Multi-Line Script Paste Preview Dialog */}
      {scriptPasteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs animate-in fade-in duration-150">
          <div className="w-full max-w-xl bg-[#121217] border border-white/10 rounded-xl shadow-2xl p-5 flex flex-col gap-4 animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/25 flex items-center justify-center text-primary">
                  <FileCode size={16} />
                </div>
                <div>
                  <h3 className="text-[13px] font-bold text-white flex items-center gap-2">
                    Paste Script Preview
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-white/10 text-zinc-300 font-mono">
                      {scriptPasteModal.lines.length} lines
                    </span>
                  </h3>
                  <p className="text-[11px] text-zinc-400">Review code lines before executing into the shell</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setScriptPasteModal(null)}
                className="w-7 h-7 rounded-lg text-zinc-500 hover:text-white hover:bg-white/10 flex items-center justify-center transition-colors"
              >
                <X size={15} />
              </button>
            </div>

            <div className="bg-black/80 rounded-lg p-3 border border-white/10 font-mono text-[11px] text-zinc-300 max-h-56 overflow-y-auto custom-scrollbar space-y-1">
              {scriptPasteModal.lines.map((line, idx) => (
                <div key={idx} className="flex items-start gap-3 hover:bg-white/[0.03] px-1 rounded">
                  <span className="text-zinc-600 select-none text-[10px] w-6 text-right shrink-0">{idx + 1}</span>
                  <span className="flex-1 break-all whitespace-pre-wrap">{line}</span>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-white/5">
              <label className="flex items-center gap-2 cursor-pointer select-none text-[11px] text-zinc-400 hover:text-zinc-300">
                <input
                  type="checkbox"
                  className="accent-primary rounded"
                  checked={pasteSafetyBypass}
                  onChange={(e) => setPasteSafetyBypass(e.target.checked)}
                />
                Don't ask again for this terminal
              </label>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setScriptPasteModal(null)}
                  className="px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/10 text-zinc-300 hover:text-white text-[12px] font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const normalized = scriptPasteModal.text.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
                    invoke('write_terminal_data', {
                      terminalId,
                      data: Array.from(new TextEncoder().encode(normalized)),
                    }).catch(console.error);
                    notify('Pasted');
                    setScriptPasteModal(null);
                  }}
                  className="px-3.5 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-black text-[12px] font-bold shadow-md shadow-primary/20 transition-all flex items-center gap-1.5"
                >
                  <Play size={13} />
                  Paste & Run
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {contextMenu && (
        <TerminalContextMenu
          menu={contextMenu}
          onClose={() => { setContextMenu(null); xtermRef.current?.focus(); }}
          onCopy={handleContextCopy}
          onPaste={handleContextPaste}
          onSelectAll={handleContextSelectAll}
          onFind={handleContextFind}
          onClear={handleContextClear}
          onReset={handleContextReset}
          onExport={handleContextExport}
          recording={recordingEnabled ? recording : null}
          onStartRecording={handleStartRecording}
          onStopRecording={handleStopRecording}
          alwaysRecord={canAlwaysRecord ? alwaysRecord : null}
          onToggleAlwaysRecord={toggleAlwaysRecord}
          onPasteSavedPassword={handlePasteSavedPassword}
        />
      )}
    </div>
  );
};

export default TerminalView;