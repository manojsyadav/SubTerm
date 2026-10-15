import { useState, useEffect, useRef, useCallback } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Home,
  ShieldCheck,
  ShieldAlert,
  Globe,
  ExternalLink,
  Copy,
  Check,
  Star,
  Plus,
  Trash2,
  Server,
  Layers,
  HardDrive,
  Activity,
  Gauge,
  Wifi,
} from "lucide-react";
import {
  startBrowserProxy,
  getBrowserProxyStatus,
  openBrowserWindow,
  openExternalUrl,
  buildProxiedUrl,
  normalizeUrl,
  loadBookmarks,
  saveBookmarks,
  Bookmark,
  ProxyInfo,
} from "../browser/browserService";

interface Props {
  initialUrl?: string;
  serverHost?: string;
  serverName?: string;
  onClose?: () => void;
  onStatusChange?: (status: string) => void;
}

export default function BrowserView({
  initialUrl = "https://127.0.0.1:8006",
  serverHost,
  serverName,
  onClose: _onClose,
  onStatusChange,
}: Props) {
  // If serverHost is provided and initialUrl is default, adapt to serverHost
  const defaultTarget = serverHost
    ? `https://${serverHost}:8006`
    : initialUrl;

  const [currentUrl, setCurrentUrl] = useState(defaultTarget);
  const [inputUrl, setInputUrl] = useState(defaultTarget);
  const [useProxy, setUseProxy] = useState(true);
  const [proxy, setProxy] = useState<ProxyInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [history, setHistory] = useState<string[]>([defaultTarget]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(loadBookmarks);
  const [showBookmarksBar, setShowBookmarksBar] = useState(true);
  const [frameError, setFrameError] = useState<string | null>(null);

  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Initialize or fetch the local homelab proxy
  useEffect(() => {
    let mounted = true;
    startBrowserProxy()
      .then((p) => {
        if (mounted) setProxy(p);
      })
      .catch(() => {
        getBrowserProxyStatus().then((p) => {
          if (mounted) setProxy(p);
        });
      });

    onStatusChange?.("connected");
    return () => {
      mounted = false;
    };
  }, [onStatusChange]);

  const targetHost = serverHost || "127.0.0.1";

  // Derive iframe URL based on proxy mode
  const effectiveSrc = useProxy && proxy && proxy.running
    ? buildProxiedUrl(proxy, currentUrl)
    : currentUrl;

  const navigateTo = useCallback((raw: string, addToHistory = true) => {
    const next = normalizeUrl(raw);
    setCurrentUrl(next);
    setInputUrl(next);
    setIsLoading(true);
    setFrameError(null);

    if (addToHistory) {
      setHistory((prev) => {
        const nextHist = prev.slice(0, historyIndex + 1);
        return [...nextHist, next];
      });
      setHistoryIndex((prev) => prev + 1);
    }
  }, [historyIndex]);

  const handleBack = () => {
    if (historyIndex > 0) {
      const prevIdx = historyIndex - 1;
      setHistoryIndex(prevIdx);
      const target = history[prevIdx];
      setCurrentUrl(target);
      setInputUrl(target);
      setIsLoading(true);
      setFrameError(null);
    }
  };

  const handleForward = () => {
    if (historyIndex < history.length - 1) {
      const nextIdx = historyIndex + 1;
      setHistoryIndex(nextIdx);
      const target = history[nextIdx];
      setCurrentUrl(target);
      setInputUrl(target);
      setIsLoading(true);
      setFrameError(null);
    }
  };

  const handleReload = () => {
    setIsLoading(true);
    setFrameError(null);
    if (iframeRef.current) {
      iframeRef.current.src = effectiveSrc;
    }
  };

  const handleCopyUrl = () => {
    navigator.clipboard.writeText(currentUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleToggleBookmark = () => {
    const exists = bookmarks.some((b) => b.url === currentUrl);
    let updated: Bookmark[];
    if (exists) {
      updated = bookmarks.filter((b) => b.url !== currentUrl);
    } else {
      const name = serverName ? `${serverName} Web` : new URL(currentUrl).hostname;
      updated = [
        ...bookmarks,
        {
          id: `bm-${Date.now()}`,
          title: name,
          url: currentUrl,
        },
      ];
    }
    setBookmarks(updated);
    saveBookmarks(updated);
  };

  const isBookmarked = bookmarks.some((b) => b.url === currentUrl);

  const getPresetIcon = (title: string) => {
    const lower = title.toLowerCase();
    if (lower.includes("proxmox")) return <Server size={13} className="text-amber-400" />;
    if (lower.includes("portainer")) return <Layers size={13} className="text-sky-400" />;
    if (lower.includes("truenas")) return <HardDrive size={13} className="text-emerald-400" />;
    if (lower.includes("grafana")) return <Activity size={13} className="text-orange-400" />;
    if (lower.includes("cockpit")) return <Gauge size={13} className="text-cyan-400" />;
    return <Globe size={13} className="text-zinc-400" />;
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[#09090b] text-zinc-100 select-none overflow-hidden">
      {/* Primary Browser Navigation Toolbar */}
      <div className="flex items-center gap-1.5 px-3 py-2 bg-[#101014] border-b border-white/5 shrink-0">
        <button
          onClick={handleBack}
          disabled={historyIndex === 0}
          title="Back"
          className="p-1.5 rounded hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent text-zinc-300 transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <button
          onClick={handleForward}
          disabled={historyIndex >= history.length - 1}
          title="Forward"
          className="p-1.5 rounded hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent text-zinc-300 transition-colors"
        >
          <ArrowRight size={16} />
        </button>
        <button
          onClick={handleReload}
          title="Reload"
          className="p-1.5 rounded hover:bg-white/10 text-zinc-300 transition-colors"
        >
          <RotateCw size={15} className={isLoading ? "animate-spin text-primary" : ""} />
        </button>
        <button
          onClick={() => navigateTo(defaultTarget)}
          title="Home"
          className="p-1.5 rounded hover:bg-white/10 text-zinc-300 transition-colors"
        >
          <Home size={15} />
        </button>

        {/* URL Bar */}
        <div className="flex-1 flex items-center bg-[#18181b] border border-white/10 hover:border-white/20 focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/30 rounded-lg px-2.5 py-1 gap-2 transition-all">
          {useProxy ? (
            <span
              title="Homelab Proxy active: Self-signed SSL accepted, X-Frame restrictions bypassed"
              className="flex items-center gap-1 text-[11px] font-medium text-amber-400/90 shrink-0 cursor-help"
            >
              <ShieldCheck size={14} className="text-amber-400" />
              <span className="hidden sm:inline">Homelab Proxy</span>
            </span>
          ) : currentUrl.startsWith("https://") ? (
            <span title="Direct HTTPS" className="shrink-0 flex items-center">
              <ShieldCheck size={14} className="text-emerald-400" />
            </span>
          ) : (
            <span title="Direct HTTP" className="shrink-0 flex items-center">
              <Globe size={14} className="text-zinc-500" />
            </span>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              navigateTo(inputUrl);
            }}
            className="flex-1 flex"
          >
            <input
              type="text"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              onFocus={(e) => e.target.select()}
              placeholder="Enter URL or host IP (e.g. 192.168.1.100:8006)..."
              className="w-full bg-transparent border-none outline-none text-xs font-mono text-zinc-100 placeholder-zinc-500"
              spellCheck={false}
            />
          </form>

          {/* Proxy Mode Toggle */}
          <button
            type="button"
            onClick={() => setUseProxy((v) => !v)}
            title={
              useProxy
                ? "Click to switch to Direct mode (bypasses local proxy)"
                : "Click to switch to Homelab Proxy (enables self-signed SSL override & X-Frame bypass)"
            }
            className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider transition-colors ${
              useProxy
                ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                : "bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-700"
            }`}
          >
            {useProxy ? "Proxy: ON" : "Direct"}
          </button>

          <button
            onClick={handleToggleBookmark}
            title={isBookmarked ? "Remove bookmark" : "Bookmark this URL"}
            className="p-1 rounded text-zinc-400 hover:text-amber-400 transition-colors"
          >
            <Star size={14} className={isBookmarked ? "fill-amber-400 text-amber-400" : ""} />
          </button>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleCopyUrl}
            title="Copy URL"
            className="p-1.5 rounded hover:bg-white/10 text-zinc-300 transition-colors"
          >
            {copied ? <Check size={15} className="text-emerald-400" /> : <Copy size={15} />}
          </button>
          <button
            onClick={() => openBrowserWindow(currentUrl, serverName || currentUrl)}
            title="Pop out into a dedicated SubTerm window"
            className="p-1.5 rounded hover:bg-white/10 text-zinc-300 transition-colors"
          >
            <ExternalLink size={15} />
          </button>
          <button
            onClick={() => openExternalUrl(currentUrl)}
            title="Open in system default browser"
            className="p-1.5 rounded hover:bg-white/10 text-zinc-300 transition-colors"
          >
            <Globe size={15} />
          </button>
        </div>
      </div>

      {/* Homelab Presets & Bookmarks Strip */}
      {showBookmarksBar && (
        <div className="flex items-center gap-1 px-3 py-1.5 bg-[#0e0e11] border-b border-white/5 overflow-x-auto text-xs shrink-0 scrollbar-none">
          <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider pr-1 flex items-center gap-1">
            <Wifi size={10} /> Presets:
          </span>

          {/* Dynamic presets using targetHost */}
          {[
            { label: "Proxmox :8006", url: `https://${targetHost}:8006/` },
            { label: "Portainer :9443", url: `https://${targetHost}:9443/` },
            { label: "TrueNAS", url: `https://${targetHost}/` },
            { label: "Grafana :3000", url: `http://${targetHost}:3000/` },
            { label: "Cockpit :9090", url: `https://${targetHost}:9090/` },
            { label: "Home Assistant :8123", url: `http://${targetHost}:8123/` },
          ].map((preset) => (
            <button
              key={preset.label}
              onClick={() => navigateTo(preset.url)}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white text-[11px] font-medium transition-colors whitespace-nowrap"
            >
              {getPresetIcon(preset.label)}
              {preset.label}
            </button>
          ))}

          {/* Custom Bookmarks */}
          {bookmarks.length > 0 && (
            <>
              <span className="h-3 w-px bg-white/10 mx-1 shrink-0" />
              {bookmarks.map((bm) => (
                <button
                  key={bm.id}
                  onClick={() => navigateTo(bm.url)}
                  title={bm.url}
                  className="flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 text-[11px] font-medium transition-colors whitespace-nowrap"
                >
                  <Star size={10} className="text-amber-400 fill-amber-400 shrink-0" />
                  {bm.title}
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {/* Frame Container */}
      <div className="flex-1 relative w-full h-full bg-black/40">
        <iframe
          ref={iframeRef}
          key={effectiveSrc}
          src={effectiveSrc}
          title={serverName || "Embedded Browser"}
          className="w-full h-full border-none"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads"
          onLoad={() => {
            setIsLoading(false);
            setFrameError(null);
          }}
          onError={() => {
            setIsLoading(false);
            setFrameError("Frame load error");
          }}
        />

        {/* Fallback & Helper Overlay if frame fails or user is in Direct mode on self-signed homelab host */}
        {frameError && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0c]/90 p-6 z-10 backdrop-blur-sm">
            <div className="max-w-md w-full bg-[#141418] border border-white/10 rounded-xl p-6 text-center shadow-2xl">
              <ShieldAlert size={36} className="text-amber-400 mx-auto mb-3" />
              <h3 className="text-base font-semibold text-white mb-2">Web Console Connection</h3>
              <p className="text-xs text-zinc-400 mb-4 leading-relaxed">
                Management consoles (Proxmox, TrueNAS, router gateways) frequently enforce frame-blocking
                (<code className="text-zinc-300">X-Frame-Options: DENY</code>) or self-signed TLS certificates.
              </p>
              <div className="flex flex-col gap-2">
                {!useProxy && (
                  <button
                    onClick={() => {
                      setUseProxy(true);
                      handleReload();
                    }}
                    className="w-full py-2 px-3 rounded-lg bg-primary hover:bg-primary/90 text-white text-xs font-medium transition-colors shadow"
                  >
                    Switch to Homelab Proxy (Bypass X-Frame & Self-Signed SSL)
                  </button>
                )}
                <button
                  onClick={() => openBrowserWindow(currentUrl, serverName || currentUrl)}
                  className="w-full py-2 px-3 rounded-lg bg-white/10 hover:bg-white/15 text-zinc-200 text-xs font-medium transition-colors"
                >
                  Open in Dedicated Window
                </button>
                <button
                  onClick={() => openExternalUrl(currentUrl)}
                  className="w-full py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium transition-colors"
                >
                  Open in System Browser
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
