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
import type { LastFmClient } from "../services/lastfm.js";

export async function syncLocal(
  db: Database.Database,
  config: Config,
  lastFmClient?: LastFmClient | null,
): Promise<SyncResult> {
  const proxyFetch = createLocalProxyFetch({
    proxyBaseUrl: config.navidromeUrl,
    navidromeUsername: config.navidromeUsername,
    navidromePassword: config.navidromePassword,
  });

  return readNavidromeViaProxy(db, "local", proxyFetch, {
    concurrency: config.instanceConcurrency,
    lastFmClient: lastFmClient ?? null,
    log: {
      info: (msg) => console.log(msg),
      error: (msg) => console.error(msg),
    },
  });
}
