import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";

/**
 * Player-owned settings.
 *
 * Phase 1 (#215) introduced this module for the two values that must
 * survive restarts and belong unambiguously to Player BE:
 *
 *   - DLNA server UUID (UDN)        — see `getDlnaUuid()`
 *   - Cast token HMAC signing key   — see `getCastSecret()`
 *
 * Phase 3 (#217) extended it to cover the rest of Player-owned runtime
 * configuration that previously lived in hub.db's `settings` table:
 *
 *   - sonos_enabled, sonos_volume_cap, lan_url
 *   - dlna_enabled, dlna_friendly_name (newly persisted; were env-only)
 *
 * Storage lives in `player.db` (separate from `hub.db`). Reads go straight
 * to SQLite — the working set is a handful of rows, no caching needed.
 *
 * Transitional dual-read:
 *
 *   - `getDlnaUuid`/`getCastSecret` accept a `fallback` thunk so existing
 *     installs keep their derived values on first boot under the new code.
 *   - `migrateFromHubSettings()` is called once at boot to copy any
 *     Player-owned rows out of hub.db's `settings` into `player.db`. After
 *     this runs, reads + writes for those keys go through `player.db`
 *     only. The hub.db rows are intentionally left in place — the admin
 *     SPA legacy callers still reference them and they're cleaned up in a
 *     later phase. The source of truth has moved; the leftover rows are
 *     just dead data.
 */

const DLNA_UUID_KEY = "dlna_uuid";
const CAST_SIGNING_KEY_KEY = "cast_signing_key";

// Phase 3 keys — same key names as the historical hub.db rows so log
// dumps and forensics are easy to follow. These are also the keys the
// migration step copies across.
const SONOS_ENABLED_KEY = "sonos_enabled";
const SONOS_VOLUME_CAP_KEY = "sonos_volume_cap";
const LAN_URL_KEY = "lan_url";
const DLNA_ENABLED_KEY = "dlna_enabled";
const DLNA_FRIENDLY_NAME_KEY = "dlna_friendly_name";
// #232: opt-in to let non-admin sessions drive `/api/sonos/*`. Default off —
// shared LAN hardware is admin-gated unless an operator explicitly opens it.
const SONOS_ALLOW_NON_ADMIN_KEY = "sonos_allow_non_admin";

/** All keys that get migrated from hub.db's `settings` table on first boot. */
const MIGRATED_KEYS = [
  SONOS_ENABLED_KEY,
  SONOS_VOLUME_CAP_KEY,
  LAN_URL_KEY,
  // dlna_enabled + dlna_friendly_name were env-var only previously, no
  // hub.db rows exist to migrate, but the keys live in the same bag.
] as const;

export interface PlayerSettings {
  /** Returns the DLNA UDN. Generates+persists on first call if missing. */
  getDlnaUuid(fallback: () => string): string;
  /** Returns the cast HMAC secret. Generates+persists on first call if missing. */
  getCastSecret(fallback: () => Buffer): Buffer;
  /** Low-level KV read. Returns `undefined` when no row exists. */
  getRaw(key: string): string | undefined;
  /** Low-level KV write (INSERT OR UPDATE). */
  setRaw(key: string, value: string): void;
  /** Low-level KV write that never overwrites an existing row (seed defaults). */
  seedRaw(key: string, value: string): void;
  /**
   * Idempotent one-shot copy from hub.db's `settings` table into
   * `player.db` for each Player-owned key. Existing values in `player.db`
   * are never overwritten — the migration is a strict "fill the gap".
   *
   * Returns the list of keys actually copied this call (empty after the
   * first successful migration).
   */
  migrateFromHubSettings(hubDb: Database.Database): string[];
}

export function createPlayerSettings(db: Database.Database): PlayerSettings {
  const readStmt = db.prepare(
    "SELECT value FROM player_settings WHERE key = ?",
  );
  const seedStmt = db.prepare(
    `INSERT INTO player_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO NOTHING`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO player_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  const readStr = (key: string): string | undefined => {
    const row = readStmt.get(key) as { value: string } | undefined;
    return row?.value;
  };

  return {
    getDlnaUuid(fallback) {
      const existing = readStr(DLNA_UUID_KEY);
      if (existing) return existing;
      const value = fallback();
      seedStmt.run(DLNA_UUID_KEY, value);
      // Re-read in case of a race: another writer beat us, theirs wins.
      return readStr(DLNA_UUID_KEY) ?? value;
    },

    getCastSecret(fallback) {
      const existing = readStr(CAST_SIGNING_KEY_KEY);
      if (existing) return Buffer.from(existing, "base64");
      const value = fallback();
      seedStmt.run(CAST_SIGNING_KEY_KEY, value.toString("base64"));
      const final = readStr(CAST_SIGNING_KEY_KEY);
      return final ? Buffer.from(final, "base64") : value;
    },

    getRaw(key) {
      return readStr(key);
    },

    setRaw(key, value) {
      upsertStmt.run(key, value);
    },

    seedRaw(key, value) {
      seedStmt.run(key, value);
    },

    migrateFromHubSettings(hubDb) {
      // The hub `settings` table predates player.db. If it doesn't exist
      // (fresh install on the new schema) we have nothing to copy.
      const hasTable = hubDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='settings'",
        )
        .get();
      if (!hasTable) return [];
      const hubRead = hubDb.prepare(
        "SELECT value FROM settings WHERE key = ?",
      );
      const copied: string[] = [];
      for (const key of MIGRATED_KEYS) {
        if (readStr(key) !== undefined) continue; // never overwrite player.db
        const row = hubRead.get(key) as { value: string } | undefined;
        if (row === undefined) continue;
        seedStmt.run(key, row.value);
        copied.push(key);
      }
      return copied;
    },
  };
}

/**
 * Generate a fresh random DLNA UDN. Used when no persisted value exists
 * and the caller has no deterministic fallback. Format matches RFC 4122
 * version-4 layout — UPnP only requires uniqueness, not a specific version.
 */
export function generateDlnaUuid(): string {
  const b = randomBytes(16);
  // Set version (4) and variant (RFC 4122) bits so the result is a valid v4 UUID.
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Generate a fresh random 32-byte HMAC secret for cast token signing. */
export function generateCastSecret(): Buffer {
  return randomBytes(32);
}

// Exposed for tests and for the Sonos/DLNA settings typed accessors in
// `services/sonos-settings.ts`.
export const PLAYER_SETTINGS_KEYS = {
  DLNA_UUID: DLNA_UUID_KEY,
  CAST_SIGNING_KEY: CAST_SIGNING_KEY_KEY,
  SONOS_ENABLED: SONOS_ENABLED_KEY,
  SONOS_VOLUME_CAP: SONOS_VOLUME_CAP_KEY,
  LAN_URL: LAN_URL_KEY,
  DLNA_ENABLED: DLNA_ENABLED_KEY,
  DLNA_FRIENDLY_NAME: DLNA_FRIENDLY_NAME_KEY,
  SONOS_ALLOW_NON_ADMIN: SONOS_ALLOW_NON_ADMIN_KEY,
} as const;

export const PLAYER_SETTINGS_MIGRATED_KEYS = MIGRATED_KEYS;
