import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server.js";
import { verifyPassword } from "../src/auth/passwords.js";

describe("seedOwner — issue #106", () => {
  let app: FastifyInstance | undefined;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makePaths() {
    const dir = mkdtempSync(join(tmpdir(), "poutine-seed-"));
    tmpDirs.push(dir);
    return {
      keyPath: join(dir, "ed.pem"),
      pwKeyPath: join(dir, "pwkey"),
      dbPath: join(dir, "p.db"),
    };
  }

  it("inserts owner row on first boot with verifiable encrypted password", async () => {
    const { keyPath, pwKeyPath } = makePaths();
    app = await buildApp({
      databasePath: ":memory:",
      jwtSecret: "x",
      poutinePrivateKeyPath: keyPath,
      poutinePasswordKeyPath: pwKeyPath,
      poutineOwnerUsername: "alice",
      poutineOwnerPassword: "hunter2",
    });
    await app.ready();
    const row = app.db
      .prepare("SELECT password_enc, is_admin FROM users WHERE username = 'alice'")
      .get() as { password_enc: string; is_admin: number };
    expect(row.is_admin).toBe(1);
    expect(verifyPassword(row.password_enc, "hunter2", app.passwordKey)).toBe(true);
  });

  it("repopulates owner password_enc when row exists but password is empty (post-migration)", async () => {
    const { keyPath, pwKeyPath, dbPath } = makePaths();
    const cfg = {
      databasePath: dbPath,
      jwtSecret: "x",
      poutinePrivateKeyPath: keyPath,
      poutinePasswordKeyPath: pwKeyPath,
      poutineOwnerUsername: "alice",
      poutineOwnerPassword: "first",
    };

    app = await buildApp(cfg);
    await app.ready();
    // Wipe the password to simulate the post-migration state.
    app.db.prepare("UPDATE users SET password_enc='' WHERE username='alice'").run();
    await app.close();

    // Boot again with a different owner password — seedOwner should refill.
    app = await buildApp({ ...cfg, poutineOwnerPassword: "second" });
    await app.ready();
    const row = app.db
      .prepare("SELECT password_enc, is_admin FROM users WHERE username='alice'")
      .get() as { password_enc: string; is_admin: number };
    expect(row.is_admin).toBe(1);
    expect(verifyPassword(row.password_enc, "second", app.passwordKey)).toBe(true);
  });

  it("does not touch a non-empty owner row even if env password differs", async () => {
    const { keyPath, pwKeyPath, dbPath } = makePaths();
    const cfg = {
      databasePath: dbPath,
      jwtSecret: "x",
      poutinePrivateKeyPath: keyPath,
      poutinePasswordKeyPath: pwKeyPath,
      poutineOwnerUsername: "alice",
      poutineOwnerPassword: "first",
    };
    app = await buildApp(cfg);
    await app.ready();
    await app.close();

    app = await buildApp({ ...cfg, poutineOwnerPassword: "ignored" });
    await app.ready();
    const row = app.db
      .prepare("SELECT password_enc FROM users WHERE username='alice'")
      .get() as { password_enc: string };
    expect(verifyPassword(row.password_enc, "first", app.passwordKey)).toBe(true);
    expect(verifyPassword(row.password_enc, "ignored", app.passwordKey)).toBe(false);
  });
});
