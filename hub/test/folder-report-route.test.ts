/**
 * Route test for GET /api/admin/hub/data-quality/folder-report (#252).
 *
 * Owner-gated Hub-namespace endpoint: authenticated owner gets 200 + the
 * report JSON, unauthenticated gets 401, and it 404s under the Player
 * namespace (the mount partition from #226).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { setPassword } from "../src/auth/passwords.js";
import type { Config } from "../src/config.js";

const testConfig: Partial<Config> = {
  databasePath: ":memory:",
  jwtSecret: "test-secret-key-for-folder-report-tests",
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

describe("GET /data-quality/folder-report (#252)", () => {
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

  it("authenticated owner gets 200 and the report shape", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/hub/data-quality/folder-report",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      generatedAt: expect.any(String),
      coverage: expect.any(Array),
      clusters: expect.any(Array),
    });
  });

  it("unauthenticated requests are rejected with 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/hub/data-quality/folder-report",
    });
    expect(res.statusCode).toBe(401);
  });

  it("is NOT served under the Player namespace", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/player/data-quality/folder-report",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
