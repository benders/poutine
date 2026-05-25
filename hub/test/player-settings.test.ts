import { describe, it, expect } from "vitest";
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
