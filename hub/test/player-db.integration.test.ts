/**
 * Integration test for the Player database (`player.db`) wiring introduced
 * in #215 (Phase 1 of #212).
 *
 * Boots the hub via `buildApp()` against a real on-disk path and asserts:
 *
 *   1. The `player.db` file is created alongside `hub.db`.
 *   2. DLNA UUID + cast signing key are reachable through `app.playerSettings`.
 *   3. Both values are persisted in `player_settings` (no longer derived on
 *      every boot).
 *   4. A second `buildApp()` against the same data dir returns the same
 *      values (i.e. the persisted rows win over the fallback).
 *
 * Run via `pnpm --filter hub test:integration`.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";

describe("player.db wiring (integration, #215)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "poutine-player-db-"));
  const hubDbPath = join(tmp, "poutine.db");
  const expectedPlayerDbPath = join(tmp, "player.db");

  let app: FastifyInstance;
  let firstUuid: string;
  let firstSecretB64: string;

  beforeAll(async () => {
    app = await buildApp({
      databasePath: hubDbPath,
      jwtSecret: "x",
      poutinePrivateKeyPath: join(tmp, "ed.pem"),
      poutinePasswordKeyPath: join(tmp, "pwkey"),
      poutineInstanceId: "player-db-int-test",
      poutineOwnerUsername: "alice",
      poutineOwnerPassword: "hunter2",
      // DLNA enabled so the dlnaUuid decorator gets wired through
      // playerSettings.getDlnaUuid().
      dlnaEnabled: true,
      dlnaFriendlyName: "Poutine Player DB Test",
      dlnaSkipSsdp: true,
      initialLanUrl: undefined,
    });
  });

  afterAll(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates player.db alongside hub.db", () => {
    expect(existsSync(expectedPlayerDbPath)).toBe(true);
  });

  it("exposes playerSettings + playerDb decorators", () => {
    expect(app.playerDb).toBeDefined();
    expect(app.playerSettings).toBeDefined();
  });

  it("persists DLNA UUID and matches the app.dlnaUuid decorator", () => {
    firstUuid = app.playerSettings.getDlnaUuid(() => {
      throw new Error("fallback should not run — value must be persisted");
    });
    expect(firstUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(app.dlnaUuid).toBe(firstUuid);

    // Direct read against player.db confirms persistence (no ATTACH).
    const db = new Database(expectedPlayerDbPath, { readonly: true });
    try {
      const row = db
        .prepare("SELECT value FROM player_settings WHERE key = 'dlna_uuid'")
        .get() as { value: string } | undefined;
      expect(row?.value).toBe(firstUuid);
    } finally {
      db.close();
    }
  });

  it("persists cast signing key and matches the app.castSecret decorator", () => {
    const secret = app.playerSettings.getCastSecret(() => {
      throw new Error("fallback should not run — value must be persisted");
    });
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(secret.equals(app.castSecret)).toBe(true);
    firstSecretB64 = secret.toString("base64");

    const db = new Database(expectedPlayerDbPath, { readonly: true });
    try {
      const row = db
        .prepare(
          "SELECT value FROM player_settings WHERE key = 'cast_signing_key'",
        )
        .get() as { value: string } | undefined;
      expect(row?.value).toBe(firstSecretB64);
    } finally {
      db.close();
    }
  });

  it("returns the persisted values on a second boot (no re-generation)", async () => {
    await app.close();
    const app2 = await buildApp({
      databasePath: hubDbPath,
      jwtSecret: "x",
      poutinePrivateKeyPath: join(tmp, "ed.pem"),
      poutinePasswordKeyPath: join(tmp, "pwkey"),
      // Different instance id — would change the SHA1-derived fallback,
      // but the persisted UUID must win.
      poutineInstanceId: "player-db-int-test-DIFFERENT",
      poutineOwnerUsername: "alice",
      poutineOwnerPassword: "hunter2",
      dlnaEnabled: true,
      dlnaFriendlyName: "Poutine Player DB Test",
      dlnaSkipSsdp: true,
      initialLanUrl: undefined,
    });
    try {
      expect(app2.dlnaUuid).toBe(firstUuid);
      expect(app2.castSecret.toString("base64")).toBe(firstSecretB64);
    } finally {
      await app2.close();
    }
  });
});
