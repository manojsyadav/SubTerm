import { useState } from "react";
import { getRdpOpenMode, setRdpOpenMode, type RdpOpenMode } from "../rdp/openMode";
import { useFeatureFlag } from "../featureFlags";

const OPTIONS: { id: RdpOpenMode; label: string; desc: string }[] = [
  {
    id: "system",
    label: "System Remote Desktop client",
    desc: "Opens Windows Remote Desktop (mstsc), Microsoft Remote Desktop or FreeRDP. Full-featured and the safe default.",
  },
  {
    id: "embedded",
    label: "Inside SubTerm (beta)",
    desc: "Shows the remote screen in a SubTerm window with keyboard and mouse. Asks for the password each time. No clipboard, audio or file sharing yet.",
  },
];

export function SettingsRdpMode() {
  const enabled = useFeatureFlag("rdpServers");
  const [mode, setMode] = useState<RdpOpenMode>(getRdpOpenMode);
  const pick = (m: RdpOpenMode) => { setMode(m); setRdpOpenMode(m); };

  return (
    <div className="space-y-2" role="radiogroup" aria-label="Open RDP servers in">
      {!enabled && <p className="text-[11px] text-amber-400/80">RDP servers are switched off under Feature Toggles.</p>}
      {OPTIONS.map((o) => (
        <label key={o.id} className="flex items-start gap-2.5 p-2.5 bg-black/40 border border-white/5 rounded-lg cursor-pointer hover:border-white/10">
          <input type="radio" name="rdp-open-mode" checked={mode === o.id} onChange={() => pick(o.id)} className="mt-0.5 accent-primary" />
          <span className="min-w-0">
            <span className="block text-xs text-zinc-200">{o.label}</span>
            <span className="block text-[11px] text-zinc-500">{o.desc}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
