/**
 * sync-local.ts
 *
 * Syncs the bundled local Navidrome into instance_* tables.
 *
 * Currently reads Navidrome directly via SubsonicClient (bypasses /proxy/*).
 * TODO(phase-5): Route local reads through /proxy/* for uniformity. Requires
 *   the hub URL to be available in config (add HUB_URL env var or derive from
 *   PORT/HOST) so SubsonicClient can target http://localhost:{port}/proxy.
 */

import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { SubsonicClient } from "../adapters/subsonic.js";
import { syncInstance } from "./sync.js";
import type { SyncResult, Instance } from "./sync.js";

export async function syncLocal(
  db: Database.Database,
  config: Config,
): Promise<SyncResult> {
  const client = new SubsonicClient({
    url: config.navidromeUrl,
    username: config.navidromeUsername,
    password: config.navidromePassword,
  });

  // Synthetic Instance-like object representing the bundled local Navidrome.
  // The id 'local' matches the row seeded by seedSyntheticInstances.
  const instance: Instance = {
    id: "local",
    name: "Local Navidrome",
    url: config.navidromeUrl,
    adapterType: "subsonic",
    ownerId: "",
    status: "online",
    lastSeen: null,
    lastSyncedAt: null,
    trackCount: 0,
    serverVersion: null,
    createdAt: "",
    updatedAt: "",
  };

  return syncInstance(db, instance, client, {
    concurrency: config.instanceConcurrency,
  });
}
