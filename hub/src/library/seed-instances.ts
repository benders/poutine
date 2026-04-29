import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import type { PeerRegistry } from "../federation/peers.js";

/**
 * Ensure synthetic `instances` rows exist for the local Navidrome and each
 * known peer. Uses INSERT OR IGNORE so it's safe to call multiple times.
 *
 * The `instances.owner_id` FK requires a real user row. We pick the first user
 * in the table, creating a `__system__` placeholder if none exist yet.
 *
 * TODO Phase 5: this workaround is removed when the `instances` FK is cleaned up.
 */
export function seedSyntheticInstances(
  db: Database.Database,
  config: Config,
  peerRegistry: PeerRegistry,
): void {
  // Resolve (or create) the owner
  const firstUser = db
    .prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1")
    .get() as { id: string } | undefined;

  let ownerId: string;
  if (firstUser) {
    ownerId = firstUser.id;
  } else {
    // No users yet — insert a system placeholder so the FK is satisfied
    ownerId = randomUUID();
    console.warn(
      "[seed-instances] No users found; creating __system__ placeholder user. " +
        "Register a real user to replace this.",
    );
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, password_enc, is_admin) VALUES (?, '__system__', '', 0)`,
    ).run(ownerId);
  }

  const nextFolderId = (): number => {
    const row = db
      .prepare("SELECT COALESCE(MAX(musicfolder_id), 0) + 1 AS next FROM instances")
      .get() as { next: number };
    return row.next;
  };

  // Seed the local instance. User-facing name is "Local" — Navidrome is an
  // internal implementation detail and must not leak into the SPA / Subsonic
  // clients.
  db.prepare(
    `INSERT OR IGNORE INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status, musicfolder_id)
     VALUES ('local', 'Local', ?, 'subsonic', '', ?, 'online', ?)`,
  ).run(config.navidromeUrl, ownerId, nextFolderId());
  // Rename pre-existing "Local Navidrome" rows from earlier seeds.
  db.prepare(
    `UPDATE instances SET name = 'Local' WHERE id = 'local' AND name = 'Local Navidrome'`,
  ).run();

  // Seed one row per peer
  for (const peer of peerRegistry.peers.values()) {
    db.prepare(
      `INSERT OR IGNORE INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status, musicfolder_id)
       VALUES (?, ?, ?, 'subsonic', '', ?, 'online', ?)`,
    ).run(peer.id, peer.name, peer.url, ownerId, nextFolderId());
    // Refresh name on subsequent reloads so YAML edits or improved defaults
    // (e.g. URL-host fallback) propagate to MusicFolder labels.
    db.prepare(
      `UPDATE instances SET name = ? WHERE id = ?`,
    ).run(peer.name, peer.id);
  }
}
