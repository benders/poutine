import crypto from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyPassword, getStoredPassword } from "./passwords.js";
import { verifyToken } from "./jwt.js";
import { sendSubsonicError, sendBinaryError } from "../routes/subsonic-response.js";

declare module "fastify" {
  interface FastifyRequest {
    subsonicUser: { id: string; username: string; isAdmin: boolean };
  }
}

/**
 * Extract a JWT from the request (Authorization header → cookie → `token` query param).
 * Returns the raw token string or undefined.
 */
function extractJwt(request: FastifyRequest): string | undefined {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

  if (request.cookies?.access_token) return request.cookies.access_token;

  const query = request.query as Record<string, string>;
  if (query?.token) return query.token;

  return undefined;
}

interface SubsonicCreds {
  hasAny: boolean;     // u present plus any of (p | t+s)
  username?: string;
  password?: string;   // decoded plaintext password (if u+p path)
  token?: string;      // md5 hex (if u+t+s path)
  salt?: string;       // salt (if u+t+s path)
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

/**
 * Verify u+p (plaintext or enc:<hex>) or u+t+s (MD5 token+salt).
 * Returns true on success. Both forms are supported per Subsonic spec.
 */
function verifySubsonicCreds(
  creds: SubsonicCreds,
  passwordEnc: string,
  passwordKey: Buffer,
): boolean {
  if (creds.password !== undefined) {
    return verifyPassword(passwordEnc, creds.password, passwordKey);
  }
  if (creds.token && creds.salt) {
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

export async function requireSubsonicAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const app = request.server;
  const db = app.db;
  const query = request.query as Record<string, string>;

  // ── Try JWT auth first (cookie / Authorization header / token query param) ──
  const jwt = extractJwt(request);
  if (jwt) {
    try {
      const { userId } = await verifyToken(jwt, app.config);
      const user = db
        .prepare("SELECT id, username, is_admin FROM users WHERE id = ?")
        .get(userId) as
        | { id: string; username: string; is_admin: number }
        | undefined;

      if (user) {
        request.subsonicUser = {
          id: user.id,
          username: user.username,
          isAdmin: user.is_admin === 1,
        };
        return;
      }
    } catch {
      // JWT invalid/expired — fall through to Subsonic param auth if creds present
    }
  }

  // ── Subsonic query-param auth: u+p or u+t+s ──────────────────────────────────
  const creds = readSubsonicCreds(query);
  if (!creds.hasAny) {
    // A JWT was presented but failed verification and there are no Subsonic
    // params to fall back to. SPA path (expired access token) — return HTTP 401
    // so the browser's silent-refresh logic kicks in (issue #43).
    if (jwt) {
      reply.code(401).send({ error: "Authentication required" });
      return;
    }
    sendSubsonicError(reply, 10, "Required parameter missing", query);
    return;
  }

  const user = db
    .prepare(
      "SELECT id, username, password_enc, is_admin FROM users WHERE username = ?",
    )
    .get(creds.username!) as
    | { id: string; username: string; password_enc: string; is_admin: number }
    | undefined;

  if (!user || !verifySubsonicCreds(creds, user?.password_enc ?? "", app.passwordKey)) {
    sendSubsonicError(reply, 40, "Wrong username or password", query);
    return;
  }

  request.subsonicUser = {
    id: user.id,
    username: user.username,
    isAdmin: user.is_admin === 1,
  };
}

/**
 * Same as requireSubsonicAuth but uses HTTP error status codes instead of
 * Subsonic envelopes. Use this for binary endpoints (getCoverArt, stream)
 * where a 200+JSON body would be interpreted as corrupt image/audio data.
 */
export async function requireSubsonicAuthBinary(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const app = request.server;
  const db = app.db;
  const query = request.query as Record<string, string>;

  const jwt = extractJwt(request);
  if (jwt) {
    try {
      const { userId } = await verifyToken(jwt, app.config);
      const user = db
        .prepare("SELECT id, username, is_admin FROM users WHERE id = ?")
        .get(userId) as
        | { id: string; username: string; is_admin: number }
        | undefined;

      if (user) {
        request.subsonicUser = {
          id: user.id,
          username: user.username,
          isAdmin: user.is_admin === 1,
        };
        return;
      }
    } catch {
      // fall through to param auth
    }
  }

  const creds = readSubsonicCreds(query);
  if (!creds.hasAny) {
    sendBinaryError(reply, 401, "Authentication required");
    return;
  }

  const user = db
    .prepare(
      "SELECT id, username, password_enc, is_admin FROM users WHERE username = ?",
    )
    .get(creds.username!) as
    | { id: string; username: string; password_enc: string; is_admin: number }
    | undefined;

  if (!user || !verifySubsonicCreds(creds, user?.password_enc ?? "", app.passwordKey)) {
    sendBinaryError(reply, 401, "Wrong username or password");
    return;
  }

  request.subsonicUser = {
    id: user.id,
    username: user.username,
    isAdmin: user.is_admin === 1,
  };
}
