/**
 * sync-local.ts
 *
 * Syncs the bundled local Navidrome into instance_* tables.
 * Reads Navidrome directly via SubsonicClient (bypasses /proxy/*).
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
