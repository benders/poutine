/**
 * Public invite redemption (issue #272). Mounted at `/api/invites/*`.
 *
 * The only unauthenticated write surface on the hub, so it is deliberately
 * narrow: two POSTs, a per-IP rate limit, and a single uniform error for every
 * rejected token (no enumeration of which invites exist or why one failed —
 * same posture as Subsonic error 40 covering both unknown-user and bad-password).
 *
 * Both routes are POST so the token never lands in a URL, an access log, or a
 * Referer header. The SPA carries it in the URL *fragment* and posts it from
 * there; see `frontend/src/features/invite/`.
 *
 * Not mounted under `/api/admin/hub/*` (owner-gated in its entirety) nor
 * `/admin/*` (auth-only since #226).
 */

import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { setPassword, getStoredPassword } from "../auth/passwords.js";
import { createAccessToken, createRefreshToken } from "../auth/jwt.js";
import {
  decodeUserInvite,
  verifyUserInvite,
  consumeUserInvite,
  hashInviteToken,
  type SignedUserInvite,
  type UserInviteRow,
} from "../services/user-invites.js";

/** Uniform rejection — never says whether a token was forged, spent, or stale. */
const INVALID = "Invitation is not valid";

export const RATE_LIMIT_MAX = 20;
export const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

const MIN_PASSWORD_LENGTH = 8;
const MAX_USERNAME_LENGTH = 64;
const USERNAME_RE = /^[A-Za-z0-9._-]+$/;

/** Thrown inside the redeem transaction to roll back a lost race. */
class InviteUnavailable extends Error {}

function clientIp(request: FastifyRequest): string {
  return request.ip || "unknown";
}

/**
 * Fixed-window per-IP limiter. Deliberately in-process and dependency-free —
 * this guards a two-route surface on a hub serving 20–50 users, not a public
 * API. State lives in the plugin closure so each `buildApp()` starts clean.
 */
function createRateLimiter() {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return function allow(ip: string, now = Date.now()): boolean {
    if (hits.size > 1000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    const entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      hits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return true;
    }
    entry.count += 1;
    return entry.count <= RATE_LIMIT_MAX;
  };
}

export const inviteRoutes: FastifyPluginAsync = async (app) => {
  const allow = createRateLimiter();

  /** Decode + verify signature/expiry. Returns undefined for anything invalid. */
  function openToken(token: unknown): SignedUserInvite | undefined {
    if (typeof token !== "string" || token.length === 0) return undefined;
    let signed: SignedUserInvite;
    try {
      signed = decodeUserInvite(token);
    } catch {
      return undefined;
    }
    return verifyUserInvite(app.userInviteKey, signed).ok ? signed : undefined;
  }

  // POST /api/invites/preview — what the redeem page renders before the
  // invitee types anything. Reveals nothing an invite holder doesn't have.
  app.post<{ Body: { token?: string } }>("/preview", async (request, reply) => {
    if (!allow(clientIp(request))) {
      return reply.code(429).send({ error: "Too many requests" });
    }
    const token = request.body?.token;
    const signed = openToken(token);
    if (!signed) return reply.code(400).send({ error: INVALID });

    // Signature is good; the row is still authoritative for single-use.
    const row = app.db
      .prepare(
        `SELECT id FROM user_invitations
          WHERE token_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
      )
      .get(hashInviteToken(token as string)) as { id: string } | undefined;
    if (!row) return reply.code(400).send({ error: INVALID });

    const instanceName = app.db
      .prepare("SELECT name FROM instances WHERE id = 'local'")
      .get() as { name: string } | undefined;

    return {
      valid: true,
      expiresAt: signed.payload.expires_at,
      suggestedUsername: signed.payload.suggested_username,
      isAdmin: signed.payload.is_admin,
      hubName: instanceName?.name ?? "Poutine",
    };
  });

  // POST /api/invites/redeem — create the account and sign the invitee in.
  // Response shape mirrors POST /admin/login so the SPA reuses one code path.
  app.post<{ Body: { token?: string; username?: string; password?: string } }>(
    "/redeem",
    async (request, reply) => {
      if (!allow(clientIp(request))) {
        return reply.code(429).send({ error: "Too many requests" });
      }
      const { token, username, password } = request.body ?? {};
      const signed = openToken(token);
      if (!signed) return reply.code(400).send({ error: INVALID });

      if (!username || !password) {
        return reply.code(400).send({ error: "Username and password required" });
      }
      const name = username.trim();
      if (name.length === 0 || name.length > MAX_USERNAME_LENGTH) {
        return reply
          .code(400)
          .send({ error: `Username must be 1–${MAX_USERNAME_LENGTH} characters` });
      }
      if (!USERNAME_RE.test(name)) {
        return reply.code(400).send({
          error: "Username may contain only letters, digits, dot, dash, underscore",
        });
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        return reply
          .code(400)
          .send({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }

      // Check the name BEFORE consuming: a typo must not burn the invite.
      // The invite is still spent atomically below, so the window between this
      // check and the INSERT can only produce a UNIQUE violation, not a
      // duplicate account.
      const taken = app.db
        .prepare("SELECT id FROM users WHERE username = ?")
        .get(name);
      if (taken) return reply.code(409).send({ error: "Username already taken" });

      const userId = randomUUID();
      const enc = setPassword(password, app.passwordKey);

      // Consume + create in one transaction. The user row goes in FIRST:
      // `user_invitations.consumed_by_id` is a FK onto `users`, so claiming the
      // invite for an account that doesn't exist yet fails the constraint. If
      // the claim then comes back empty (someone else redeemed the link first)
      // we throw to roll the whole thing back, account included.
      let claimed: UserInviteRow | undefined;
      try {
        app.db.transaction(() => {
          app.db
            .prepare(
              "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, 0)",
            )
            .run(userId, name, enc);
          const row = consumeUserInvite(app.db, token as string, userId);
          if (!row) throw new InviteUnavailable();
          // The DB row is authoritative for the admin grant, not the payload.
          if (row.is_admin === 1) {
            app.db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(userId);
          }
          claimed = row;
        })();
      } catch (err) {
        if (err instanceof InviteUnavailable) {
          return reply.code(400).send({ error: INVALID });
        }
        // Realistically a UNIQUE violation from a signup that raced ours.
        app.log.warn({ err }, "Invite redemption failed");
        return reply.code(409).send({ error: "Username already taken" });
      }
      if (!claimed) return reply.code(400).send({ error: INVALID });

      const isAdmin = claimed.is_admin === 1;
      app.log.info({ userId, username: name, isAdmin }, "User created via invite");

      const accessToken = await createAccessToken(userId, app.config);
      const refreshToken = await createRefreshToken(userId, app.config);
      reply.setCookie("access_token", accessToken, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 15 * 60,
      });
      reply.setCookie("refresh_token", refreshToken, {
        httpOnly: true,
        sameSite: "lax",
        path: "/admin/refresh",
        maxAge: 7 * 24 * 60 * 60,
      });

      const plaintext = getStoredPassword(enc, app.passwordKey);
      return reply.code(201).send({
        user: { id: userId, username: name, isAdmin },
        accessToken,
        subsonicCredentials: plaintext
          ? { username: name, password: plaintext }
          : null,
      });
    },
  );
};
