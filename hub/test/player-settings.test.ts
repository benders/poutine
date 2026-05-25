import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  createPlayerSettings,
  generateDlnaUuid,
  generateCastSecret,
  PLAYER_SETTINGS_KEYS,
} from "../src/services/player-settings.js";
import { createPlayerDatabase } from "../src/db/player-db.js";

function freshDb() {
  return createPlayerDatabase(":memory:");
}

describe("player-settings (#215)", () => {
  describe("getDlnaUuid", () => {
    it("invokes fallback on first call and persists the result", () => {
      const db = freshDb();
      const ps = createPlayerSettings(db);
      let calls = 0;
      const fallback = () => {
        calls += 1;
        return "11111111-2222-3333-4444-555555555555";
      };
      const v1 = ps.getDlnaUuid(fallback);
      const v2 = ps.getDlnaUuid(fallback);
      expect(v1).toBe("11111111-2222-3333-4444-555555555555");
      expect(v2).toBe(v1);
      expect(calls).toBe(1);
      const row = db
        .prepare("SELECT value FROM player_settings WHERE key = ?")
        .get(PLAYER_SETTINGS_KEYS.DLNA_UUID) as { value: string } | undefined;
      expect(row?.value).toBe(v1);
    });

    it("returns the persisted value without consulting the fallback", () => {
      const db = freshDb();
      db.prepare(
        "INSERT INTO player_settings (key, value) VALUES (?, ?)",
      ).run(PLAYER_SETTINGS_KEYS.DLNA_UUID, "preset-uuid");
      const ps = createPlayerSettings(db);
      const v = ps.getDlnaUuid(() => {
        throw new Error("fallback must not run");
      });
      expect(v).toBe("preset-uuid");
    });
  });

  describe("getCastSecret", () => {
    it("invokes fallback on first call and persists the result", () => {
      const db = freshDb();
      const ps = createPlayerSettings(db);
      const secret = Buffer.from("a".repeat(32), "utf8");
      let calls = 0;
      const fallback = () => {
        calls += 1;
        return secret;
      };
      const v1 = ps.getCastSecret(fallback);
      const v2 = ps.getCastSecret(fallback);
      expect(v1.equals(secret)).toBe(true);
      expect(v2.equals(secret)).toBe(true);
      expect(calls).toBe(1);
    });

    it("round-trips arbitrary bytes through base64 storage", () => {
      const db = freshDb();
      const ps = createPlayerSettings(db);
      const random = generateCastSecret();
      const stored = ps.getCastSecret(() => random);
      expect(stored.equals(random)).toBe(true);

      // Re-open through a fresh settings handle to bypass any caching.
      const ps2 = createPlayerSettings(db);
      const reread = ps2.getCastSecret(() => {
        throw new Error("must not derive on re-read");
      });
      expect(reread.equals(random)).toBe(true);
    });
  });

  describe("migrateFromHubSettings (#217)", () => {
    function hubDbWithSettings(rows: Record<string, string>): Database.Database {
      const db = new Database(":memory:");
      db.exec(
        "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
      for (const [k, v] of Object.entries(rows)) stmt.run(k, v);
      return db;
    }

    it("copies all migrated keys when player.db is empty", () => {
      const playerDb = freshDb();
      const ps = createPlayerSettings(playerDb);
      const hubDb = hubDbWithSettings({
        sonos_enabled: "true",
        sonos_volume_cap: "33",
        lan_url: "http://hub.lan:3000",
        // unrelated row should be ignored
        activity_history_max_events: "5000",
      });
      const copied = ps.migrateFromHubSettings(hubDb);
      expect(copied.sort()).toEqual(
        ["lan_url", "sonos_enabled", "sonos_volume_cap"].sort(),
      );
      expect(ps.getRaw("sonos_enabled")).toBe("true");
      expect(ps.getRaw("sonos_volume_cap")).toBe("33");
      expect(ps.getRaw("lan_url")).toBe("http://hub.lan:3000");
      expect(ps.getRaw("activity_history_max_events")).toBeUndefined();
    });

    it("is idempotent — second run copies nothing", () => {
      const playerDb = freshDb();
      const ps = createPlayerSettings(playerDb);
      const hubDb = hubDbWithSettings({ lan_url: "http://hub.lan:3000" });
      ps.migrateFromHubSettings(hubDb);
      const second = ps.migrateFromHubSettings(hubDb);
      expect(second).toEqual([]);
    });

    it("never overwrites an existing player.db value", () => {
      const playerDb = freshDb();
      const ps = createPlayerSettings(playerDb);
      ps.setRaw("lan_url", "http://operator.lan:3000");
      const hubDb = hubDbWithSettings({ lan_url: "http://stale.lan" });
      const copied = ps.migrateFromHubSettings(hubDb);
      expect(copied).toEqual([]);
      expect(ps.getRaw("lan_url")).toBe("http://operator.lan:3000");
    });

    it("tolerates absence of hub.db settings table (fresh install)", () => {
      const playerDb = freshDb();
      const ps = createPlayerSettings(playerDb);
      const empty = new Database(":memory:");
      const copied = ps.migrateFromHubSettings(empty);
      expect(copied).toEqual([]);
    });
  });

  describe("generateDlnaUuid", () => {
    it("emits an RFC 4122 v4 UUID", () => {
      const u = generateDlnaUuid();
      expect(u).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it("produces unique values across calls", () => {
      const a = generateDlnaUuid();
      const b = generateDlnaUuid();
      expect(a).not.toBe(b);
    });
  });
});
