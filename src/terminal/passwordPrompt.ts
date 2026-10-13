// Does the recent remote OUTPUT look like a no-echo password / passphrase
// prompt? Used to skip command-history capture so typed secrets (sudo, su,
// mysql -p, ssh/gpg passphrase) aren't persisted into searchable history. At a
// no-echo prompt the output still ENDS with the prompt text because the user's
// keystrokes were never echoed back. We strip ANSI colour/OSC sequences first
// and only match when the prompt is the trailing content.
export const promptTail = (out: string): string =>
  out
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC …BEL/ST
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")          // CSI …final
    .replace(/[\r\n]+/g, "\n")
    .slice(-160);
export const looksLikePasswordPrompt = (out: string): boolean =>
  /(?:password|passphrase)\b[^:\n]*:\s*$/i.test(promptTail(out));
// Only sudo's own prompt gets the saved-password offer: other prompts (su, mysql -p) want a different secret.
export const looksLikeSudoPrompt = (out: string): boolean =>
  /\[sudo\] password for [^:\n]+:\s*$/i.test(promptTail(out));
// Output that came back after typing a probe character (and erasing it) at a
// prompt. A no-echo prompt sends nothing, or only sudo's `pwfeedback` stars
// and their erase; anything else means the input is visible on screen.
export const probeWasEchoed = (out: string): boolean =>
  /[^*\b \x7f]/.test(promptTail(out).replace(/\n/g, ""));
