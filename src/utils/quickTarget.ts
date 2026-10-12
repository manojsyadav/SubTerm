/**
 * Reads what was typed in the Servers search box as a connection target:
 * `10.0.0.5`, `root@10.0.0.5`, `host.example.com:2222`, `user@host.example.com`.
 *
 * A bare word such as `web` is NOT a target, because it is far more likely a search for a saved
 * server called "web". A target needs an IP literal, a dotted host name, `localhost`, or an
 * explicit `user@`.
 */
export interface QuickTarget {
  host: string;
  port: number;
  /** Empty when the text had no `user@`; the caller supplies its default. */
  username: string;
}

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const USER = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;

export function parseQuickTarget(text: string): QuickTarget | null {
  const raw = text.trim();
  if (!raw || /\s/.test(raw)) return null;

  let username = "";
  let rest = raw;
  const at = raw.lastIndexOf("@");
  if (at >= 0) {
    username = raw.slice(0, at);
    rest = raw.slice(at + 1);
    if (!USER.test(username)) return null;
  }

  let host = rest;
  let port = 22;
  const bracket = /^\[([0-9a-fA-F:]+)\](?::(\d{1,5}))?$/.exec(rest); // [::1] or [::1]:2222
  if (bracket) {
    host = bracket[1];
    if (bracket[2]) port = Number(bracket[2]);
  } else if ((rest.match(/:/g) ?? []).length === 1) {
    const [h, p] = rest.split(":");
    host = h;
    if (!/^\d{1,5}$/.test(p)) return null;
    port = Number(p);
  } else if ((rest.match(/:/g) ?? []).length > 1) {
    if (!/^[0-9a-fA-F:]+$/.test(rest) || !/::|^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/.test(rest)) return null;
    host = rest; // bare IPv6
  }
  if (port < 1 || port > 65535) return null;

  const isIpv4 = IPV4.test(host) && host.split(".").every((o) => Number(o) <= 255);
  const isIpv6 = host.includes(":");
  const isName = HOSTNAME.test(host) && (host.includes(".") || host.toLowerCase() === "localhost");
  // `user@word` is an explicit request to connect, so a single-label host is accepted then.
  const isBareHostWithUser = username !== "" && HOSTNAME.test(host);
  if (!(isIpv4 || isIpv6 || isName || isBareHostWithUser)) return null;
  // Digits and dots that are not a valid IPv4 address (10.0.0, 10.0.0.999) are a typo, not a host name.
  if (/^[\d.]+$/.test(host) && !isIpv4) return null;
  return { host, port, username };
}
