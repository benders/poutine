/**
 * User invitations (#272): signing/verification unit tests, the admin issue /
 * list / revoke endpoints, and the public preview / redeem routes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import type { Config } from "../src/config.js";
import { seedAdminUser } from "./helpers/admin-user.js";
import {
  createUserInvite,
  encodeUserInvite,
  decodeUserInvite,
  verifyUserInvite,
  consumeUserInvite,
  recordUserInvite,
  revokeUserInvite,
  inviteState,
  hashInviteToken,
  ensureUserInviteKey,
  DEFAULT_INVITE_TTL_SEC,
  type UserInviteRow,
} from "../src/services/user-invites.js";
import { RATE_LIMIT_MAX } from "../src/routes/invites.js";

const testConfig: Partial<Config> = {
  databasePath: ":memory:",
  jwtSecret: "test-secret-key-for-invite-tests",
};

const KEY = Buffer.alloc(32, 7);

// ── Token signing ─────────────────────────────────────────────────────────────

describe("user invites — token", () => {
  it("round-trips through encode/decode", () => {
    const signed = createUserInvite({ key: KEY, suggestedUsername: "dana" });
    const decoded = decodeUserInvite(encodeUserInvite(signed));
    expect(decoded).toEqual(signed);
  });

  it("verifies a token it minted", () => {
    const signed = createUserInvite({ key: KEY });
    expect(verifyUserInvite(KEY, signed).ok).toBe(true);
  });

  it("rejects a token signed with a different key", () => {
    const signed = createUserInvite({ key: KEY });
    const other = Buffer.alloc(32, 9);
    expect(verifyUserInvite(other, signed).ok).toBe(false);
  });

  it("rejects a tampered payload (is_admin flipped)", () => {
    const signed = createUserInvite({ key: KEY, isAdmin: false });
    signed.payload.is_admin = true;
    const res = verifyUserInvite(KEY, signed);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Signature/);
  });

  it("rejects an expired token", () => {
    const signed = createUserInvite({ key: KEY, expiresInSec: 60 });
    const later = new Date(Date.now() + 120 * 1000);
    expect(verifyUserInvite(KEY, signed, { now: later }).ok).toBe(false);
  });

  it("defaults to a 48h TTL", () => {
    const signed = createUserInvite({ key: KEY });
    const ttl =
      (new Date(signed.payload.expires_at).getTime() -
        new Date(signed.payload.issued_at).getTime()) /
      1000;
    expect(ttl).toBe(DEFAULT_INVITE_TTL_SEC);
  });

  it("rejects garbage input at decode", () => {
    expect(() => decodeUserInvite("not-a-token")).toThrow();
    expect(() =>
      decodeUserInvite(Buffer.from('{"nope":1}').toString("base64url")),
    ).toThrow();
  });

  it("produces a URL-fragment-safe token (base64url, no padding)", () => {
    const token = encodeUserInvite(createUserInvite({ key: KEY }));
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

// ── Persistence + atomic consume ──────────────────────────────────────────────

describe("user invites — persistence", () => {
  let app: FastifyInstance;
  let adminId: string;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    adminId = (await seedAdminUser(app)).userId;
  });
  afterEach(async () => await app.close());

  function issue(opts: { expiresInSec?: number } = {}) {
    const signed = createUserInvite({ key: app.userInviteKey, ...opts });
    const token = encodeUserInvite(signed);
    const id = recordUserInvite(app.db, { signed, token, createdBy: adminId });
    return { id, token };
  }

  it("stores only the token hash, never the token", () => {
    const { token } = issue();
    const row = app.db
      .prepare("SELECT * FROM user_invitations")
      .get() as UserInviteRow & { token_hash: string };
    expect(row.token_hash).toBe(hashInviteToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("consumes exactly once", () => {
    const { token } = issue();
    expect(consumeUserInvite(app.db, token, adminId)).toBeDefined();
    expect(consumeUserInvite(app.db, token, adminId)).toBeUndefined();
  });

  it("refuses to consume an expired invite", () => {
    const { id, token } = issue();
    app.db
      .prepare("UPDATE user_invitations SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), id);
    expect(consumeUserInvite(app.db, token, adminId)).toBeUndefined();
  });

  it("refuses to consume a revoked invite", () => {
    const { id, token } = issue();
    expect(revokeUserInvite(app.db, id)).toBe(true);
    expect(consumeUserInvite(app.db, token, adminId)).toBeUndefined();
  });

  it("will not revoke an already-consumed invite", () => {
    const { id, token } = issue();
    consumeUserInvite(app.db, token, adminId);
    expect(revokeUserInvite(app.db, id)).toBe(false);
  });

  it("reports state", () => {
    const base: UserInviteRow = {
      id: "x",
      suggested_username: null,
      is_admin: 0,
      note: null,
      created_by: adminId,
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: null,
      consumed_by_id: null,
      revoked_at: null,
    };
    expect(inviteState(base)).toBe("pending");
    expect(
      inviteState({ ...base, expires_at: new Date(Date.now() - 1).toISOString() }),
    ).toBe("expired");
    expect(inviteState({ ...base, consumed_at: "now" })).toBe("consumed");
    expect(inviteState({ ...base, revoked_at: "now" })).toBe("revoked");
  });

  it("persists one key across calls", () => {
    const first = ensureUserInviteKey(app.db);
    expect(ensureUserInviteKey(app.db).equals(first)).toBe(true);
    expect(app.userInviteKey.equals(first)).toBe(true);
  });
});

// ── Admin endpoints ───────────────────────────────────────────────────────────

describe("user invites — admin API", () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    token = (await seedAdminUser(app)).token;
  });
  afterEach(async () => await app.close());

  const auth = () => ({ authorization: `Bearer ${token}` });

  async function issueInvite(payload: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/hub/user-invites",
      headers: auth(),
      payload,
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  it("issues an invite URL carrying the token in the fragment", async () => {
    const body = await issueInvite({ baseUrl: "https://hub.example/" });
    expect(body.url).toBe(`https://hub.example/invite#${body.token}`);
    expect(body.expiresAt).toBeTruthy();
  });

  it("falls back to the request origin when no baseUrl is given", async () => {
    const body = await issueInvite();
    expect(body.url).toMatch(/^http:\/\/[^/]+\/invite#/);
  });

  it("requires admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/hub/user-invites",
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("is not mounted in the player namespace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/player/user-invites",
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it("lists invites without ever returning the token", async () => {
    const { token: inviteToken } = await issueInvite({
      suggestedUsername: "dana",
      note: "the drummer",
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/hub/user-invites",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(inviteToken);
    const [row] = res.json();
    expect(row).toMatchObject({
      state: "pending",
      suggestedUsername: "dana",
      note: "the drummer",
      isAdmin: false,
      createdBy: "admin-test",
    });
  });

  it("revokes an invite, then 409s on a second revoke", async () => {
    const { id } = await issueInvite();
    const first = await app.inject({
      method: "DELETE",
      url: `/api/admin/hub/user-invites/${id}`,
      headers: auth(),
    });
    expect(first.statusCode).toBe(204);
    const second = await app.inject({
      method: "DELETE",
      url: `/api/admin/hub/user-invites/${id}`,
      headers: auth(),
    });
    expect(second.statusCode).toBe(409);
  });

  it("404s revoking an unknown invite", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/admin/hub/user-invites/nope",
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── Public preview / redeem ───────────────────────────────────────────────────

describe("user invites — redemption", () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    adminToken = (await seedAdminUser(app)).token;
  });
  afterEach(async () => await app.close());

  async function newInvite(payload: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/hub/user-invites",
      headers: { authorization: `Bearer ${adminToken}` },
      payload,
    });
    return res.json() as { id: string; token: string; url: string };
  }

  const redeem = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/invites/redeem", payload });

  const preview = (token: unknown) =>
    app.inject({ method: "POST", url: "/api/invites/preview", payload: { token } });

  it("previews a valid invite", async () => {
    const { token } = await newInvite({ suggestedUsername: "dana" });
    const res = await preview(token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ valid: true, suggestedUsername: "dana" });
  });

  it("rejects a forged, unknown, or revoked token with one uniform error", async () => {
    const { id, token } = await newInvite();
    const forged = await preview("garbage");
    expect(forged.statusCode).toBe(400);
    expect(forged.json().error).toBe("Invitation is not valid");

    await app.inject({
      method: "DELETE",
      url: `/api/admin/hub/user-invites/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const revoked = await preview(token);
    expect(revoked.statusCode).toBe(400);
    expect(revoked.json().error).toBe("Invitation is not valid");
  });

  it("creates the account and signs the invitee in", async () => {
    const { token } = await newInvite();
    const res = await redeem({ token, username: "dana", password: "hunter2hunter2" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toMatchObject({ username: "dana", isAdmin: false });
    expect(body.accessToken).toBeTruthy();
    expect(body.subsonicCredentials).toEqual({
      username: "dana",
      password: "hunter2hunter2",
    });
    const cookies = res.cookies.map((c) => c.name);
    expect(cookies).toContain("access_token");
    expect(cookies).toContain("refresh_token");

    // The new account really works against the normal login path.
    const login = await app.inject({
      method: "POST",
      url: "/admin/login",
      payload: { username: "dana", password: "hunter2hunter2" },
    });
    expect(login.statusCode).toBe(200);
  });

  it("honors is_admin from the signed payload", async () => {
    const { token } = await newInvite({ isAdmin: true });
    const res = await redeem({ token, username: "boss", password: "hunter2hunter2" });
    expect(res.json().user.isAdmin).toBe(true);
  });

  it("is single-use", async () => {
    const { token } = await newInvite();
    expect((await redeem({ token, username: "a1", password: "hunter2hunter2" })).statusCode).toBe(201);
    const second = await redeem({ token, username: "a2", password: "hunter2hunter2" });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe("Invitation is not valid");
    expect(
      app.db.prepare("SELECT id FROM users WHERE username = 'a2'").get(),
    ).toBeUndefined();
  });

  it("does not burn the invite on a taken username", async () => {
    const { token } = await newInvite();
    const clash = await redeem({
      token,
      username: "admin-test",
      password: "hunter2hunter2",
    });
    expect(clash.statusCode).toBe(409);
    const retry = await redeem({ token, username: "dana", password: "hunter2hunter2" });
    expect(retry.statusCode).toBe(201);
  });

  it("does not burn the invite on a rejected password", async () => {
    const { token } = await newInvite();
    expect((await redeem({ token, username: "dana", password: "short" })).statusCode).toBe(400);
    expect(
      (await redeem({ token, username: "dana", password: "hunter2hunter2" })).statusCode,
    ).toBe(201);
  });

  it("rejects usernames outside the allowed character set", async () => {
    const { token } = await newInvite();
    const res = await redeem({
      token,
      username: "da na!",
      password: "hunter2hunter2",
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses an expired invite", async () => {
    const { id, token } = await newInvite();
    app.db
      .prepare("UPDATE user_invitations SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), id);
    // Expiry is inside the signed payload, so this is caught before the DB.
    const res = await redeem({ token, username: "dana", password: "hunter2hunter2" });
    expect(res.statusCode).toBe(400);
  });

  it("rate-limits the public routes per IP", async () => {
    const { token } = await newInvite();
    let last = 200;
    for (let i = 0; i < RATE_LIMIT_MAX + 1; i++) {
      last = (await preview(token)).statusCode;
    }
    expect(last).toBe(429);
  });
});
