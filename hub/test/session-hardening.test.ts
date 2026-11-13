/**
 * Web session hardening (#315): token types, revocation, cookie flags, CORS,
 * and the failed-password throttle.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import Database from "better-sqlite3";
import { SignJWT } from "jose";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server.js";
import { createDatabase } from "../src/db/client.js";
import { parseOrigins, parseTrustProxy, type Config } from "../src/config.js";
import { setPassword } from "../src/auth/passwords.js";
import { createAccessToken, createRefreshToken } from "../src/auth/jwt.js";
import {
  AuthThrottle,
  WindowCounter,
  AUTH_FAILURES_PER_USER,
  AUTH_FAILURES_PER_ADDRESS,
  AUTH_FAILURE_WINDOW_MS,
} from "../src/auth/rate-limit.js";

const JWT_SECRET = "test-secret-key-for-session-tests";
const testConfig: Partial<Config> = { databasePath: ":memory:", jwtSecret: JWT_SECRET };

const OWNER = { id: "owner-1", username: "owner", password: "ownerpass1" };
const ALICE = { id: "alice-1", username: "alice", password: "alicepass1" };

function seedUsers(app: FastifyInstance): void {
  const insert = app.db.prepare(
    "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, ?)",
  );
  insert.run(OWNER.id, OWNER.username, setPassword(OWNER.password, app.passwordKey), 1);
  insert.run(ALICE.id, ALICE.username, setPassword(ALICE.password, app.passwordKey), 0);
}

interface Session {
  accessToken: string;
  refreshToken: string;
  res: LightMyRequestResponse;
}

async function login(
  app: FastifyInstance,
  who: { username: string; password: string },
  extra: { headers?: Record<string, string>; remoteAddress?: string } = {},
): Promise<Session> {
  const res = await app.inject({
    method: "POST",
    url: "/admin/login",
    payload: { username: who.username, password: who.password },
    ...extra,
  });
  expect(res.statusCode).toBe(200);
  const refresh = res.cookies.find((c) => c.name === "refresh_token");
  return {
    accessToken: res.json().accessToken as string,
    refreshToken: refresh!.value,
    res,
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function me(app: FastifyInstance, token: string): Promise<number> {
  const res = await app.inject({ method: "GET", url: "/admin/me", headers: bearer(token) });
  return res.statusCode;
}

async function refresh(app: FastifyInstance, refreshToken: string): Promise<number> {
  const res = await app.inject({
    method: "POST",
    url: "/admin/refresh",
    cookies: { refresh_token: refreshToken },
  });
  return res.statusCode;
}

describe("session hardening (#315)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    seedUsers(app);
  });
  afterEach(async () => {
    await app.close();
  });

  describe("token types", () => {
    it("rejects a refresh token as a bearer or cookie access token", async () => {
      const { refreshToken } = await login(app, OWNER);
      expect(await me(app, refreshToken)).toBe(401);

      const viaCookie = await app.inject({
        method: "GET",
        url: "/admin/me",
        cookies: { access_token: refreshToken },
      });
      expect(viaCookie.statusCode).toBe(401);

      const ownerRoute = await app.inject({
        method: "GET",
        url: "/api/admin/hub/users",
        headers: bearer(refreshToken),
      });
      expect(ownerRoute.statusCode).toBe(401);
    });

    it("rejects an access token at /admin/refresh", async () => {
      const { accessToken } = await login(app, OWNER);
      expect(await refresh(app, accessToken)).toBe(401);
    });

    it("rejects a validly signed token that carries no type claim", async () => {
      const untyped = await new SignJWT({ userId: OWNER.id })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("15m")
        .setSubject(OWNER.id)
        .sign(new TextEncoder().encode(JWT_SECRET));
      expect(await me(app, untyped)).toBe(401);
    });

    it("does not read a JWT from the query string", async () => {
      const { accessToken } = await login(app, OWNER);
      const res = await app.inject({
        method: "GET",
        url: `/admin/me?token=${accessToken}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("still accepts the access token as bearer and as cookie", async () => {
      const { accessToken } = await login(app, OWNER);
      expect(await me(app, accessToken)).toBe(200);
      const viaCookie = await app.inject({
        method: "GET",
        url: "/admin/me",
        cookies: { access_token: accessToken },
      });
      expect(viaCookie.statusCode).toBe(200);
    });
  });

  describe("revocation", () => {
    it("a password change revokes the target's access and refresh tokens", async () => {
      const owner = await login(app, OWNER);
      const alice = await login(app, ALICE);

      const res = await app.inject({
        method: "PUT",
        url: `/api/admin/hub/users/${ALICE.id}/password`,
        headers: bearer(owner.accessToken),
        payload: { password: "a-new-password" },
      });
      expect(res.statusCode).toBe(204);

      expect(await me(app, alice.accessToken)).toBe(401);
      expect(await refresh(app, alice.refreshToken)).toBe(401);
      // The acting admin's own session is untouched.
      expect(await me(app, owner.accessToken)).toBe(200);

      const again = await login(app, { username: ALICE.username, password: "a-new-password" });
      expect(await me(app, again.accessToken)).toBe(200);
    });

    it("an admin changing their own password keeps this browser, drops the rest", async () => {
      const here = await login(app, OWNER);
      const elsewhere = await login(app, OWNER);

      const res = await app.inject({
        method: "PUT",
        url: `/api/admin/hub/users/${OWNER.id}/password`,
        headers: bearer(here.accessToken),
        payload: { password: "a-new-password" },
      });
      expect(res.statusCode).toBe(204);

      // Every pre-change token is dead, including the caller's bearer token…
      expect(await me(app, here.accessToken)).toBe(401);
      expect(await refresh(app, here.refreshToken)).toBe(401);
      expect(await me(app, elsewhere.accessToken)).toBe(401);
      expect(await refresh(app, elsewhere.refreshToken)).toBe(401);

      // …but the response re-issued cookies, so the SPA's silent refresh works.
      const reissued = res.cookies.find((c) => c.name === "refresh_token");
      expect(await refresh(app, reissued!.value)).toBe(200);
    });

    it("an admin-status change revokes the target's tokens", async () => {
      const owner = await login(app, OWNER);
      const alice = await login(app, ALICE);

      const res = await app.inject({
        method: "PUT",
        url: `/api/admin/hub/users/${ALICE.id}/admin`,
        headers: bearer(owner.accessToken),
        payload: { isAdmin: true },
      });
      expect(res.statusCode).toBe(204);

      expect(await me(app, alice.accessToken)).toBe(401);
      expect(await refresh(app, alice.refreshToken)).toBe(401);
    });

    it("logout revokes every session of that user, and only that user", async () => {
      const phone = await login(app, ALICE);
      const laptop = await login(app, ALICE);
      const owner = await login(app, OWNER);

      const res = await app.inject({
        method: "POST",
        url: "/admin/logout",
        headers: bearer(phone.accessToken),
      });
      expect(res.statusCode).toBe(204);
      expect(res.cookies.map((c) => c.name).sort()).toEqual([
        "access_token",
        "refresh_token",
      ]);

      expect(await me(app, phone.accessToken)).toBe(401);
      expect(await refresh(app, phone.refreshToken)).toBe(401);
      expect(await me(app, laptop.accessToken)).toBe(401);
      expect(await refresh(app, laptop.refreshToken)).toBe(401);
      expect(await me(app, owner.accessToken)).toBe(200);
    });

    it("logout without a valid token still answers 204 and revokes nothing", async () => {
      const alice = await login(app, ALICE);
      const res = await app.inject({
        method: "POST",
        url: "/admin/logout",
        headers: bearer("not-a-jwt"),
      });
      expect(res.statusCode).toBe(204);
      expect(await me(app, alice.accessToken)).toBe(200);
    });

    it("refresh carries the token version forward", async () => {
      const alice = await login(app, ALICE);
      const res = await app.inject({
        method: "POST",
        url: "/admin/refresh",
        cookies: { refresh_token: alice.refreshToken },
      });
      expect(res.statusCode).toBe(200);
      expect(await me(app, res.json().accessToken as string)).toBe(200);
    });

    it("a token minted under an older version is rejected", async () => {
      app.db.prepare("UPDATE users SET token_version = 3 WHERE id = ?").run(ALICE.id);
      const stale = await createAccessToken(ALICE.id, app.config, 2);
      const current = await createAccessToken(ALICE.id, app.config, 3);
      expect(await me(app, stale)).toBe(401);
      expect(await me(app, current)).toBe(200);
      expect(await refresh(app, await createRefreshToken(ALICE.id, app.config, 2))).toBe(401);
      expect(await refresh(app, await createRefreshToken(ALICE.id, app.config, 3))).toBe(200);
    });
  });

  describe("cookie flags", () => {
    const flags = (res: LightMyRequestResponse) =>
      res.cookies.map((c) => ({
        name: c.name,
        secure: c.secure === true,
        httpOnly: c.httpOnly === true,
        sameSite: c.sameSite,
      }));

    it("omits Secure over plain HTTP", async () => {
      const { res } = await login(app, OWNER);
      expect(flags(res)).toEqual([
        { name: "access_token", secure: false, httpOnly: true, sameSite: "Lax" },
        { name: "refresh_token", secure: false, httpOnly: true, sameSite: "Lax" },
      ]);
    });

    it("sets Secure when the edge terminated TLS, on login and refresh", async () => {
      const https = { "x-forwarded-proto": "https" };
      const { res, refreshToken } = await login(app, OWNER, { headers: https });
      expect(flags(res).map((c) => c.secure)).toEqual([true, true]);

      const refreshed = await app.inject({
        method: "POST",
        url: "/admin/refresh",
        headers: https,
        cookies: { refresh_token: refreshToken },
      });
      expect(refreshed.statusCode).toBe(200);
      expect(flags(refreshed).map((c) => c.secure)).toEqual([true, true]);
    });
  });

  describe("failed-password throttle", () => {
    const badLogin = (username: string, remoteAddress?: string, headers?: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/admin/login",
        payload: { username, password: "wrong-password" },
        remoteAddress,
        headers,
      });
    const goodLogin = (remoteAddress?: string, headers?: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/admin/login",
        payload: { username: ALICE.username, password: ALICE.password },
        remoteAddress,
        headers,
      });

    it("locks an (address, username) out after N failures, even with the right password", async () => {
      for (let i = 0; i < AUTH_FAILURES_PER_USER; i++) {
        expect((await badLogin(ALICE.username)).statusCode).toBe(401);
      }
      const locked = await goodLogin();
      expect(locked.statusCode).toBe(429);
      expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);

      // Another username from the same address, and the same username from
      // another address, are unaffected.
      await login(app, OWNER);
      expect((await goodLogin("203.0.113.9")).statusCode).toBe(200);
    });

    it("a success clears the failure count", async () => {
      for (let i = 0; i < AUTH_FAILURES_PER_USER - 1; i++) await badLogin(ALICE.username);
      expect((await goodLogin()).statusCode).toBe(200);
      for (let i = 0; i < AUTH_FAILURES_PER_USER - 1; i++) await badLogin(ALICE.username);
      expect((await goodLogin()).statusCode).toBe(200);
    });

    it("unknown usernames are throttled the same way and answer 401, not 404", async () => {
      for (let i = 0; i < AUTH_FAILURES_PER_USER; i++) {
        expect((await badLogin("nobody")).statusCode).toBe(401);
      }
      expect((await badLogin("nobody")).statusCode).toBe(429);
    });

    it("Subsonic auth failures draw on the same budget", async () => {
      const ping = (p: string) =>
        app.inject({
          method: "GET",
          url: `/rest/ping.view?u=${ALICE.username}&p=${p}&v=1.16.1&c=test&f=json`,
        });
      for (let i = 0; i < AUTH_FAILURES_PER_USER; i++) {
        const res = await ping("wrong-password");
        expect(res.json()["subsonic-response"].error.code).toBe(40);
      }

      // JSON route: Subsonic envelope, generic error 0 (not 40).
      const locked = await ping(ALICE.password);
      expect(locked.statusCode).toBe(200);
      expect(locked.json()["subsonic-response"].error.code).toBe(0);
      expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);

      // Binary route: real HTTP status.
      const art = await app.inject({
        method: "GET",
        url: `/rest/getCoverArt.view?id=x&u=${ALICE.username}&p=${ALICE.password}&v=1.16.1&c=test`,
      });
      expect(art.statusCode).toBe(429);

      // And the login form is locked by the same failures.
      expect((await goodLogin()).statusCode).toBe(429);
    });

    it("a correct Subsonic request is never counted", async () => {
      for (let i = 0; i < AUTH_FAILURES_PER_USER * 2; i++) {
        const res = await app.inject({
          method: "GET",
          url: `/rest/ping.view?u=${ALICE.username}&p=${ALICE.password}&v=1.16.1&c=test&f=json`,
        });
        expect(res.json()["subsonic-response"].status).toBe("ok");
      }
    });

    it("ignores X-Forwarded-For when TRUST_PROXY is unset", async () => {
      for (let i = 0; i < AUTH_FAILURES_PER_USER; i++) {
        await badLogin(ALICE.username, undefined, { "x-forwarded-for": `198.51.100.${i}` });
      }
      const res = await goodLogin(undefined, { "x-forwarded-for": "198.51.100.200" });
      expect(res.statusCode).toBe(429);
    });
  });

  describe("CORS", () => {
    const EVIL = "https://evil.example";

    it("does not allow a foreign origin on the cookie-authenticated API", async () => {
      const preflight = await app.inject({
        method: "OPTIONS",
        url: "/admin/login",
        headers: { origin: EVIL, "access-control-request-method": "POST" },
      });
      expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
      expect(preflight.headers["access-control-allow-credentials"]).toBeUndefined();

      const { accessToken } = await login(app, OWNER);
      const res = await app.inject({
        method: "GET",
        url: "/admin/me",
        headers: { origin: EVIL },
        cookies: { access_token: accessToken },
      });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    });

    it("answers /rest/* for any origin, never credentialed", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/rest/ping.view?u=${ALICE.username}&p=${ALICE.password}&v=1.16.1&c=test&f=json`,
        headers: { origin: EVIL },
      });
      expect(res.headers["access-control-allow-origin"]).toBe("*");
      expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    });
  });
});

describe("CORS_ALLOWED_ORIGINS (#315)", () => {
  const ALLOWED = "https://music.example";
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({ ...testConfig, corsAllowedOrigins: [ALLOWED] });
  });
  afterEach(async () => {
    await app.close();
  });

  const preflight = (origin: string) =>
    app.inject({
      method: "OPTIONS",
      url: "/admin/login",
      headers: { origin, "access-control-request-method": "POST" },
    });

  it("allows a listed origin with credentials and no other", async () => {
    const ok = await preflight(ALLOWED);
    expect(ok.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(ok.headers["access-control-allow-credentials"]).toBe("true");

    const other = await preflight("https://evil.example");
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("TRUST_PROXY (#315)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({ ...testConfig, trustProxy: "loopback" });
    seedUsers(app);
  });
  afterEach(async () => {
    await app.close();
  });

  it("keys the throttle on the forwarded client address from a trusted proxy", async () => {
    const attempt = (client: string, password: string) =>
      app.inject({
        method: "POST",
        url: "/admin/login",
        payload: { username: ALICE.username, password },
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": client },
      });
    for (let i = 0; i < AUTH_FAILURES_PER_USER; i++) {
      await attempt("198.51.100.7", "wrong-password");
    }
    expect((await attempt("198.51.100.7", ALICE.password)).statusCode).toBe(429);
    expect((await attempt("198.51.100.8", ALICE.password)).statusCode).toBe(200);
  });

  it("ignores X-Forwarded-For from an untrusted peer", async () => {
    const attempt = (client: string, password: string) =>
      app.inject({
        method: "POST",
        url: "/admin/login",
        payload: { username: ALICE.username, password },
        remoteAddress: "203.0.113.50",
        headers: { "x-forwarded-for": client },
      });
    for (let i = 0; i < AUTH_FAILURES_PER_USER; i++) {
      await attempt(`198.51.100.${i}`, "wrong-password");
    }
    expect((await attempt("198.51.100.200", ALICE.password)).statusCode).toBe(429);
  });
});

describe("rate-limit primitives (#315)", () => {
  it("WindowCounter counts within a window and starts over after it", () => {
    const c = new WindowCounter(1000);
    expect(c.increment("k", 0)).toBe(1);
    expect(c.increment("k", 999)).toBe(2);
    expect(c.count("k", 999)).toBe(2);
    expect(c.retryAfterSeconds("k", 500)).toBe(1);
    expect(c.count("k", 1000)).toBe(0);
    expect(c.increment("k", 1000)).toBe(1);
    c.reset("k");
    expect(c.count("k", 1000)).toBe(0);
  });

  it("AuthThrottle lifts the lockout when the window ends", () => {
    const t = new AuthThrottle();
    for (let i = 0; i < AUTH_FAILURES_PER_USER; i++) t.recordFailure("a", "alice", 0);
    expect(t.blockedFor("a", "alice", 1)).toBeGreaterThan(0);
    expect(t.blockedFor("a", "ALICE", 1)).toBeGreaterThan(0); // case-insensitive key
    expect(t.blockedFor("a", "alice", AUTH_FAILURE_WINDOW_MS)).toBe(0);
  });

  it("AuthThrottle caps failures per address across usernames", () => {
    const t = new AuthThrottle();
    for (let i = 0; i < AUTH_FAILURES_PER_ADDRESS; i++) t.recordFailure("a", `user-${i}`, 0);
    expect(t.blockedFor("a", "someone-new", 1)).toBeGreaterThan(0);
    expect(t.blockedFor("b", "someone-new", 1)).toBe(0);
  });
});

describe("config parsing (#315)", () => {
  it("parseTrustProxy", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy(" loopback, 172.16.0.0/12 ")).toBe("loopback, 172.16.0.0/12");
    expect(() => parseTrustProxy("1")).toThrow(/hop count/);
  });

  it("parseOrigins", () => {
    expect(parseOrigins(undefined)).toEqual([]);
    expect(parseOrigins(" https://a.example/ , https://b.example ,")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });
});

describe("users.token_version migration (#315)", () => {
  it("adds the column, defaulting existing rows to 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "poutine-tv-"));
    const path = join(dir, "old.db");
    try {
      const old = new Database(path);
      old.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_enc TEXT NOT NULL DEFAULT '',
          is_admin INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO users (id, username) VALUES ('u1', 'alice');
      `);
      old.close();

      const db = createDatabase(path);
      const row = db
        .prepare("SELECT token_version FROM users WHERE id = 'u1'")
        .get() as { token_version: number };
      expect(row.token_version).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
