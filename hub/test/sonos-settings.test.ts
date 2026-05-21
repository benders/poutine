import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/server.js";
import { createAccessToken } from "../src/auth/jwt.js";
import { setPassword } from "../src/auth/passwords.js";
import type { FastifyInstance } from "fastify";
import type { Config } from "../src/config.js";
import {
  createSonosSettings,
  SONOS_ENABLED_KEY,
  SONOS_VOLUME_CAP_KEY,
} from "../src/services/sonos-settings.js";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(
  join(__dirname, "../src/db/schema.sql"),
  "utf8",
);

const testConfig: Partial<Config> = {
  databasePath: ":memory:",
  jwtSecret: "test-secret-key-for-testing-purposes-#184",
  poutineLanUrl: "http://hub.lan:3000",
};

async function makeOwnerToken(app: FastifyInstance): Promise<string> {
  const pw = setPassword("ownerpw", app.passwordKey);
  app.db
    .prepare(
      "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, 1)",
    )
    .run("owner-1", "owner", pw);
  return createAccessToken("owner-1", app.config);
}

describe("SonosSettings (#184)", () => {
  describe("createSonosSettings — DB-backed", () => {
    let db: Database.Database;
    beforeEach(() => {
      db = new Database(":memory:");
      db.exec(SCHEMA);
    });
    afterEach(() => db.close());

    it("seeds defaults on first call", () => {
      const s = createSonosSettings(db);
      expect(s.getEnabled()).toBe(false);
      expect(s.getVolumeCap()).toBe(50);
    });

    it("seeds initialEnabled=true when no row exists", () => {
      const s = createSonosSettings(db, { initialEnabled: true });
      expect(s.getEnabled()).toBe(true);
    });

    it("does not overwrite an existing operator-set value", () => {
      db.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?)",
      ).run(SONOS_ENABLED_KEY, "true");
      // initialEnabled=false would normally seed false, but the row exists.
      const s = createSonosSettings(db, { initialEnabled: false });
      expect(s.getEnabled()).toBe(true);
    });

    it("setEnabled persists", () => {
      const s = createSonosSettings(db);
      s.setEnabled(true);
      const row = db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get(SONOS_ENABLED_KEY) as { value: string };
      expect(row.value).toBe("true");
      expect(s.getEnabled()).toBe(true);
    });

    it("clamps volume cap to 0..100", () => {
      const s = createSonosSettings(db);
      s.setVolumeCap(-10);
      expect(s.getVolumeCap()).toBe(0);
      s.setVolumeCap(150);
      expect(s.getVolumeCap()).toBe(100);
      s.setVolumeCap(42.7);
      expect(s.getVolumeCap()).toBe(43);
    });

    it("falls back to default when stored value is non-numeric", () => {
      const s = createSonosSettings(db);
      db.prepare(
        `UPDATE settings SET value = 'garbage' WHERE key = ?`,
      ).run(SONOS_VOLUME_CAP_KEY);
      expect(s.getVolumeCap()).toBe(50);
    });

    it("onChange fires after each setter", () => {
      const s = createSonosSettings(db);
      const seen: Array<{ enabled: boolean; volumeCap: number }> = [];
      s.onChange((snap) => seen.push(snap));
      s.setEnabled(true);
      s.setVolumeCap(75);
      expect(seen).toEqual([
        { enabled: true, volumeCap: 50 },
        { enabled: true, volumeCap: 75 },
      ]);
    });
  });

  describe("/api/capabilities + /api/sonos/* gating", () => {
    let app: FastifyInstance;
    beforeEach(async () => {
      app = await buildApp(testConfig);
      await app.ready();
    });
    afterEach(async () => {
      await app.close();
    });

    it("capabilities.sonos defaults to false", async () => {
      const res = await app.inject({ method: "GET", url: "/api/capabilities" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ sonos: false });
    });

    it("/api/sonos/devices returns 503 when disabled", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/sonos/devices",
        headers: { authorization: "Bearer anything" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "Sonos is disabled" });
    });

    it("/cast/stream/:trackId returns 503 when disabled", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/cast/stream/foo?token=bar",
      });
      expect(res.statusCode).toBe(503);
    });

    it("capabilities flips immediately after toggle", async () => {
      app.sonosSettings.setEnabled(true);
      const res = await app.inject({ method: "GET", url: "/api/capabilities" });
      expect(res.json()).toMatchObject({ sonos: true });
    });
  });

  describe("admin /admin/settings/sonos", () => {
    let app: FastifyInstance;
    let token: string;
    beforeEach(async () => {
      app = await buildApp(testConfig);
      await app.ready();
      token = await makeOwnerToken(app);
    });
    afterEach(async () => {
      await app.close();
    });

    it("GET returns current state", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/settings/sonos",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ enabled: false, volumeCap: 50 });
    });

    it("requires owner auth", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/settings/sonos",
      });
      expect(res.statusCode).toBe(401);
    });

    it("PUT toggles enabled and persists volumeCap", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/admin/settings/sonos",
        headers: { authorization: `Bearer ${token}` },
        payload: { enabled: true, volumeCap: 33 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ enabled: true, volumeCap: 33 });
      expect(app.sonosSettings.getEnabled()).toBe(true);
      expect(app.sonosSettings.getVolumeCap()).toBe(33);
    });

    it("PUT rejects out-of-range volumeCap", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/admin/settings/sonos",
        headers: { authorization: `Bearer ${token}` },
        payload: { volumeCap: 200 },
      });
      expect(res.statusCode).toBe(400);
    });

    it("PUT rejects non-boolean enabled", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/admin/settings/sonos",
        headers: { authorization: `Bearer ${token}` },
        payload: { enabled: "yes" },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
