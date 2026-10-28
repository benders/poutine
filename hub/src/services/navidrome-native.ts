/**
 * navidrome-native.ts
 *
 * Runtime provisioning of Navidrome player records via Navidrome's NATIVE web
 * API (not Subsonic). Flips `reportRealPath=true` on the player records the hub
 * uses to read its local library, so Subsonic `song.path` comes back as a real
 * on-disk path (e.g. "/music/Artist/Album/01 - Track.mp3") instead of the
 * tag-derived virtual path Navidrome reports by default.
 *
 * Why this exists: `reportRealPath` is a per-player setting pinned into the
 * player record when that (user, client, user-agent) tuple first appears. The
 * global ND_SUBSONIC_DEFAULTREPORTREALPATH default never reaches an existing
 * player, so instead we provision the flag directly at runtime.
 *
 * IMPORTANT: the native `/auth/login` + `/api/player` API is UNVERSIONED and
 * internal to Navidrome — it can change or vanish across Navidrome releases.
 * This service is therefore DELIBERATELY best-effort and LOCAL-ONLY: it is only
 * ever pointed at the hub's own bundled Navidrome and never crosses federation.
 * Every failure path is non-fatal (warn + return). Breakage degrades gracefully
 * to virtual paths, observable as a drop in the folder audit report's path
 * coverage percentage (services see this via runFolderAudit → coverage[]).
 */

import { USER_AGENT } from "../version.js";

// Client names whose player records must report real paths. Matched by `client`
// ONLY — the player identity Navidrome keys on is (user, client, user-agent),
// and the UA differs by HTTP stack (sync uses global fetch, the proxy strips
// the caller's UA), so client name is the only stable key.
const REAL_PATH_CLIENTS = new Set(["poutine-sync", "poutine-proxy"]);

// Cap every native call so a hung/broken Navidrome never stalls a sync tick.
const NATIVE_TIMEOUT_MS = 10_000;

export interface NativeLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

interface NativePlayer {
  id: string;
  client?: string;
  reportRealPath?: boolean;
  [key: string]: unknown;
}

// One warning per process for a permanently-broken native API, so a broken
// endpoint doesn't spam a line every sync tick. Info-level per-flip logs still
// fire normally.
let warnedOnce = false;

function warnDegraded(log: NativeLogger, detail: string): void {
  if (warnedOnce) return;
  warnedOnce = true;
  log.warn(
    `navidrome-native: provisioning failed (${detail}); real-path player ` +
      `provisioning skipped — song paths degrade to virtual, folder-report ` +
      `path coverage will drop. This warning is logged once per process.`,
  );
}

// Reset the once-per-process guard. Test-only.
export function _resetWarnedOnce(): void {
  warnedOnce = false;
}

async function login(
  navidromeUrl: string,
  username: string,
  password: string,
): Promise<string | null> {
  const res = await fetch(`${navidromeUrl.replace(/\/+$/, "")}/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(NATIVE_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { token?: unknown };
  return typeof body.token === "string" ? body.token : null;
}

async function listPlayers(
  navidromeUrl: string,
  token: string,
): Promise<NativePlayer[] | null> {
  const res = await fetch(
    `${navidromeUrl.replace(/\/+$/, "")}/api/player?_start=0&_end=200`,
    {
      headers: {
        "x-nd-authorization": `Bearer ${token}`,
        "user-agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(NATIVE_TIMEOUT_MS),
    },
  );
  if (!res.ok) return null;
  const body = await res.json();
  return Array.isArray(body) ? (body as NativePlayer[]) : null;
}

async function updatePlayer(
  navidromeUrl: string,
  token: string,
  record: NativePlayer,
): Promise<boolean> {
  const res = await fetch(
    `${navidromeUrl.replace(/\/+$/, "")}/api/player/${encodeURIComponent(record.id)}`,
    {
      method: "PUT",
      headers: {
        "x-nd-authorization": `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      // Navidrome's native PUT expects the FULL record; spread it and override
      // only reportRealPath.
      body: JSON.stringify({ ...record, reportRealPath: true }),
      signal: AbortSignal.timeout(NATIVE_TIMEOUT_MS),
    },
  );
  return res.ok;
}

/**
 * Ensure the poutine-sync and poutine-proxy player records report real on-disk
 * paths. Best-effort: any failure logs a single warning (once per process) and
 * returns normally — never throws. A fresh login token is fetched per call
 * (calls are ~hourly; no caching).
 */
