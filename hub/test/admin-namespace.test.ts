/**
 * Tests for the partitioned admin namespace mounts (#226, follow-up to #220).
 *
 * Three Fastify mounts, each scoped to the handlers that belong to its
 * namespace:
 *
 *   /admin/*               — auth only (kept for the refresh-cookie path)
 *   /api/admin/hub/*       — auth + Hub-owned admin
 *   /api/admin/player/*    — auth + Player-owned admin
 *
 * These tests pin the partition: handlers exist only at their namespace's
 * prefix, auth still reaches all three, and cross-namespace requests 404.
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

describe("admin namespace partition (#226)", () => {
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
    for (const path of [
      "/api/admin/hub/users",
      "/api/admin/hub/peers/summary",
      "/api/admin/hub/cache",
    ]) {
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

  it("auth endpoints are reachable at all three mounts", async () => {
    for (const prefix of ["/admin", "/api/admin/hub", "/api/admin/player"]) {
      const res = await app.inject({
        method: "GET",
        url: `${prefix}/me`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, `${prefix}/me should be 200`).toBe(200);
      expect(res.json().username).toBe("owner");
    }
  });

  it("Hub endpoints are NOT served at /admin/* (auth-only mount)", async () => {
    for (const path of ["/admin/users", "/admin/cache", "/admin/sync"]) {
      const res = await app.inject({
        method: "GET",
        url: path,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, `${path} should be 404`).toBe(404);
    }
  });

  it("Hub endpoints are NOT served at /api/admin/player/*", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/admin/player/users",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(404);

    const create = await app.inject({
      method: "POST",
      url: "/api/admin/player/users",
      headers: { authorization: `Bearer ${token}` },
      payload: { username: "evil", password: "evilpass1" },
    });
    expect(create.statusCode).toBe(404);

    const cache = await app.inject({
      method: "GET",
      url: "/api/admin/player/cache",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(cache.statusCode).toBe(404);
  });

  it("Player endpoints are NOT served at /api/admin/hub/*", async () => {
    const get = await app.inject({
      method: "GET",
      url: "/api/admin/hub/settings/sonos",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.statusCode).toBe(404);

    const put = await app.inject({
      method: "PUT",
      url: "/api/admin/hub/settings/sonos",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: { volumeCap: 99 },
    });
    expect(put.statusCode).toBe(404);
  });

  it("PUT through /api/admin/player/settings/sonos mutates and round-trips on its own mount", async () => {
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

    const get = await app.inject({
      method: "GET",
      url: "/api/admin/player/settings/sonos",
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
