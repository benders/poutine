import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived HMAC tokens that let an unauthenticated client (e.g. a Sonos
 * device on the LAN) fetch a stream from /cast/stream/:trackId without
 * Subsonic credentials.
 *
 * Token format: `<base64url(hmac)>.<exp>` where exp is unix seconds. The
 * signed message is `trackId|exp`, so a token issued for one track can't
 * be replayed against another.
 *
 * Audit: cast streams are recorded by stream-tracking with username="cast".
 * If per-user attribution is needed later, extend the token to carry the
 * userId and update verify to recover and return it (sign and verify must
 * agree on the exact wire format).
 */

const DEFAULT_TTL_SEC = 60 * 60; // 1h — covers a long track plus buffering

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(secret: Buffer, message: string): Buffer {
  return createHmac("sha256", secret).update(message).digest();
}

export function signCastToken(
  secret: Buffer,
  payload: { trackId: string; ttlSec?: number },
): string {
  const exp = Math.floor(Date.now() / 1000) + (payload.ttlSec ?? DEFAULT_TTL_SEC);
  const message = `${payload.trackId}|${exp}`;
  return `${b64url(sign(secret, message))}.${exp}`;
}

/**
 * Verifies the token against the trackId + secret. Returns true on success,
 * or false on signature mismatch / expiry / malformed token.
 */
export function verifyCastToken(
  secret: Buffer,
  trackId: string,
  token: string,
): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  const sigB64 = token.slice(0, dot);
  const exp = parseInt(token.slice(dot + 1), 10);
  if (!Number.isFinite(exp)) return false;
  if (exp < Math.floor(Date.now() / 1000)) return false;

  const expected = sign(secret, `${trackId}|${exp}`);
  const provided = fromB64url(sigB64);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Derive a stable HMAC secret from the instance's Ed25519 private key.
 * Avoids introducing another env var while keeping the cast-token secret
 * independent of the federation signing key path.
 *
 * Note: compromise of the federation private key also compromises cast
 * tokens (and vice versa).
 */
export function deriveCastSecret(privateKeyDer: Buffer): Buffer {
  return createHmac("sha256", privateKeyDer).update("poutine/cast-token/v1").digest();
}
