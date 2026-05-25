import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";

/**
 * Player-owned settings (issue #215, Phase 1 of #212).
 *
 * Holds the two values that must persist across restarts and belong to
 * Player BE:
 *
 *   - DLNA server UUID (UDN)        — see `getDlnaUuid()`
 *   - Cast token HMAC signing key   — see `getCastSecret()`
 *
 * Storage lives in `player.db` (separate from `hub.db`). Reads go straight
 * to SQLite — the working set is two rows, no caching needed.
 *
 * Transitional dual-read: both getters accept a `fallback` thunk. If the
 * key is absent in `player.db`, the fallback is invoked once, the result
 * is persisted, and subsequent reads come from `player.db`. This lets us
 * keep the existing derivation (DLNA UUID via SHA1 of `POUTINE_INSTANCE_ID`;
 * cast secret via HMAC over the Ed25519 private key) without a flag day —
 * upgrades migrate silently on first boot.
 */

const DLNA_UUID_KEY = "dlna_uuid";
const CAST_SIGNING_KEY_KEY = "cast_signing_key";

export interface PlayerSettings {
  /** Returns the DLNA UDN. Generates+persists on first call if missing. */
  getDlnaUuid(fallback: () => string): string;
  /** Returns the cast HMAC secret. Generates+persists on first call if missing. */
  getCastSecret(fallback: () => Buffer): Buffer;
}

export function createPlayerSettings(db: Database.Database): PlayerSettings {
  const readStmt = db.prepare(
    "SELECT value FROM player_settings WHERE key = ?",
  );
  const writeStmt = db.prepare(
    `INSERT INTO player_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO NOTHING`,
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
      writeStmt.run(DLNA_UUID_KEY, value);
      // Re-read in case of a race: another writer beat us, theirs wins.
      return readStr(DLNA_UUID_KEY) ?? value;
    },

    getCastSecret(fallback) {
      const existing = readStr(CAST_SIGNING_KEY_KEY);
      if (existing) return Buffer.from(existing, "base64");
      const value = fallback();
      writeStmt.run(CAST_SIGNING_KEY_KEY, value.toString("base64"));
      const final = readStr(CAST_SIGNING_KEY_KEY);
      return final ? Buffer.from(final, "base64") : value;
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

// Exposed for tests / future Phase 3 migration.
export const PLAYER_SETTINGS_KEYS = {
  DLNA_UUID: DLNA_UUID_KEY,
  CAST_SIGNING_KEY: CAST_SIGNING_KEY_KEY,
} as const;
