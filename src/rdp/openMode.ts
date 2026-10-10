/** Where saved RDP servers open: the system's Remote Desktop client, or inside SubTerm. */
export type RdpOpenMode = "system" | "embedded";

const KEY = "subterm-rdp-open-mode";

export function getRdpOpenMode(): RdpOpenMode {
  try {
    return localStorage.getItem(KEY) === "embedded" ? "embedded" : "system";
  } catch {
    return "system";
  }
}

export function setRdpOpenMode(mode: RdpOpenMode): void {
  try { localStorage.setItem(KEY, mode); } catch { /* storage unavailable: stays on the default */ }
}
