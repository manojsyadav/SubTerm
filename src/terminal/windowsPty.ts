import type { IWindowsPty } from "xterm";

/**
 * xterm settings for a local tab on Windows, which runs under ConPTY. ConPTY repaints the screen
 * itself on resize; without these xterm also reflows, and the two leave text doubled or shifted
 * (seen after splitting a tab). `platformVersion` is from navigator.userAgentData: 13 and up is
 * Windows 11, whose builds are all past 21376, the first where xterm can keep reflow on.
 */
export function windowsPtyFor(platformVersion?: string): IWindowsPty {
  return parseInt(platformVersion ?? "", 10) >= 13 ? { backend: "conpty", buildNumber: 22000 } : { backend: "conpty" };
}
