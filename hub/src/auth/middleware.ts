import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyToken } from "./jwt.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
    /**
     * #220: username of the authenticated user, populated alongside
     * `userId`. Lets Player code (sonos cast token mint) avoid a second
     * DB lookup or `users` JOIN.
     */
    username: string;
    isAdmin: boolean;
  }
}

export interface SessionUser {
  id: string;
  username: string;
  isAdmin: boolean;
  tokenVersion: number;
}

export type SessionLookup = { user: SessionUser } | { code: 401; error: string };

/**
 * Resolve the session user from the request's **access** token — the single
 * verification path behind `requireAuth` and `requireOwner` (#315).
 *
 * Token sources, in order: `Authorization: Bearer`, then the `access_token`
 * cookie. There is deliberately no query-string source: a JWT in a URL ends up
 * in access logs, browser history and Referer headers.
 *
 * The `users` row is re-read on every request, so a deletion, a demotion, or a
 * `token_version` bump (password change, logout) takes effect immediately.
 */
export async function authenticateSession(
  request: FastifyRequest,
): Promise<SessionLookup> {
  const { config, db } = request.server;

  let token: string | undefined;
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) token = authHeader.slice(7);
  if (!token && request.cookies?.access_token) token = request.cookies.access_token;

  if (!token) return { code: 401, error: "Authentication required" };

  let verified;
  try {
    verified = await verifyToken(token, config);
  } catch {
    return { code: 401, error: "Invalid or expired token" };
  }

  const row = db
    .prepare("SELECT id, username, is_admin, token_version FROM users WHERE id = ?")
    .get(verified.userId) as
    | { id: string; username: string; is_admin: number; token_version: number }
    | undefined;

  if (!row) return { code: 401, error: "User not found" };
  if (row.token_version !== verified.tokenVersion) {
    return { code: 401, error: "Invalid or expired token" };
  }

  return {
    user: {
      id: row.id,
      username: row.username,
      isAdmin: row.is_admin === 1,
      tokenVersion: row.token_version,
    },
  };
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const session = await authenticateSession(request);
  if (!("user" in session)) {
    reply.code(session.code).send({ error: session.error });
    return;
  }
  request.userId = session.user.id;
  request.username = session.user.username;
  request.isAdmin = session.user.isAdmin;
}
