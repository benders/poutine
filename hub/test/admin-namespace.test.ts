/**
 * Tests for the `/api/admin/{hub,player}/*` namespace aliases introduced
 * in #220 (Phase 6 of #212).
 *
 * The same `adminRoutes` plugin is mounted at three prefixes — `/admin`
 * (historical), `/api/admin/hub` (Hub admin SPA), and `/api/admin/player`
 * (Player admin SPA). These tests pin that all three serve identical
 * handlers so the frontend partition is purely cosmetic + lint-enforced
 * (see #221) rather than a functional difference between the mounts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { setPassword } from "../src/auth/passwords.js";
import type { Config } from "../src/config.js";

const testConfig: Partial<Config> = {
  databasePath: ":memory:",
  jwtSecret: "test-secret-key-for-admin-namespace-tests",
  initialLanUrl: "http://hub.lan:3000",
};

async function login(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/admin/login",
    payload: { username: "owner", password: "adminpass" },
  });
  expect(res.statusCode).toBe(200);
  return res.json().accessToken as string;
}

describe("admin namespace aliases (#220)", () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    const enc = setPassword("adminpass", app.passwordKey);
    app.db
      .prepare(
        "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, 1)",
      )
      .run("admin-1", "owner", enc);
    token = await login(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it("Hub admin endpoints are reachable at /api/admin/hub/*", async () => {
    // Pick a representative endpoint from each ownership concern: users
    // (Hub-only), peers/summary (Hub-only), cache (Hub-only).
    for (const path of ["/api/admin/hub/users", "/api/admin/hub/peers/summary", "/api/admin/hub/cache"]) {
      const res = await app.inject({
        method: "GET",
        url: path,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, `${path} should be 200`).toBe(200);
    }
  });

  it("Player admin endpoints are reachable at /api/admin/player/*", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/player/settings/sonos",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      enabled: expect.any(Boolean),
      volumeCap: expect.any(Number),
      lanUrl: "http://hub.lan:3000",
    });
  });

  it("historical /admin/* paths still resolve (backward-compat alias)", async () => {
    // #220 keeps the legacy mount so existing integrations + the
    // auth-cookie path on /admin/refresh keep working. Boundary
    // enforcement (which mount serves which endpoint) lands in #221.
    const res = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("PUT through /api/admin/player/settings/sonos mutates and round-trips", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/admin/player/settings/sonos",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: { volumeCap: 42 },
    });
    expect(put.statusCode).toBe(200);

    // Read back via the Hub mount as well — the same setting is reachable
    // from every mount today (#221 will partition).
    const get = await app.inject({
      method: "GET",
      url: "/admin/settings/sonos",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().volumeCap).toBe(42);
  });

  it("unauthenticated requests at namespaced paths still 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/hub/users",
    });
    expect(res.statusCode).toBe(401);
  });
});
