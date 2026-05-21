import type Database from "better-sqlite3";

/**
 * Runtime, DB-backed Sonos configuration (issue #184). Sonos used to be
 * an env-only opt-in; admins now toggle it from the admin UI. The enabled
 * flag, volume cap, and LAN URL all live in the `settings` table so they
 * survive restarts without redeploying with a new env file.
 *
 * Note on `lan_url` (#209): the LAN-reachable base URL is shared by Sonos
 * casting AND the DLNA MediaServer — both need devices on the LAN to be
 * able to fetch streams + the device description. The setting lives under
 * the Sonos service for code-organization simplicity, but the UI labels it
 * generically and DLNA reads through the same getter.
 *
 * The service is a thin cache over `settings`: every getter reads through
 * to SQLite (cheap — same DB the request handler already touched). The
 * server side wires `onChange` to start/stop SSDP discovery and Stop any
 * active casts when the operator disables Sonos.
 */

export const SONOS_ENABLED_KEY = "sonos_enabled";
export const SONOS_VOLUME_CAP_KEY = "sonos_volume_cap";
export const LAN_URL_KEY = "lan_url";

/** Default cap when nothing is persisted. Conservative — see comment in
 *  setVolume on sonos-control.ts. */
export const SONOS_VOLUME_CAP_DEFAULT = 50;

export interface SonosSettingsSnapshot {
  enabled: boolean;
  volumeCap: number;
  lanUrl: string;
}

export interface SonosSettings {
  getEnabled(): boolean;
  setEnabled(value: boolean): void;
  getVolumeCap(): number;
  setVolumeCap(value: number): void;
  /** Absolute base URL Sonos + DLNA devices use to fetch streams. Empty
   *  string when unset. Always returned without a trailing slash. */
  getLanUrl(): string;
  /** Throws `Error` if `value` is non-empty and not a parseable http(s) URL. */
  setLanUrl(value: string): void;
  onChange(listener: (snapshot: SonosSettingsSnapshot) => void): void;
}

export interface SonosSettingsOptions {
  /** First-boot default for `enabled` when no row exists yet. */
  initialEnabled?: boolean;
  /** First-boot default for `volumeCap`. */
  initialVolumeCap?: number;
  /** First-boot default for `lanUrl`. Useful for tests + migration from
   *  the old `POUTINE_LAN_URL` env var on first boot. */
  initialLanUrl?: string;
}

export function createSonosSettings(
  db: Database.Database,
  opts: SonosSettingsOptions = {},
): SonosSettings {
  const seedEnabled = opts.initialEnabled ?? false;
  const seedCap = clampCap(opts.initialVolumeCap ?? SONOS_VOLUME_CAP_DEFAULT);
  const seedLanUrl = normalizeLanUrl(opts.initialLanUrl ?? "");

  // Seed defaults if the keys are absent. INSERT OR IGNORE so an existing
  // operator-set value never gets overwritten by a redeploy.
  const insert = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
  );
  insert.run(SONOS_ENABLED_KEY, seedEnabled ? "true" : "false");
  insert.run(SONOS_VOLUME_CAP_KEY, String(seedCap));
  insert.run(LAN_URL_KEY, seedLanUrl);

  const readStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
  const writeStmt = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  const listeners: Array<(s: SonosSettingsSnapshot) => void> = [];

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

  const getLanUrl = (): string => {
    const row = readStmt.get(LAN_URL_KEY) as { value: string } | undefined;
    return row?.value ?? "";
  };

  const snapshot = (): SonosSettingsSnapshot => ({
    enabled: getEnabled(),
    volumeCap: getVolumeCap(),
    lanUrl: getLanUrl(),
  });

  const emit = () => {
    const snap = snapshot();
    for (const fn of listeners) {
      try {
        fn(snap);
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
    getLanUrl,
    setLanUrl(value: string) {
      writeStmt.run(LAN_URL_KEY, normalizeLanUrl(value));
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

/**
 * Accepts empty string (unset) or an absolute http(s) URL. Strips trailing
 * slashes. Throws on anything else — admins setting garbage should see a
 * 400, not a silent "Sonos still doesn't work".
 *
 * Exported so the admin route can pre-validate without mutating state when
 * the same PUT also flips other fields.
 */
export function normalizeLanUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("lanUrl must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("lanUrl must use http or https");
  }
  // Strip trailing slashes so callers can concatenate `${base}/path` safely.
  return trimmed.replace(/\/+$/, "");
}
