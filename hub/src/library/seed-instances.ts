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

  // Seed the local Navidrome instance
  db.prepare(
    `INSERT OR IGNORE INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status)
     VALUES ('local', 'Local Navidrome', ?, 'subsonic', '', ?, 'online')`,
  ).run(config.navidromeUrl, ownerId);

  // Seed one row per peer
  for (const peer of peerRegistry.peers.values()) {
    db.prepare(
      `INSERT OR IGNORE INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status)
       VALUES (?, ?, ?, 'subsonic', '', ?, 'online')`,
    ).run(peer.id, peer.id, peer.url, ownerId);
  }
}
