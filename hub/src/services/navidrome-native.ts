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
