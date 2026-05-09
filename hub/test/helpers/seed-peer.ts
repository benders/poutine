// Test helper: seed a peer row directly into the `instances` table.
//
// Replaces the v0.4.x pattern of writing a `peers.yaml` file before
// buildApp(). Under federation v5 (#147) the DB is authoritative; tests that
// previously injected peers via YAML now seed the row + reload the registry.

import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";

export interface SeedPeerInput {
  id: string;
  url: string;
  publicKeySpec: string; // "ed25519:<base64>"
  name?: string;
}

export function seedPeerRow(db: Database.Database, peer: SeedPeerInput): void {
  const owner = db.prepare("SELECT id FROM users LIMIT 1").get() as
    | { id: string }
    | undefined;
  if (!owner) {
    throw new Error(
      "seedPeerRow: no users in DB; buildApp() should have created the __system__ placeholder",
    );
  }
  const next = (
    db
      .prepare(
        "SELECT COALESCE(MAX(musicfolder_id), 0) + 1 AS next FROM instances",
      )
      .get() as { next: number }
  ).next;
  const url = peer.url.replace(/\/+$/, "");
  db.prepare(
    `INSERT INTO instances
       (id, name, url, adapter_type, encrypted_credentials, owner_id, status, musicfolder_id, public_key)
     VALUES (?, ?, ?, 'subsonic', '', ?, 'online', ?, ?)`,
  ).run(peer.id, peer.name ?? peer.id, url, owner.id, next, peer.publicKeySpec);
}

export function seedPeer(
  app: FastifyInstance,
  peer: SeedPeerInput,
): void {
  seedPeerRow(app.db, peer);
  app.peerRegistry.reload();
}
