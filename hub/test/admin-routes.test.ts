/**
 * Tests for the /admin/* routes.
 *
 * Covers: login, me, users CRUD, peers list, sync trigger, cache stats/control.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { hashPassword } from "../src/auth/passwords.js";
import type { Config } from "../src/config.js";

const testConfig: Partial<Config> = {
  databasePath: ":memory:",
  jwtSecret: "test-secret-key-for-admin-tests",
};

async function seedAdmin(
  app: FastifyInstance,
  username = "owner",
  password = "adminpass",
): Promise<string> {
  const hash = await hashPassword(password);
  app.db
    .prepare(
      "INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, 1)",
    )
    .run("admin-1", username, hash);
  return password;
}

async function loginAs(
  app: FastifyInstance,
  username: string,
  password: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/admin/login",
    payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  return body.accessToken as string;
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

// ── Login ─────────────────────────────────────────────────────────────────────

describe("admin — login", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    await seedAdmin(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it("correct credentials → 200 with user info and accessToken", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/login",
      payload: { username: "owner", password: "adminpass" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.username).toBe("owner");
    expect(body.user.isAdmin).toBe(true);
    expect(typeof body.accessToken).toBe("string");
    expect(body.accessToken.length).toBeGreaterThan(0);
  });

  it("wrong password → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/login",
      payload: { username: "owner", password: "wrongpass" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("unknown username → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/login",
      payload: { username: "nobody", password: "adminpass" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("missing body fields → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/login",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("non-admin user → 403", async () => {
    const hash = await hashPassword("guestpass1");
    app.db
      .prepare(
        "INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, 0)",
      )
      .run("guest-1", "guest", hash);

    const res = await app.inject({
      method: "POST",
      url: "/admin/login",
      payload: { username: "guest", password: "guestpass1" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("unauthenticated request to protected endpoint → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/users" });
    expect(res.statusCode).toBe(401);
  });
});

// ── /admin/me ─────────────────────────────────────────────────────────────────

describe("admin — me", () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    await seedAdmin(app);
    token = await loginAs(app, "owner", "adminpass");
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /admin/me → returns current user info", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/me",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.username).toBe("owner");
    expect(body.isAdmin).toBe(true);
  });
});

// ── /admin/users ──────────────────────────────────────────────────────────────

describe("admin — users CRUD", () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    await seedAdmin(app);
    token = await loginAs(app, "owner", "adminpass");
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /admin/users → lists users (excluding __system__)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const users = res.json() as Array<{ username: string }>;
    expect(Array.isArray(users)).toBe(true);
    expect(users.some((u) => u.username === "owner")).toBe(true);
    expect(users.some((u) => u.username === "__system__")).toBe(false);
  });

  it("POST /admin/users → creates a guest user and returns 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeader(token),
      payload: { username: "newguest", password: "guestpass1" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.username).toBe("newguest");
    expect(body.isAdmin).toBe(false);
    expect(typeof body.id).toBe("string");
  });

  it("POST /admin/users with duplicate username → 409", async () => {
    await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeader(token),
      payload: { username: "dupe", password: "password1" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeader(token),
      payload: { username: "dupe", password: "password2" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("POST /admin/users with short password → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeader(token),
      payload: { username: "shortpw", password: "abc" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE /admin/users/:id → removes the user and returns 204", async () => {
    // Create a user to delete
    const create = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeader(token),
      payload: { username: "todelete", password: "deletepass" },
    });
    const { id } = create.json() as { id: string };

    const del = await app.inject({
      method: "DELETE",
      url: `/admin/users/${id}`,
      headers: authHeader(token),
    });
    expect(del.statusCode).toBe(204);

    // Verify it's gone
    const list = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: authHeader(token),
    });
    const users = list.json() as Array<{ username: string }>;
    expect(users.some((u) => u.username === "todelete")).toBe(false);
  });

  it("DELETE /admin/users/:id for unknown id → 404", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/admin/users/nonexistent-id",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE own account → 400", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/admin/users/admin-1",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── /admin/peers ──────────────────────────────────────────────────────────────

describe("admin — peers", () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    await seedAdmin(app);
    token = await loginAs(app, "owner", "adminpass");
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /admin/peers → returns an array (empty when no peers configured)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/peers",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});

// ── /admin/sync ───────────────────────────────────────────────────────────────

describe("admin — sync", () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    await seedAdmin(app);
    token = await loginAs(app, "owner", "adminpass");
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /admin/sync → returns 200 with local + peers result shape", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/sync",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // syncAll always returns this shape even when Navidrome is unreachable
    expect(body).toHaveProperty("local");
    expect(body).toHaveProperty("peers");
    expect(Array.isArray(body.peers)).toBe(true);
    expect(body.local).toHaveProperty("errors");
  });
});

// ── /admin/cache ──────────────────────────────────────────────────────────────

describe("admin — cache", () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    await seedAdmin(app);
    token = await loginAs(app, "owner", "adminpass");
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /admin/cache → returns cache stats with expected keys", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/cache",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.artCacheMaxBytes).toBe("number");
    expect(typeof body.artCacheCurrentBytes).toBe("number");
    expect(typeof body.artCacheFileCount).toBe("number");
  });

  it("PUT /admin/cache with artCacheMaxBytes → updates and returns new stats", async () => {
    const newMax = 50 * 1024 * 1024; // 50 MB
    const res = await app.inject({
      method: "PUT",
      url: "/admin/cache",
      headers: authHeader(token),
      payload: { artCacheMaxBytes: newMax },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.artCacheMaxBytes).toBe(newMax);
  });

  it("PUT /admin/cache with negative value → 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/admin/cache",
      headers: authHeader(token),
      payload: { artCacheMaxBytes: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE /admin/cache → clears cache and returns 204", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/admin/cache",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(204);
  });
});