export async function ensureRealPathPlayers(opts: {
  navidromeUrl: string;
  navidromeUsername: string;
  navidromePassword: string;
  log: NativeLogger;
}): Promise<void> {
  const { navidromeUrl, navidromeUsername, navidromePassword, log } = opts;
  try {
    const token = await login(navidromeUrl, navidromeUsername, navidromePassword);
    if (!token) {
      warnDegraded(log, "login returned no token");
      return;
    }

    const players = await listPlayers(navidromeUrl, token);
    if (!players) {
      warnDegraded(log, "player list unavailable or malformed");
      return;
    }

    for (const player of players) {
      if (!player.client || !REAL_PATH_CLIENTS.has(player.client)) continue;
      if (player.reportRealPath === true) continue;
      const ok = await updatePlayer(navidromeUrl, token, player);
      if (ok) {
        log.info(
          `navidrome-native: enabled reportRealPath on player ${player.id} (client=${player.client})`,
        );
      } else {
        warnDegraded(log, `PUT player ${player.id} failed`);
      }
    }
  } catch (err) {
    warnDegraded(log, String(err));
  }
}

// ── Scanner config drift check (#296, #297) ─────────────────────────────────
//
// Navidrome silently ignores unknown or renamed ND_* env vars: compose set
// `ND_SCANSCHEDULE` for months while no periodic scan ever ran. So the hub
// reads the *effective* config back (`GET /api/config/`, admin-only, same
// unversioned native API — the trailing slash is required) and warns when the
// scanner settings Poutine depends on aren't in force.

export interface ScannerConfig {
  /** Robfig cron expression; "" or "0" means periodic scanning is off. */
  schedule: string;
  purgeMissing: string;
}

/** Last successful read, for the admin UI. Null until one succeeds. */
let lastScannerConfig: ScannerConfig | null = null;
/** Warnings already logged this process — one line per distinct problem. */
const scannerWarnings = new Set<string>();

export function getLastScannerConfig(): ScannerConfig | null {
  return lastScannerConfig;
}

// Reset module state. Test-only.
export function _resetScannerConfigState(): void {
  lastScannerConfig = null;
  scannerWarnings.clear();
}

/** Problems with an effective scanner config; empty when it is as intended. */
export function scannerConfigProblems(cfg: ScannerConfig): string[] {
  const problems: string[] = [];
  if (cfg.schedule === "" || cfg.schedule === "0") {
    problems.push(
      "periodic scan is DISABLED (Scanner.Schedule unset) — new music is only " +
        "picked up by the filesystem watcher, which sees nothing on SMB/NFS. " +
        "Set ND_SCANNER_SCHEDULE (docker-compose.yml, #296)",
    );
  }
  if (cfg.purgeMissing !== "never") {
    problems.push(
      `Scanner.PurgeMissing is "${cfg.purgeMissing}" — an unmounted share or one ` +
        "unreadable top-level folder purges the whole library and re-IDs tracks " +
        "on recovery. Set ND_SCANNER_PURGEMISSING=never (#297)",
    );
  }
  return problems;
}

/**
 * Read Navidrome's effective scanner config and warn (once per process per
 * problem) when it drifts from what Poutine expects. Best-effort like the
 * rest of this file: never throws, returns null when the API is unavailable.
 */
export async function checkScannerConfig(opts: {
  navidromeUrl: string;
  navidromeUsername: string;
  navidromePassword: string;
  log: NativeLogger;
}): Promise<ScannerConfig | null> {
  const { navidromeUrl, navidromeUsername, navidromePassword, log } = opts;
  try {
    const token = await login(navidromeUrl, navidromeUsername, navidromePassword);
    if (!token) return null;
    const res = await fetch(`${navidromeUrl.replace(/\/+$/, "")}/api/config/`, {
      headers: {
        "x-nd-authorization": `Bearer ${token}`,
        "user-agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(NATIVE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    // The body carries Navidrome's whole config (some secrets masked, some
    // not) — read the two scanner fields and drop the rest; never log it.
    const body = (await res.json()) as {
      config?: { Scanner?: { Schedule?: unknown; PurgeMissing?: unknown } };
    };
    const scanner = body.config?.Scanner;
    if (!scanner || typeof scanner.PurgeMissing !== "string") return null;
    const cfg: ScannerConfig = {
      schedule: typeof scanner.Schedule === "string" ? scanner.Schedule : "",
      purgeMissing: scanner.PurgeMissing,
    };
    lastScannerConfig = cfg;
    for (const problem of scannerConfigProblems(cfg)) {
      if (scannerWarnings.has(problem)) continue;
      scannerWarnings.add(problem);
      log.warn(`navidrome-native: ${problem}`);
    }
    return cfg;
  } catch {
    return null;
  }
}
