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
import { createPlayerSettings } from "../src/services/player-settings.js";
import { createPlayerDatabase } from "../src/db/player-db.js";
import Database from "better-sqlite3";

const testConfig: Partial<Config> = {
  databasePath: ":memory:",
  jwtSecret: "test-secret-key-for-testing-purposes-#184",
  initialLanUrl: "http://hub.lan:3000",
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
  describe("createSonosSettings — player.db-backed (#217)", () => {
    let db: Database.Database;
    let settings: ReturnType<typeof createPlayerSettings>;
    beforeEach(() => {
      db = createPlayerDatabase(":memory:");
      settings = createPlayerSettings(db);
    });
    afterEach(() => db.close());

    it("seeds defaults on first call", () => {
      const s = createSonosSettings(settings);
      expect(s.getEnabled()).toBe(false);
      expect(s.getVolumeCap()).toBe(50);
    });

    it("seeds initialEnabled=true when no row exists", () => {
      const s = createSonosSettings(settings, { initialEnabled: true });
      expect(s.getEnabled()).toBe(true);
    });

    it("does not overwrite an existing operator-set value", () => {
      settings.setRaw(SONOS_ENABLED_KEY, "true");
      // initialEnabled=false would normally seed false, but the row exists.
      const s = createSonosSettings(settings, { initialEnabled: false });
      expect(s.getEnabled()).toBe(true);
    });

    it("setEnabled persists into player.db", () => {
      const s = createSonosSettings(settings);
      s.setEnabled(true);
      const row = db
        .prepare("SELECT value FROM player_settings WHERE key = ?")
        .get(SONOS_ENABLED_KEY) as { value: string };
      expect(row.value).toBe("true");
      expect(s.getEnabled()).toBe(true);
    });

    it("clamps volume cap to 0..100", () => {
      const s = createSonosSettings(settings);
      s.setVolumeCap(-10);
      expect(s.getVolumeCap()).toBe(0);
      s.setVolumeCap(150);
      expect(s.getVolumeCap()).toBe(100);
      s.setVolumeCap(42.7);
      expect(s.getVolumeCap()).toBe(43);
    });

    it("falls back to default when stored value is non-numeric", () => {
      const s = createSonosSettings(settings);
      settings.setRaw(SONOS_VOLUME_CAP_KEY, "garbage");
      expect(s.getVolumeCap()).toBe(50);
    });

    it("onChange fires after each setter", () => {
      const s = createSonosSettings(settings);
      const seen: Array<{ enabled: boolean; volumeCap: number; lanUrl: string }> = [];
      s.onChange((snap) =>
        seen.push({ enabled: snap.enabled, volumeCap: snap.volumeCap, lanUrl: snap.lanUrl }),
      );
      s.setEnabled(true);
      s.setVolumeCap(75);
      s.setLanUrl("http://hub.lan:3000");
      expect(seen).toEqual([
        { enabled: true, volumeCap: 50, lanUrl: "" },
        { enabled: true, volumeCap: 75, lanUrl: "" },
        { enabled: true, volumeCap: 75, lanUrl: "http://hub.lan:3000" },
      ]);
    });

    it("lan_url: empty by default, persists when set, strips trailing slash", () => {
      const s = createSonosSettings(settings);
      expect(s.getLanUrl()).toBe("");
      s.setLanUrl("http://hub.lan:3000//");
      expect(s.getLanUrl()).toBe("http://hub.lan:3000");
      s.setLanUrl("");
      expect(s.getLanUrl()).toBe("");
    });

    it("lan_url: rejects garbage and non-http schemes", () => {
      const s = createSonosSettings(settings);
      expect(() => s.setLanUrl("not a url")).toThrow();
      expect(() => s.setLanUrl("ftp://hub.lan")).toThrow();
      // failed sets must not persist
      expect(s.getLanUrl()).toBe("");
    });

    it("initialLanUrl seeds on first boot, ignored when row exists", () => {
      const s1 = createSonosSettings(settings, { initialLanUrl: "http://seed.lan:3000" });
      expect(s1.getLanUrl()).toBe("http://seed.lan:3000");
      // second creation should not overwrite the persisted value
      const s2 = createSonosSettings(settings, { initialLanUrl: "http://other.lan:3000" });
      expect(s2.getLanUrl()).toBe("http://seed.lan:3000");
    });

    it("dlnaEnabled + dlnaFriendlyName persist + seed cleanly", () => {
      const s = createSonosSettings(settings, {
        initialDlnaEnabled: true,
        initialDlnaFriendlyName: "Test Server",
      });
      expect(s.getDlnaEnabled()).toBe(true);
      expect(s.getDlnaFriendlyName()).toBe("Test Server");
      s.setDlnaEnabled(false);
      s.setDlnaFriendlyName("Renamed");
      expect(s.getDlnaEnabled()).toBe(false);
      expect(s.getDlnaFriendlyName()).toBe("Renamed");
    });

    it("dlnaFriendlyName falls back to default for blank values", () => {
      const s = createSonosSettings(settings);
      expect(s.getDlnaFriendlyName()).toBe("Poutine");
      s.setDlnaFriendlyName("   ");
      expect(s.getDlnaFriendlyName()).toBe("Poutine");
    });
  });

  describe("hub.db → player.db migration (#217)", () => {
    let app: FastifyInstance;
    afterEach(async () => {
      if (app) await app.close();
    });

    it("copies pre-existing hub.db settings rows on first boot", async () => {
      app = await buildApp({
        ...testConfig,
        // give the migration something to copy by seeding hub.db before
        // PlayerSettings reads it.
      });
      // Stash a legacy `settings` row that does NOT exist in player.db, then
      // re-run the migration step directly — buildApp already migrated once,
      // but we want to assert the gap-fill semantics explicitly.
      app.db
        .prepare(
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('sonos_volume_cap', '77')",
        )
        .run();
      // Wipe the player.db row so the next migration call has work to do.
      app.playerDb
        .prepare("DELETE FROM player_settings WHERE key = 'sonos_volume_cap'")
        .run();
      const copied = app.playerSettings.migrateFromHubSettings(app.db);
      expect(copied).toContain("sonos_volume_cap");
      const row = app.playerDb
        .prepare("SELECT value FROM player_settings WHERE key = 'sonos_volume_cap'")
        .get() as { value: string } | undefined;
      expect(row?.value).toBe("77");
    });

    it("subsequent setVolumeCap writes land in player.db, not hub.db", async () => {
      app = await buildApp(testConfig);
      app.sonosSettings.setVolumeCap(42);
      const playerRow = app.playerDb
        .prepare("SELECT value FROM player_settings WHERE key = 'sonos_volume_cap'")
        .get() as { value: string } | undefined;
      expect(playerRow?.value).toBe("42");
      // hub.db must not be the source of truth — even if a legacy row
      // exists there with a different value, the read must return the
      // player.db value.
      app.db
        .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sonos_volume_cap', '99')")
        .run();
      expect(app.sonosSettings.getVolumeCap()).toBe(42);
    });

    it("never overwrites an existing player.db value during migration", async () => {
      app = await buildApp(testConfig);
      // pretend hub.db had a stale value
      app.db
        .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('lan_url', 'http://stale.lan')")
        .run();
      // player.db should already have the seeded testConfig value
      const before = app.sonosSettings.getLanUrl();
      const copied = app.playerSettings.migrateFromHubSettings(app.db);
      expect(copied).not.toContain("lan_url");
      expect(app.sonosSettings.getLanUrl()).toBe(before);
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

    // #218: /cast/stream/:trackId was deleted. Cast tokens now authenticate
    // /rest/stream.view directly. The "Sonos is disabled" gate moves to
    // the SPA control plane (/api/sonos/* already covered above) — the
    // Subsonic stream endpoint stays open to any authenticated request
    // (including cast tokens) so external Subsonic clients keep working
    // when Sonos casting is toggled off.

    it("capabilities flips immediately after toggle", async () => {
      app.sonosSettings.setEnabled(true);
      const res = await app.inject({ method: "GET", url: "/api/capabilities" });
      expect(res.json()).toMatchObject({ sonos: true });
    });
  });

  describe("admin /api/admin/player/settings/sonos", () => {
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
        url: "/api/admin/player/settings/sonos",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        enabled: false,
        volumeCap: 50,
        lanUrl: "http://hub.lan:3000",
      });
    });

    it("requires owner auth", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/player/settings/sonos",
      });
      expect(res.statusCode).toBe(401);
    });

    it("PUT toggles enabled and persists volumeCap", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/admin/player/settings/sonos",
        headers: { authorization: `Bearer ${token}` },
        payload: { enabled: true, volumeCap: 33 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        enabled: true,
        volumeCap: 33,
        lanUrl: "http://hub.lan:3000",
      });
      expect(app.sonosSettings.getEnabled()).toBe(true);
      expect(app.sonosSettings.getVolumeCap()).toBe(33);
    });

    it("PUT updates lanUrl and persists across reads", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/admin/player/settings/sonos",
        headers: { authorization: `Bearer ${token}` },
        payload: { lanUrl: "http://192.168.1.10:3000/" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ lanUrl: "http://192.168.1.10:3000" });
      expect(app.sonosSettings.getLanUrl()).toBe("http://192.168.1.10:3000");
    });

    it("PUT rejects malformed lanUrl with 400", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/admin/player/settings/sonos",
        headers: { authorization: `Bearer ${token}` },
        payload: { lanUrl: "not a url" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/lanUrl/);
    });

    it("PUT accepts empty string to clear lanUrl", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/admin/player/settings/sonos",
        headers: { authorization: `Bearer ${token}` },
        payload: { lanUrl: "" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().lanUrl).toBe("");
    });

    it("PUT rejects enable=true while lanUrl is empty", async () => {
      // Clear the seed first so the invariant has something to fire on.
      app.sonosSettings.setLanUrl("");
      const res = await app.inject({
        method: "PUT",
        url: "/api/admin/player/settings/sonos",
        headers: { authorization: `Bearer ${token}` },
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/LAN URL/);
      // Must not have partially applied — still disabled.
      expect(app.sonosSettings.getEnabled()).toBe(false);
    });

    it("PUT rejects clearing lanUrl while Sonos is enabled", async () => {
      app.sonosSettings.setEnabled(true); // lanUrl already seeded
      const res = await app.inject({
        method: "PUT",
        url: "/api/admin/player/settings/sonos",
        headers: { authorization: `Bearer ${token}` },
        payload: { lanUrl: "" },
      });
      expect(res.statusCode).toBe(400);
      // State must not have mutated — lanUrl still the seed value.
      expect(app.sonosSettings.getLanUrl()).toBe("http://hub.lan:3000");
    });

    it("PUT accepts enable + lanUrl in one payload (atomic)", async () => {
      app.sonosSettings.setLanUrl("");
      const res = await app.inject({
        method: "PUT",
        url: "/api/admin/player/settings/sonos",
        headers: { authorization: `Bearer ${token}` },
        payload: { enabled: true, lanUrl: "http://192.168.1.10:3000" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        enabled: true,
        lanUrl: "http://192.168.1.10:3000",
      });
    });

    it("PUT with malformed lanUrl does not mutate enabled state", async () => {
      app.sonosSettings.setEnabled(false);
      app.sonosSettings.setLanUrl("");
      const res = await app.inject({
        method: "PUT",
        url: "/api/admin/player/settings/sonos",
        headers: { authorization: `Bearer ${token}` },
        payload: { enabled: true, lanUrl: "not a url" },
      });
      expect(res.statusCode).toBe(400);
      expect(app.sonosSettings.getEnabled()).toBe(false);
      expect(app.sonosSettings.getLanUrl()).toBe("");
    });

    it("PUT rejects out-of-range volumeCap", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/admin/player/settings/sonos",
        headers: { authorization: `Bearer ${token}` },
        payload: { volumeCap: 200 },
      });
      expect(res.statusCode).toBe(400);
    });

    it("PUT rejects non-boolean enabled", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/admin/player/settings/sonos",
        headers: { authorization: `Bearer ${token}` },
        payload: { enabled: "yes" },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
