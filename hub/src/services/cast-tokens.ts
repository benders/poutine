import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Cast-token HMAC secret is attached to the Fastify app at boot (server.ts)
 * and consumed by `signCastToken` / `verifyCastToken`. Declared here so the
 * augmentation lives next to its consumers — sign on the Sonos route, verify
 * on the Subsonic stream auth path.
 */
declare module "fastify" {
  interface FastifyInstance {
    castSecret: Buffer;
  }
}

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
 * Build a self-contained Subsonic stream URL with an embedded cast token
 * for handoff to non-Subsonic clients (Sonos devices, DLNA renderers).
 *
 * Replaces the deleted `/cast/stream/:trackId` and `/dlna/stream/:trackId`
 * relays (#218): once the URL is in the device's hands the bytes flow
 * directly from `/rest/stream.view` reusing the same source-selection +
 * transcoding pipeline the SPA uses.
 *
 * The `id` query param is the Subsonic-encoded track id (`t<uuid>`); the
 * cast token verifier compares the bound trackId against the *decoded*
 * unified id, so the prefix is transparent.
 */
export interface BuildStreamUrlOptions {
  /** Hub base URL reachable by the device on the LAN (admin setting). */
  lanUrl: string;
  /** HMAC secret (FastifyInstance.castSecret). */
  castSecret: Buffer;
  /** Unified track id (NOT the `t`-prefixed Subsonic id). */
  unifiedTrackId: string;
  /** Originating user — attribution + federated `asUser` routing. */
  username: string;
  /** Transcode target, e.g. `"mp3"`. Omit for raw pass-through. */
  format?: string;
  /** Subsonic `timeOffset` — only honored when transcoding. */
  timeOffsetSec?: number;
  /** Override token TTL. Defaults to 1h (cast-token DEFAULT_TTL_SEC). */
  ttlSec?: number;
  /**
   * Subsonic protocol params clients normally send. Defaults baked in for
   * a Poutine-issued URL — device fetches care about `c` for activity
   * attribution.
   */
  client?: string;
  protocolVersion?: string;
  /**
   * When set, the stream handler also emits DLNA-specific response headers
   * (`transferMode.dlna.org`, `contentFeatures.dlna.org`, default
   * `accept-ranges: bytes`). Drives the `dlna=1` flag on the URL.
   */
  dlna?: boolean;
}

export function buildStreamUrl(opts: BuildStreamUrlOptions): string {
  const token = signCastToken(opts.castSecret, {
    trackId: opts.unifiedTrackId,
    username: opts.username,
    ttlSec: opts.ttlSec,
  });
  const params = new URLSearchParams();
  // Subsonic id encoding: track id is prefixed with `t`. The verifier
  // strips it server-side, but the stream handler requires the prefix.
  params.set("id", `t${opts.unifiedTrackId}`);
  params.set("castToken", token);
  // Required Subsonic params — handler reads `c`/`v` for stream-tracking.
  params.set("u", opts.username);
  params.set("v", opts.protocolVersion ?? "1.16.1");
  params.set("c", opts.client ?? "poutine-cast");
  if (opts.format) params.set("format", opts.format);
  if (typeof opts.timeOffsetSec === "number" && opts.timeOffsetSec > 0) {
    params.set("timeOffset", String(Math.floor(opts.timeOffsetSec)));
  }
  if (opts.dlna) params.set("dlna", "1");
  const base = opts.lanUrl.replace(/\/+$/, "");
  return `${base}/rest/stream.view?${params.toString()}`;
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
