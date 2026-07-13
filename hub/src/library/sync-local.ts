/**
 * sync-local.ts
 *
 * Syncs the bundled local Navidrome into instance_* tables via the unified
 * readNavidromeViaProxy path. Uses a ProxyFetch that hits Navidrome directly
 * with Subsonic t+s creds (no signing, no proxy auth).
 */

import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { readNavidromeViaProxy, createLocalProxyFetch } from "./sync-instance.js";
import type { SyncResult } from "./sync.js";
import { ensureRealPathPlayers } from "../services/navidrome-native.js";
import type { LastFmClient } from "../services/lastfm.js";
import type { FanartTvClient } from "../services/fanarttv.js";

export async function syncLocal(
  db: Database.Database,
  config: Config,
  lastFmClient?: LastFmClient | null,
  fanartTvClient?: FanartTvClient | null,
): Promise<SyncResult> {
  const proxyFetch = createLocalProxyFetch({
    proxyBaseUrl: config.navidromeUrl,
    navidromeUsername: config.navidromeUsername,
    navidromePassword: config.navidromePassword,
  });

  // Close the virtual-path window for local sync before reading albums:
  //   1. Ping through the SAME proxyFetch the album reads use, so Navidrome
  //      lazily creates the poutine-sync player record with the exact
  //      (user, client, user-agent) tuple this sync will present. Response is
  //      ignored; a failure here is tolerated (provisioning below no-ops).
  //   2. Provision reportRealPath=true on that record via the native API, so
  //      the album fetches that follow get real on-disk paths.
  try {
    await proxyFetch("/rest/ping");
  } catch {
    // Navidrome unreachable — readNavidromeViaProxy below reports the failure.
  }
  await ensureRealPathPlayers({
    navidromeUrl: config.navidromeUrl,
    navidromeUsername: config.navidromeUsername,
    navidromePassword: config.navidromePassword,
    log: {
      info: (msg) => console.log(msg),
      warn: (msg) => console.warn(msg),
    },
  });

  return readNavidromeViaProxy(db, "local", proxyFetch, {
    concurrency: config.instanceConcurrency,
    lastFmClient: lastFmClient ?? null,
    fanartTvClient: fanartTvClient ?? null,
    log: {
      info: (msg) => console.log(msg),
      error: (msg) => console.error(msg),
    },
  });
}
