import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived HMAC tokens that let an unauthenticated client (e.g. a Sonos
 * device on the LAN) fetch a stream from /cast/stream/:trackId without
 * Subsonic credentials.
 *
 * Token format: `<base64url(hmac)>.<exp>.<username>`
 *   - The signed message is `trackId|exp|username`, so a token issued for
 *     one track + user can't be replayed against another.
 *   - username is encoded (base64url) so it survives `.` separators and
 *     special chars without ambiguity.
 *   - exp is unix seconds.
 *
 * The username travels in the token because the device fetching the stream
 * is unauthenticated — we need to recover the originating user's identity
 * at verify time for stream-tracking attribution and federated `asUser`
 * routing.
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

function encodeUsername(u: string): string {
  return b64url(Buffer.from(u, "utf8"));
}

function decodeUsername(s: string): string | null {
  try {
    return fromB64url(s).toString("utf8");
  } catch {
    return null;
  }
}

function sign(secret: Buffer, message: string): Buffer {
  return createHmac("sha256", secret).update(message).digest();
}

export function signCastToken(
  secret: Buffer,
  payload: { trackId: string; username: string; ttlSec?: number },
): string {
  const exp = Math.floor(Date.now() / 1000) + (payload.ttlSec ?? DEFAULT_TTL_SEC);
  const message = `${payload.trackId}|${exp}|${payload.username}`;
  const sig = b64url(sign(secret, message));
  return `${sig}.${exp}.${encodeUsername(payload.username)}`;
}

/**
 * Verifies the token against the trackId + secret. Returns the originating
 * username on success, or null on signature mismatch / expiry / malformed
 * token.
 */
export function verifyCastToken(
  secret: Buffer,
  trackId: string,
  token: string,
): { username: string } | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [sigB64, expStr, userEnc] = parts;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return null;
  if (exp < Math.floor(Date.now() / 1000)) return null;

  const username = decodeUsername(userEnc);
  if (username === null) return null;

  const expected = sign(secret, `${trackId}|${exp}|${username}`);
  const provided = fromB64url(sigB64);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
  return { username };
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
