import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived HMAC tokens that let an unauthenticated client (e.g. a Sonos
 * device on the LAN) fetch a stream from /cast/stream/:trackId without
 * Subsonic credentials.
 *
 * Token format: `<base64url(hmac)>.<exp>` where exp is unix seconds. The
 * signed message is `trackId|userId|exp`, so a token issued for one track
 * can't be replayed against another.
 */

export interface CastTokenPayload {
  trackId: string;
  userId: string;
  /** Unix seconds when the token expires. */
  exp: number;
}

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
  payload: { trackId: string; userId: string; ttlSec?: number },
): string {
  const exp = Math.floor(Date.now() / 1000) + (payload.ttlSec ?? DEFAULT_TTL_SEC);
  const message = `${payload.trackId}|${payload.userId}|${exp}`;
  return `${b64url(sign(secret, message))}.${exp}`;
}

/**
 * Verifies the token against the trackId + secret. Returns the userId on
 * success, or null on signature mismatch / expiry / malformed token.
 */
export function verifyCastToken(
  secret: Buffer,
  trackId: string,
  token: string,
): { userId: string } | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const sigB64 = token.slice(0, dot);
  const exp = parseInt(token.slice(dot + 1), 10);
  if (!Number.isFinite(exp)) return null;
  if (exp < Math.floor(Date.now() / 1000)) return null;

  // We don't transmit the userId in the token — the caller of signCastToken
  // is expected to record (token -> userId) elsewhere. For Phase 1 we keep
  // it simple: bind to a sentinel "cast" identity. Callers that want
  // per-user audit can swap this for a stored map.
  const userId = "cast";
  const expected = sign(secret, `${trackId}|${userId}|${exp}`);
  const provided = fromB64url(sigB64);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
  return { userId };
}

/**
 * Derive a stable HMAC secret from the instance's Ed25519 private key.
 * Avoids introducing another env var while keeping the cast-token secret
 * independent of the federation signing key path.
 */
export function deriveCastSecret(privateKeyDer: Buffer): Buffer {
  return createHmac("sha256", privateKeyDer).update("poutine/cast-token/v1").digest();
}
