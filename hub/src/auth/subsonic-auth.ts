import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyPassword } from "./passwords.js";
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
      // JWT invalid/expired — fall through to Subsonic param auth if u+p present
    }
  }

  // ── Fall back to Subsonic query-param auth (u+p) for third-party clients ──
  const username = query.u;
  let password = query.p;

  if (!username || !password) {
    // A JWT was presented but failed verification and there are no legacy
    // Subsonic params to fall back to. This is the SPA path (expired access
    // token); return HTTP 401 so the browser's silent-refresh logic kicks in.
    // Without this, the SPA sees a 200 + Subsonic envelope error 10 and has
    // no way to know it should refresh (issue #43).
    if (jwt) {
      reply.code(401).send({ error: "Authentication required" });
      return;
    }
    sendSubsonicError(reply, 10, "Required parameter missing", query);
    return;
  }

  // Decode enc:<HEX> prefix — Subsonic clients sometimes send hex-encoded passwords
  if (password.startsWith("enc:")) {
    const hex = password.slice(4);
    password = Buffer.from(hex, "hex").toString("utf8");
  }

  const user = db
    .prepare(
      "SELECT id, username, password_hash, is_admin FROM users WHERE username = ?",
    )
    .get(username) as
    | { id: string; username: string; password_hash: string; is_admin: number }
    | undefined;

  if (!user) {
    sendSubsonicError(reply, 40, "Wrong username or password", query);
    return;
  }

  const valid = await verifyPassword(user.password_hash, password);
  if (!valid) {
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

  const username = query.u;
  let password = query.p;

  if (!username || !password) {
    sendBinaryError(reply, 401, "Authentication required");
    return;
  }

  if (password.startsWith("enc:")) {
    const hex = password.slice(4);
    password = Buffer.from(hex, "hex").toString("utf8");
  }

  const user = db
    .prepare(
      "SELECT id, username, password_hash, is_admin FROM users WHERE username = ?",
    )
    .get(username) as
    | { id: string; username: string; password_hash: string; is_admin: number }
    | undefined;

  if (!user) {
    sendBinaryError(reply, 401, "Wrong username or password");
    return;
  }

  const valid = await verifyPassword(user.password_hash, password);
  if (!valid) {
    sendBinaryError(reply, 401, "Wrong username or password");
    return;
  }

  request.subsonicUser = {
    id: user.id,
    username: user.username,
    isAdmin: user.is_admin === 1,
  };
}
