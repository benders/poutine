import type { PlayerSettings } from "./player-settings.js";
import { PLAYER_SETTINGS_KEYS } from "./player-settings.js";

/**
 * Typed accessors for runtime Player settings (issue #184, #209, #217).
 *
 * Backing store: `player.db` via the `PlayerSettings` KV interface
 * (#217 moved this off hub.db's `settings` table). The module keeps its
 * historical "sonos-settings" name because consumers across routes and
 * tests already import it under that path; today it also covers DLNA
 * enable + friendly name now that those have left environment variables.
 *
 * Note on `lan_url` (#209): the LAN-reachable base URL is shared by Sonos
 * casting AND the DLNA MediaServer — both need devices on the LAN to be
 * able to fetch streams + the device description. It lives in the same
 * settings bag; the UI labels it generically and DLNA reads through the
 * same getter.
 *
 * Every getter reads through to SQLite. The server side wires `onChange`
 * to start/stop SSDP discovery and Stop any active casts when the
 * operator disables Sonos.
 */

export const SONOS_ENABLED_KEY = PLAYER_SETTINGS_KEYS.SONOS_ENABLED;
export const SONOS_VOLUME_CAP_KEY = PLAYER_SETTINGS_KEYS.SONOS_VOLUME_CAP;
export const LAN_URL_KEY = PLAYER_SETTINGS_KEYS.LAN_URL;
export const DLNA_ENABLED_KEY = PLAYER_SETTINGS_KEYS.DLNA_ENABLED;
export const DLNA_FRIENDLY_NAME_KEY = PLAYER_SETTINGS_KEYS.DLNA_FRIENDLY_NAME;

/** Default cap when nothing is persisted. Conservative — see comment in
 *  setVolume on sonos-control.ts. */
export const SONOS_VOLUME_CAP_DEFAULT = 50;

/** Default DLNA friendly name when nothing is persisted. */
export const DLNA_FRIENDLY_NAME_DEFAULT = "Poutine";

export interface SonosSettingsSnapshot {
  enabled: boolean;
  volumeCap: number;
  lanUrl: string;
  dlnaEnabled: boolean;
  dlnaFriendlyName: string;
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
  getDlnaEnabled(): boolean;
  setDlnaEnabled(value: boolean): void;
  getDlnaFriendlyName(): string;
  setDlnaFriendlyName(value: string): void;
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
  /** First-boot default for `dlnaEnabled` (was the `DLNA_ENABLED` env). */
  initialDlnaEnabled?: boolean;
  /** First-boot default for `dlnaFriendlyName` (was `DLNA_FRIENDLY_NAME`). */
  initialDlnaFriendlyName?: string;
}

export function createSonosSettings(
  settings: PlayerSettings,
  opts: SonosSettingsOptions = {},
): SonosSettings {
  const seedEnabled = opts.initialEnabled ?? false;
  const seedCap = clampCap(opts.initialVolumeCap ?? SONOS_VOLUME_CAP_DEFAULT);
  const seedLanUrl = normalizeLanUrl(opts.initialLanUrl ?? "");
  const seedDlnaEnabled = opts.initialDlnaEnabled ?? false;
  const seedDlnaFriendlyName =
    opts.initialDlnaFriendlyName?.trim() || DLNA_FRIENDLY_NAME_DEFAULT;

  // Seed defaults if absent. Never overwrite an existing value — operator
  // intent always wins over redeploy-time env defaults.
  settings.seedRaw(SONOS_ENABLED_KEY, seedEnabled ? "true" : "false");
  settings.seedRaw(SONOS_VOLUME_CAP_KEY, String(seedCap));
  settings.seedRaw(LAN_URL_KEY, seedLanUrl);
  settings.seedRaw(DLNA_ENABLED_KEY, seedDlnaEnabled ? "true" : "false");
  settings.seedRaw(DLNA_FRIENDLY_NAME_KEY, seedDlnaFriendlyName);

  const listeners: Array<(s: SonosSettingsSnapshot) => void> = [];

  const getEnabled = (): boolean =>
    settings.getRaw(SONOS_ENABLED_KEY) === "true";

  const getVolumeCap = (): number => {
    const raw = settings.getRaw(SONOS_VOLUME_CAP_KEY);
    if (raw === undefined) return SONOS_VOLUME_CAP_DEFAULT;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? clampCap(n) : SONOS_VOLUME_CAP_DEFAULT;
  };

  const getLanUrl = (): string => settings.getRaw(LAN_URL_KEY) ?? "";

  const getDlnaEnabled = (): boolean =>
    settings.getRaw(DLNA_ENABLED_KEY) === "true";

  const getDlnaFriendlyName = (): string => {
    const raw = settings.getRaw(DLNA_FRIENDLY_NAME_KEY);
    return raw && raw.trim() ? raw : DLNA_FRIENDLY_NAME_DEFAULT;
  };

  const snapshot = (): SonosSettingsSnapshot => ({
    enabled: getEnabled(),
    volumeCap: getVolumeCap(),
    lanUrl: getLanUrl(),
    dlnaEnabled: getDlnaEnabled(),
    dlnaFriendlyName: getDlnaFriendlyName(),
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
      settings.setRaw(SONOS_ENABLED_KEY, value ? "true" : "false");
      emit();
    },
    getVolumeCap,
    setVolumeCap(value: number) {
      settings.setRaw(SONOS_VOLUME_CAP_KEY, String(clampCap(value)));
      emit();
    },
    getLanUrl,
    setLanUrl(value: string) {
      settings.setRaw(LAN_URL_KEY, normalizeLanUrl(value));
      emit();
    },
    getDlnaEnabled,
    setDlnaEnabled(value: boolean) {
      settings.setRaw(DLNA_ENABLED_KEY, value ? "true" : "false");
      emit();
    },
    getDlnaFriendlyName,
    setDlnaFriendlyName(value: string) {
      const trimmed = value.trim() || DLNA_FRIENDLY_NAME_DEFAULT;
      settings.setRaw(DLNA_FRIENDLY_NAME_KEY, trimmed);
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
