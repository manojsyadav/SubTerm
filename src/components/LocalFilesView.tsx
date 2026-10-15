import { useMemo } from "react";
import { ArrowLeft, HardDrive } from "lucide-react";
import FilePanel from "./FilePanel";
import { createLocalProvider } from "../fs/localProvider";

// This computer's files on the SFTP page, without opening a server first.
// Same FilePanel the session view uses, with only the local provider.

const DIR_KEY = "subterm-local-files-dir";

interface LocalFilesViewProps {
  onBack?: () => void;
  terminalId?: string;
  sessionId?: string;
}

export default function LocalFilesView({ onBack, terminalId, sessionId }: LocalFilesViewProps) {
  const provider = useMemo(() => createLocalProvider(), []);
  const initialPath = useMemo(() => {
    try { return localStorage.getItem(DIR_KEY) || undefined; } catch { return undefined; }
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="h-10 shrink-0 flex items-center gap-3 px-3 border-b border-white/5 bg-white/5">
        <button
          type="button"
          onClick={onBack}
          className="h-7 px-2 rounded-lg text-[11px] text-zinc-400 hover:text-white hover:bg-white/10 flex items-center gap-1.5"
        >
          <ArrowLeft size={13} /> Servers
        </button>
        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
          <HardDrive size={12} className="text-emerald-400" /> This computer
        </span>
      </header>
      <div className="flex-1 min-h-0">
        <FilePanel
          provider={provider}
          onDragMove={() => {}}
          initialPath={initialPath}
          onPathChange={(p) => { try { localStorage.setItem(DIR_KEY, p); } catch { /* quota — ignore */ } }}
          terminalId={terminalId}
          sessionId={sessionId}
        />
      </div>
    </div>
  );
}
