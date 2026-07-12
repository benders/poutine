import crypto from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyPassword, getStoredPassword } from "./passwords.js";
import { sendSubsonicError, sendBinaryError, decodeId } from "../routes/subsonic-response.js";
import { verifyCastToken } from "../services/cast-tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    subsonicUser: { id: string; username: string; isAdmin: boolean };
  }
}

interface SubsonicCreds {
  hasAny: boolean;
  username?: string;
  password?: string;   // decoded plaintext (u+p path)
  token?: string;      // md5 hex (u+t+s path)
  salt?: string;
}

function readSubsonicCreds(query: Record<string, string>): SubsonicCreds {
  const username = query.u;
  if (!username) return { hasAny: false };

  if (query.t && query.s) {
    return {
      hasAny: true,
      username,
      token: query.t.toLowerCase(),
      salt: query.s,
    };
  }

  if (query.p) {
    let password = query.p;
    if (password.startsWith("enc:")) {
      password = Buffer.from(password.slice(4), "hex").toString("utf8");
    }
    return { hasAny: true, username, password };
  }

  return { hasAny: false, username };
}

function verifySubsonicCreds(
  creds: SubsonicCreds,
  passwordEnc: string,
  passwordKey: Buffer,
): boolean {
  if (creds.password !== undefined) {
    return verifyPassword(passwordEnc, creds.password, passwordKey);
  }
  if (creds.token && creds.salt) {
    // Subsonic spec requires salt ≥ 6 chars; reject short salts as
    // defense-in-depth (real clients use ≥36 random chars).
    if (creds.salt.length < 6) return false;
    const stored = getStoredPassword(passwordEnc, passwordKey);
    if (stored === null) return false;
    const expected = crypto
      .createHash("md5")
      .update(stored + creds.salt)
      .digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(creds.token, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
  return false;
}

/**
 * Trusted in-process auth (#224). When `HubSubsonicCaller` is invoked with
 * `asUser`, it injects requests carrying these headers; the middleware
 * resolves the user without password verification. The shared secret is the
 * per-boot value on `app.internalAuthSecret` — it never crosses the wire,
 * so a constant-time compare is sufficient.
 *
 * Returns null when the header is absent (caller falls through to normal
 * u+p / u+t+s auth) or when verification fails outright. The discriminated
 * "fail" return lets the caller emit the proper Subsonic / binary error
 * without rebuilding the check.
 */
const INTERNAL_AUTH_HEADER = "x-poutine-internal";
const INTERNAL_AS_USER_HEADER = "x-poutine-as-user";

function tryInternalAuth(
  request: FastifyRequest,
):
  | { kind: "absent" }
  | { kind: "fail" }
  | { kind: "ok"; user: { id: string; username: string; isAdmin: boolean } } {
  const headers = request.headers;
  const secret = headers[INTERNAL_AUTH_HEADER];
  const asUser = headers[INTERNAL_AS_USER_HEADER];
  if (!secret && !asUser) return { kind: "absent" };
  if (typeof secret !== "string" || typeof asUser !== "string") {
    return { kind: "fail" };
  }
  const expected = request.server.internalAuthSecret;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { kind: "fail" };
  }
  const user = request.server.db
    .prepare(
      "SELECT id, username, is_admin FROM users WHERE username = ?",
    )
    .get(asUser) as
    | { id: string; username: string; is_admin: number }
    | undefined;
  if (!user) return { kind: "fail" };
  return {
    kind: "ok",
    user: { id: user.id, username: user.username, isAdmin: user.is_admin === 1 },
  };
}

function lookupAndVerify(
  request: FastifyRequest,
  creds: SubsonicCreds,
):
  | { id: string; username: string; isAdmin: boolean }
  | null {
  const app = request.server;
  const user = app.db
    .prepare(
      "SELECT id, username, password_enc, is_admin FROM users WHERE username = ?",
    )
    .get(creds.username!) as
    | { id: string; username: string; password_enc: string; is_admin: number }
    | undefined;

  if (!user || !verifySubsonicCreds(creds, user?.password_enc ?? "", app.passwordKey)) {
    return null;
  }
  return { id: user.id, username: user.username, isAdmin: user.is_admin === 1 };
}

export async function requireSubsonicAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const query = request.query as Record<string, string>;

  const internal = tryInternalAuth(request);
  if (internal.kind === "ok") {
    request.subsonicUser = internal.user;
    return;
  }
  if (internal.kind === "fail") {
    sendSubsonicError(reply, 40, "Wrong username or password", query);
    return;
  }

  const creds = readSubsonicCreds(query);

  if (!creds.hasAny) {
    sendSubsonicError(reply, 10, "Required parameter missing", query);
    return;
  }

  const auth = lookupAndVerify(request, creds);
  if (!auth) {
    sendSubsonicError(reply, 40, "Wrong username or password", query);
    return;
  }
  request.subsonicUser = auth;
}

