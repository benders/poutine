import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase } from "../src/db/client.js";
import { pruneOrphanInstances } from "../src/library/prune-instances.js";
import type { PeerRegistry, Peer } from "../src/federation/peers.js";

function makeRegistry(peerIds: string[]): PeerRegistry {
  const peers = new Map<string, Peer>();
  for (const id of peerIds) {
    peers.set(id, {
      id,
      url: `https://${id}.example`,
      proxyUrl: `https://${id}.example`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publicKey: {} as any,
      publicKeySpec: "ed25519:fake",
    });
  }
  return {
    instanceId: "self",
    peers,
    reload: () => {},
  };
}

describe("pruneOrphanInstances", () => {
  let db: Database.Database;
  let ownerId: string;

  beforeEach(() => {
    db = createDatabase(":memory:");
    ownerId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, ?)",
    ).run(ownerId, "admin", "fakehash", 1);

    const insert = db.prepare(
      "INSERT INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status) VALUES (?, ?, ?, 'subsonic', '', ?, 'online')",
    );
    insert.run("local", "Local", "http://localhost", ownerId);
    insert.run("peer-a", "Peer A", "https://a.example", ownerId);
    insert.run("peer-b", "Peer B", "https://b.example", ownerId);
    insert.run("peer-gone", "Gone", "https://gone.example", ownerId);
  });

  afterEach(() => {
    db.close();
  });

  it("removes instances not present in peer registry, preserving local", () => {
    const registry = makeRegistry(["peer-a", "peer-b"]);
    const result = pruneOrphanInstances(db, registry);

    expect(result.removed.sort()).toEqual(["peer-gone"]);
    const ids = (
      db.prepare("SELECT id FROM instances ORDER BY id").all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(ids).toEqual(["local", "peer-a", "peer-b"]);
  });

  it("cascades deletes of instance_* data for removed peers", () => {
    db.prepare(
      "INSERT INTO instance_artists (id, instance_id, remote_id, name, album_count) VALUES (?, ?, ?, ?, ?)",
    ).run("peer-gone:a1", "peer-gone", "a1", "Ghost", 0);

    const registry = makeRegistry(["peer-a", "peer-b"]);
    pruneOrphanInstances(db, registry);

    const remaining = db
      .prepare("SELECT COUNT(*) AS c FROM instance_artists WHERE instance_id = ?")
      .get("peer-gone") as { c: number };
    expect(remaining.c).toBe(0);
  });

  it("is a no-op when all instances are allowed", () => {
    const registry = makeRegistry(["peer-a", "peer-b", "peer-gone"]);
    const result = pruneOrphanInstances(db, registry);
    expect(result.removed).toEqual([]);
    const count = db.prepare("SELECT COUNT(*) AS c FROM instances").get() as { c: number };
    expect(count.c).toBe(4);
  });
});
