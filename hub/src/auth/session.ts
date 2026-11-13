import type { FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import { createAccessToken, createRefreshToken } from "./jwt.js";

/**
 * Session cookie issuance and revocation (#315). Every place that signs a user
 * in — login, refresh, invite redemption — goes through `issueSession`, so the
 * cookie attributes cannot drift between them.
 */

const ACCESS_COOKIE = "access_token";
const REFRESH_COOKIE = "refresh_token";
/** The refresh cookie is only ever sent to the refresh endpoint. */
const REFRESH_PATH = "/admin/refresh";

/**
 * Did this request reach the edge over HTTPS? Decides the cookie `Secure`
 * flag. `X-Forwarded-Proto` is read even when `TRUST_PROXY` is unset: the
 * worst a spoofed value can do is mark the caller's own cookies `Secure`.
 */
export function isSecureRequest(request: FastifyRequest): boolean {
  if (request.protocol === "https") return true;
  const forwarded = request.headers["x-forwarded-proto"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  return first === "https";
}

/** Mint an access + refresh pair, set both cookies, return the access token. */
export async function issueSession(
  request: FastifyRequest,
  reply: FastifyReply,
  user: { id: string; tokenVersion: number },
): Promise<string> {
  const { config } = request.server;
  const accessToken = await createAccessToken(user.id, config, user.tokenVersion);
  const refreshToken = await createRefreshToken(user.id, config, user.tokenVersion);
  const base = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecureRequest(request),
  };
  reply.setCookie(ACCESS_COOKIE, accessToken, { ...base, path: "/", maxAge: 15 * 60 });
  reply.setCookie(REFRESH_COOKIE, refreshToken, {
    ...base,
    path: REFRESH_PATH,
    maxAge: 7 * 24 * 60 * 60,
  });
  return accessToken;
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH });
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(ACCESS_COOKIE, { path: "/" });
  clearRefreshCookie(reply);
}

/**
 * Revoke every outstanding access and refresh token for a user. Tokens carry
 * the version they were minted under; `authenticateSession` and the refresh
 * handler reject any other. Call on password change, admin-status change and
 * logout.
 */
export function revokeUserSessions(db: Database.Database, userId: string): void {
  db.prepare("UPDATE users SET token_version = token_version + 1 WHERE id = ?").run(
    userId,
  );
}
