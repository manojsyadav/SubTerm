import type { Session } from "../hooks/useSessionManager";
import BrowserView from "./BrowserView";

interface Props {
  session: Session;
  onClose: () => void;
  onStatusChange?: (status: string) => void;
}

export default function BrowserSessionView({ session, onClose, onStatusChange }: Props) {
  const initialUrl = session.browserUrl || (session.serverHost ? `https://${session.serverHost}:8006` : "https://127.0.0.1:8006");

  return (
    <BrowserView
      initialUrl={initialUrl}
      serverHost={session.serverHost}
      serverName={session.serverName}
      onClose={onClose}
      onStatusChange={onStatusChange}
    />
  );
}
