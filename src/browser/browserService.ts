import { invoke } from "@tauri-apps/api/core";

export interface ProxyInfo {
  port: number;
  token: string;
  running: boolean;
}

export interface Bookmark {
  id: string;
  title: string;
  url: string;
  icon?: string;
}

export const DEFAULT_BOOKMARKS: Bookmark[] = [
  { id: "proxmox", title: "Proxmox VE", url: "https://127.0.0.1:8006", icon: "server" },
  { id: "portainer", title: "Portainer", url: "https://127.0.0.1:9443", icon: "box" },
  { id: "truenas", title: "TrueNAS", url: "https://127.0.0.1", icon: "hard-drive" },
  { id: "grafana", title: "Grafana", url: "http://127.0.0.1:3000", icon: "activity" },
  { id: "cockpit", title: "Cockpit", url: "https://127.0.0.1:9090", icon: "gauge" },
  { id: "homeassistant", title: "Home Assistant", url: "http://127.0.0.1:8123", icon: "home" },
  { id: "pihole", title: "Pi-hole", url: "http://127.0.0.1/admin/", icon: "shield" },
];

const BOOKMARKS_STORAGE_KEY = "subterm-browser-bookmarks";

export function loadBookmarks(): Bookmark[] {
  try {
    const raw = localStorage.getItem(BOOKMARKS_STORAGE_KEY);
    if (!raw) return DEFAULT_BOOKMARKS;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_BOOKMARKS;
  } catch {
    return DEFAULT_BOOKMARKS;
  }
}

export function saveBookmarks(bookmarks: Bookmark[]): void {
  try {
    localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(bookmarks));
  } catch {
    // ignore quota errors
  }
}

export async function startBrowserProxy(port?: number): Promise<ProxyInfo> {
  return await invoke<ProxyInfo>("browser_proxy_start", { port });
}

export async function stopBrowserProxy(): Promise<void> {
  return await invoke("browser_proxy_stop");
}

export async function getBrowserProxyStatus(): Promise<ProxyInfo> {
  return await invoke<ProxyInfo>("browser_proxy_status");
}

export async function openBrowserWindow(url: string, title?: string): Promise<void> {
  return await invoke("open_browser_window", { url, title });
}

export async function openExternalUrl(url: string): Promise<void> {
  return await invoke("open_external_url", { url });
}

export function buildProxiedUrl(proxy: ProxyInfo, targetUrl: string): string {
  if (!proxy.running || !proxy.port || !proxy.token) return targetUrl;
  const encoded = encodeURIComponent(targetUrl);
  return `http://127.0.0.1:${proxy.port}/proxy?token=${proxy.token}&url=${encoded}`;
}

/** Format or normalize user-entered URL. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "about:blank";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("about:")) {
    return trimmed;
  }
  // Default to http:// for bare IP or localhost, https:// otherwise
  if (/^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}
