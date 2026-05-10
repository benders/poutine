import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { loadPeerRegistry } from "../src/federation/peers.js";
import { loadOrCreatePrivateKey } from "../src/federation/signing.js";
import { createDatabase } from "../src/db/client.js";

function tmpPath(suffix = "") {
  return path.join(os.tmpdir(), `poutine-peers-${Date.now()}-${suffix}`);
}

function seedOwner(db: Database.Database): string {
  const id = "owner-1";
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_enc, is_admin) VALUES (?, 'system', '', 0)",
  ).run(id);
  return id;
}

function insertInstance(
  db: Database.Database,
  ownerId: string,
  row: { id: string; url: string; public_key: string | null },
) {
  db.prepare(
    `INSERT INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status, public_key)
     VALUES (?, ?, ?, 'subsonic', '', ?, 'online', ?)`,
  ).run(row.id, row.id, row.url, ownerId, row.public_key);
}

describe("loadPeerRegistry (DB-backed, federation v5)", () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = tmpPath("registry.db");
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(`${dbPath}-wal`)) fs.unlinkSync(`${dbPath}-wal`);
    if (fs.existsSync(`${dbPath}-shm`)) fs.unlinkSync(`${dbPath}-shm`);
  });

  it("returns empty registry when only the synthetic 'local' row exists", () => {
    const ownerId = seedOwner(db);
    insertInstance(db, ownerId, {
      id: "local",
      url: "http://navidrome:4533",
      public_key: null,
    });
    const registry = loadPeerRegistry(db, "fallback-id", "ed25519:test-self");
    expect(registry.instanceId).toBe("fallback-id");
    expect(registry.peers.size).toBe(0);
  });

  it("loads peers from the instances table", () => {
    const keyPath = tmpPath("peer-pub.pem");
    try {
      const { publicKeyBase64 } = loadOrCreatePrivateKey(keyPath);
      const ownerId = seedOwner(db);
      insertInstance(db, ownerId, {
        id: "test-bob",
        url: "https://bob.example",
        public_key: `ed25519:${publicKeyBase64}`,
      });

      const registry = loadPeerRegistry(db, "test-alice", "ed25519:test-self");
      expect(registry.peers.size).toBe(1);
      const bob = registry.peers.get("test-bob");
      expect(bob).toBeDefined();
      expect(bob!.url).toBe("https://bob.example");
      expect(bob!.publicKeySpec).toBe(`ed25519:${publicKeyBase64}`);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    }
  });

  it("skips a peer whose id matches the local instance id", () => {
    const keyPath = tmpPath("self.pem");
    try {
      const { publicKeyBase64 } = loadOrCreatePrivateKey(keyPath);
      const ownerId = seedOwner(db);
      insertInstance(db, ownerId, {
        id: "alice",
        url: "https://alice.example",
        public_key: `ed25519:${publicKeyBase64}`,
      });
      insertInstance(db, ownerId, {
        id: "bob",
        url: "https://bob.example",
        public_key: `ed25519:${publicKeyBase64}`,
      });

      const registry = loadPeerRegistry(db, "alice", "ed25519:test-self");
      expect(registry.peers.has("alice")).toBe(false);
      expect(registry.peers.has("bob")).toBe(true);
      expect(registry.peers.size).toBe(1);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    }
  });

  it("strips trailing slashes from peer URLs", () => {
    const keyPath = tmpPath("trailing-slash.pem");
    try {
      const { publicKeyBase64 } = loadOrCreatePrivateKey(keyPath);
      const ownerId = seedOwner(db);
      insertInstance(db, ownerId, {
        id: "bob",
        url: "https://bob.example///",
        public_key: `ed25519:${publicKeyBase64}`,
      });
      const registry = loadPeerRegistry(db, "alice", "ed25519:test-self");
      const bob = registry.peers.get("bob");
      expect(bob!.url).toBe("https://bob.example");
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    }
  });

  it("drops a peer with an invalid public_key and loads the rest", () => {
    const keyPath = tmpPath("mixed.pem");
    try {
      const { publicKeyBase64 } = loadOrCreatePrivateKey(keyPath);
      const ownerId = seedOwner(db);
      insertInstance(db, ownerId, {
        id: "bad-peer",
        url: "https://bad.example",
        public_key: "ed25519:notvalidbase64!!!!",
      });
      insertInstance(db, ownerId, {
        id: "good-peer",
        url: "https://good.example",
        public_key: `ed25519:${publicKeyBase64}`,
      });

      const registry = loadPeerRegistry(db, "fallback", "ed25519:test-self");
      expect(registry.peers.has("bad-peer")).toBe(false);
      expect(registry.peers.has("good-peer")).toBe(true);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    }
  });

  it("excludes rows where public_key is NULL", () => {
    const ownerId = seedOwner(db);
    insertInstance(db, ownerId, {
      id: "no-key",
      url: "https://nokey.example",
      public_key: null,
    });
    const registry = loadPeerRegistry(db, "alice", "ed25519:test-self");
    expect(registry.peers.size).toBe(0);
  });

  it("reload() picks up newly inserted instance rows", () => {
    const keyPath = tmpPath("reload.pem");
    try {
      const { publicKeyBase64 } = loadOrCreatePrivateKey(keyPath);
      const ownerId = seedOwner(db);

      const registry = loadPeerRegistry(db, "alice", "ed25519:test-self");
      expect(registry.peers.size).toBe(0);

      insertInstance(db, ownerId, {
        id: "newpeer",
        url: "https://new.example",
        public_key: `ed25519:${publicKeyBase64}`,
      });
      registry.reload();
      expect(registry.peers.size).toBe(1);
      expect(registry.peers.has("newpeer")).toBe(true);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    }
  });
});
