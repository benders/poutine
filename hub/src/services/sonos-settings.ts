import type Database from "better-sqlite3";

/**
 * Runtime, DB-backed Sonos configuration (issue #184). Sonos used to be
 * an env-only opt-in; admins now toggle it from the admin UI. Both the
 * enabled flag and the volume cap live in the `settings` table so they
 * survive restarts without redeploying with a new env file.
 *
 * The service is a thin cache over `settings`: every getter reads through
 * to SQLite (cheap — same DB the request handler already touched). The
 * server side wires `onChange` to start/stop SSDP discovery and Stop any
 * active casts when the operator disables Sonos.
 */

export const SONOS_ENABLED_KEY = "sonos_enabled";
export const SONOS_VOLUME_CAP_KEY = "sonos_volume_cap";

/** Default cap when nothing is persisted. Conservative — see comment in
 *  setVolume on sonos-control.ts. */
export const SONOS_VOLUME_CAP_DEFAULT = 50;

export interface SonosSettings {
  getEnabled(): boolean;
  setEnabled(value: boolean): void;
  getVolumeCap(): number;
  setVolumeCap(value: number): void;
  onChange(listener: (snapshot: { enabled: boolean; volumeCap: number }) => void): void;
}

export interface SonosSettingsOptions {
  /** First-boot default for `enabled` when no row exists yet. */
  initialEnabled?: boolean;
  /** First-boot default for `volumeCap`. */
  initialVolumeCap?: number;
}

export function createSonosSettings(
  db: Database.Database,
  opts: SonosSettingsOptions = {},
): SonosSettings {
  const seedEnabled = opts.initialEnabled ?? false;
  const seedCap = clampCap(opts.initialVolumeCap ?? SONOS_VOLUME_CAP_DEFAULT);

  // Seed defaults if the keys are absent. INSERT OR IGNORE so an existing
  // operator-set value never gets overwritten by a redeploy.
  const insert = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
  );
  insert.run(SONOS_ENABLED_KEY, seedEnabled ? "true" : "false");
  insert.run(SONOS_VOLUME_CAP_KEY, String(seedCap));

  const readStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
  const writeStmt = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  const listeners: Array<(s: { enabled: boolean; volumeCap: number }) => void> =
    [];

  const getEnabled = (): boolean => {
    const row = readStmt.get(SONOS_ENABLED_KEY) as { value: string } | undefined;
    return row?.value === "true";
  };

  const getVolumeCap = (): number => {
    const row = readStmt.get(SONOS_VOLUME_CAP_KEY) as
      | { value: string }
      | undefined;
    if (!row) return SONOS_VOLUME_CAP_DEFAULT;
    const n = parseInt(row.value, 10);
    return Number.isFinite(n) ? clampCap(n) : SONOS_VOLUME_CAP_DEFAULT;
  };

  const emit = () => {
    const snapshot = { enabled: getEnabled(), volumeCap: getVolumeCap() };
    for (const fn of listeners) {
      try {
        fn(snapshot);
      } catch {
        // listener errors must not block the toggle
      }
    }
  };

  return {
    getEnabled,
    setEnabled(value: boolean) {
      writeStmt.run(SONOS_ENABLED_KEY, value ? "true" : "false");
      emit();
    },
    getVolumeCap,
    setVolumeCap(value: number) {
      writeStmt.run(SONOS_VOLUME_CAP_KEY, String(clampCap(value)));
      emit();
    },
    onChange(listener) {
      listeners.push(listener);
    },
  };
}

function clampCap(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
