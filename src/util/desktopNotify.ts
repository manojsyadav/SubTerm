/**
 * System notifications for events you may miss while SubTerm is in the background
 * (Settings > Terminal > Notifications). They only fire when the window is not focused, and
 * they are best effort: if the webview has no Notification support or permission is denied,
 * nothing is shown and the Activity Log still records the event.
 */
export function shouldNotifyLongCommand(elapsedMs: number, thresholdSec: number): boolean {
  return thresholdSec > 0 && elapsedMs >= thresholdSec * 1000;
}

export async function notifyDesktop(title: string, body: string): Promise<boolean> {
  try {
    if (typeof Notification === "undefined" || document.hasFocus()) return false;
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    if (permission !== "granted") return false;
    new Notification(title, { body, silent: false });
    return true;
  } catch {
    return false;
  }
}