/**
 * Same as requireSubsonicAuth but uses HTTP error status codes instead of
 * Subsonic envelopes. Use this for binary endpoints (getCoverArt, stream)
 * where a 200+JSON body would be interpreted as corrupt image/audio data.
 *
 * Cast-token auth (`castToken=<token>`, #218): an alternate path used by
 * non-Subsonic clients on the LAN (Sonos devices, DLNA renderers). Player
 * mints a token bound to a specific trackId + originating username; the
 * token authenticates a single `id` on `/rest/stream(.view)` for the bound
 * user. The token is NOT accepted on getCoverArt — art is shared from the
 * DIDL/SOAP plane and does not need a per-track gate.
 */
export async function requireSubsonicAuthBinary(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const query = request.query as Record<string, string>;

  // Cast-token path: only valid on stream endpoints (id required, token
  // signs over the resolved unified track id). Skip lookups in `users` —
  // the cast token already authenticated the originating user when it was
  // minted by /api/sonos/devices/:id/play.
  const castToken = query.castToken;
  if (castToken) {
    const url = request.url || "";
    const path = url.split("?")[0] || "";
    if (!/\/stream(\.view)?$/.test(path)) {
      sendBinaryError(reply, 401, "Cast token not accepted on this endpoint");
      return;
    }
    let unifiedId: string;
    try {
      unifiedId = decodeId(query.id ?? "", "t");
    } catch {
      sendBinaryError(reply, 400, "Invalid track ID");
      return;
    }
    const verified = verifyCastToken(request.server.castSecret, unifiedId, castToken);
    if (!verified) {
      sendBinaryError(reply, 401, "Invalid or expired cast token");
      return;
    }
    // Resolve the carried username to a real user row so downstream
    // attribution (stream-tracking, federated asUser) has a stable id.
    const user = request.server.db
      .prepare(
        "SELECT id, username, is_admin FROM users WHERE username = ?",
      )
      .get(verified.username) as
      | { id: string; username: string; is_admin: number }
      | undefined;
    if (!user) {
      sendBinaryError(reply, 401, "Cast token user not found");
      return;
    }
    request.subsonicUser = {
      id: user.id,
      username: user.username,
      isAdmin: user.is_admin === 1,
    };
    return;
  }

  const internal = tryInternalAuth(request);
  if (internal.kind === "ok") {
    request.subsonicUser = internal.user;
    return;
  }
  if (internal.kind === "fail") {
    sendBinaryError(reply, 401, "Wrong username or password");
    return;
  }

  const creds = readSubsonicCreds(query);

  if (!creds.hasAny) {
    sendBinaryError(reply, 401, "Authentication required");
    return;
  }

  const auth = lookupAndVerify(request, creds);
  if (!auth) {
    sendBinaryError(reply, 401, "Wrong username or password");
    return;
  }
  request.subsonicUser = auth;
}
