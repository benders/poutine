// SSRF guard for federation peer URLs (issue #156).
//
// /federation/handshake fetches the invitee's `/api/health` URL before
// admitting them. An attacker holding a (possibly open) invitation can
// otherwise make us GET arbitrary internal hosts. We restrict outbound
// peer URLs to public http(s) endpoints by default; tests / local dev
// override via POUTINE_ALLOW_PRIVATE_PEER_URLS=1.

import { isIP } from "node:net";
import { promises as dns } from "node:dns";

export interface UrlSafetyOptions {
  allowPrivate?: boolean;
}

export interface UrlSafetyResult {
  ok: boolean;
  reason?: string;
}

function defaultAllowPrivate(): boolean {
  if (process.env.POUTINE_ALLOW_PRIVATE_PEER_URLS === "1") return true;
  return process.env.NODE_ENV !== "production";
}

export function parsePeerUrl(value: string): URL | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

// RFC1918 + loopback + link-local + CGNAT + reserved/multicast ranges.
function isPrivateIPv4(addr: string): boolean {
  const parts = addr.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;                          // loopback
  if (a === 169 && b === 254) return true;             // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;    // RFC1918
  if (a === 192 && b === 168) return true;             // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT
  if (a === 0) return true;                            // "this" network
  if (a >= 224) return true;                           // multicast / reserved
  return false;
}

function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:")) return true;          // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("ff")) return true;             // multicast
  // IPv4-mapped (::ffff:a.b.c.d)
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice(7);
    if (isIP(v4) === 4) return isPrivateIPv4(v4);
  }
  return false;
}

function isPrivateAddress(addr: string): boolean {
  const fam = isIP(addr);
  if (fam === 4) return isPrivateIPv4(addr);
  if (fam === 6) return isPrivateIPv6(addr);
  return true; // unknown — refuse by default
}

/**
 * Validate that `value` is a peer-safe URL: http/https scheme, and (unless
 * `allowPrivate`) does not resolve to a private/loopback/reserved address.
 */
export async function checkPeerUrlSafe(
  value: string,
  opts?: UrlSafetyOptions,
): Promise<UrlSafetyResult> {
  const u = parsePeerUrl(value);
  if (!u) return { ok: false, reason: "URL must be http(s)" };

  const allowPrivate = opts?.allowPrivate ?? defaultAllowPrivate();
  if (allowPrivate) return { ok: true };

  const host = u.hostname;
  // Literal IPs: classify directly.
  if (isIP(host) !== 0) {
    return isPrivateAddress(host)
      ? { ok: false, reason: "URL resolves to a non-public address" }
      : { ok: true };
  }

  // Hostname: resolve and reject if any address is private. Note this still
  // permits a (small) DNS-rebind window between this check and the actual
  // fetch; a fully hardened implementation would resolve once and connect
  // to the resolved IP. Out of scope here.
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: "URL hostname did not resolve" };
  }
  if (addrs.length === 0) {
    return { ok: false, reason: "URL hostname did not resolve" };
  }
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      return { ok: false, reason: "URL resolves to a non-public address" };
    }
  }
  return { ok: true };
}
