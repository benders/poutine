import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "../src/server.js";
import { createDatabase } from "../src/db/client.js";
import { ensureJwtSecret } from "../src/auth/jwt-secret.js";
import type { FastifyInstance } from "fastify";

describe("ensureJwtSecret", () => {
  it("generates a 64-char hex secret on first call and persists it", () => {
    const db = createDatabase(":memory:");
    const first = ensureJwtSecret(db);
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'jwt_secret'")
      .get() as { value: string };
    expect(row.value).toBe(first);
  });

  it("returns the same secret on subsequent calls", () => {
    const db = createDatabase(":memory:");
    const first = ensureJwtSecret(db);
    const second = ensureJwtSecret(db);
    expect(second).toBe(first);
  });
});

describe("buildApp jwt secret wiring", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("populates config.jwtSecret from the DB when no override is given", async () => {
    app = await buildApp({ databasePath: ":memory:" });
    await app.ready();
    expect(app.config.jwtSecret).toMatch(/^[0-9a-f]{64}$/);
    const row = app.db
      .prepare("SELECT value FROM settings WHERE key = 'jwt_secret'")
      .get() as { value: string };
    expect(row.value).toBe(app.config.jwtSecret);
  });

  it("honors a config override without touching the DB", async () => {
    app = await buildApp({
      databasePath: ":memory:",
      jwtSecret: "explicit-override",
    });
    await app.ready();
    expect(app.config.jwtSecret).toBe("explicit-override");
    const row = app.db
      .prepare("SELECT value FROM settings WHERE key = 'jwt_secret'")
      .get() as { value: string } | undefined;
    expect(row).toBeUndefined();
  });
});
