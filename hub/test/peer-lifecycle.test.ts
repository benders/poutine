/**
 * Tests for peer lifecycle state (issue #244, Phase 1).
 *
 * Covers: instances.lifecycle migration, inbound peer-auth enforcement,
 * merge exclusion of non-active instances (with disable/enable round trip),
 * gossip suppression of tombstoned peers/inviters, and sync/pollPeers skip.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/client.js";
import { mergeLibraries } from "../src/library/merge.js";
import { runMergePipeline } from "../src/library/merge-pipeline.js";
import { syncAll } from "../src/library/sync.js";
import { AutoSyncService } from "../src/services/auto-sync.js";
import { SyncOperationService } from "../src/services/sync-operations.js";
import { ingestGossipEntry, type GossipPeerEntry } from "../src/federation/gossip.js";
import { createInvitation } from "../src/federation/invitations.js";
import { loadOrCreatePrivateKey } from "../src/federation/signing.js";
import { admit, startHub, tmpPath, type Hub } from "./helpers/hub-setup.js";

describe("instances.lifecycle migration (#244)", () => {
  it("fresh DB from current schema.sql has lifecycle + peer_tombstones", () => {
    const db = createDatabase(":memory:");
    const cols = db
      .prepare("PRAGMA table_info(instances)")
      .all() as Array<{ name: string; dflt_value: string | null }>;
    const lifecycleCol = cols.find((c) => c.name === "lifecycle");
    expect(lifecycleCol).toBeDefined();
    expect(lifecycleCol?.dflt_value).toBe("'active'");

    // createDatabase() doesn't itself seed a 'local' row (that happens at
    // buildApp() time) — verify the column default by inserting directly.
    const ownerId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, ?)",
    ).run(ownerId, "admin", "fakehash", 1);
    db.prepare(
      "INSERT INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id) VALUES ('local', 'Local', 'http://localhost', 'subsonic', '', ?)",
    ).run(ownerId);
    const row = db
      .prepare("SELECT lifecycle FROM instances WHERE id = 'local'")
      .get() as { lifecycle: string } | undefined;
    expect(row?.lifecycle).toBe("active");

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'peer_tombstones'")
      .all();
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("adds lifecycle column to a pre-#244 DB and defaults existing rows to active", () => {
    const dir = mkdtempSync(join(tmpdir(), "poutine-lifecycle-mig-"));
    const path = join(dir, "old.db");

    const old = new Database(path);
    old.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_enc TEXT NOT NULL DEFAULT '',
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE instances (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        adapter_type TEXT NOT NULL DEFAULT 'subsonic',
        encrypted_credentials TEXT NOT NULL DEFAULT '{}',
        owner_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'offline',
        musicfolder_id INTEGER,
        public_key TEXT,
        invitation_payload TEXT,
        invitation_signature TEXT,
        inviter_id TEXT,
        inviter_url TEXT,
        inviter_public_key TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO users (id, username, password_enc, is_admin)
        VALUES ('u1', 'admin', 'secret-key', 1);

      INSERT INTO instances (id, name, url, encrypted_credentials, owner_id, created_at)
        VALUES ('local', 'Local', 'http://localhost:4533', '{}', 'u1', '2024-01-01 00:00:00');
    `);
    old.close();

    const db = createDatabase(path);
    const cols = db
      .prepare("PRAGMA table_info(instances)")
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("lifecycle")).toBe(true);
    expect(names.has("lifecycle_changed_at")).toBe(true);

    const row = db
      .prepare("SELECT id, lifecycle FROM instances WHERE id = 'local'")
      .get() as { id: string; lifecycle: string };
    expect(row.id).toBe("local");
    expect(row.lifecycle).toBe("active");

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'peer_tombstones'")
      .all();
    expect(tables).toHaveLength(1);

    db.close();
    rmSync(dir, { recursive: true });
  });
});

describe("peer-auth lifecycle enforcement (#244)", () => {
  let hubA: Hub;
  let hubB: Hub;

  beforeEach(async () => {
    hubA = await startHub("lc-a");
    hubB = await startHub("lc-b");
    await admit(hubA, hubB);
  });

  afterEach(async () => {
    await hubA.app.close();
    await hubB.app.close();
    for (const f of [hubA.keyPath, hubB.keyPath]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("active peer's signed request passes", async () => {
    const bAsPeer = hubA.app.peerRegistry.peers.get("lc-b");
    expect(bAsPeer).toBeDefined();
    const res = await hubA.app.federatedFetch(bAsPeer!, "/federation/peers", {
      asUser: "admin-lc-a",
    });
    expect(res.status).toBe(200);
  });

  it("disabled peer is refused with a uniform 403", async () => {
    hubB.app.db
      .prepare(
        "UPDATE instances SET lifecycle = 'disabled', lifecycle_changed_at = datetime('now') WHERE id = ?",
      )
      .run("lc-a");
    hubB.app.peerRegistry.reload();

    const bAsPeer = hubA.app.peerRegistry.peers.get("lc-b");
    const res = await hubA.app.federatedFetch(bAsPeer!, "/federation/peers", {
      asUser: "admin-lc-a",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("tombstoned peer is refused with the identical 403 body as disabled", async () => {
    hubB.app.db
      .prepare("UPDATE instances SET lifecycle = 'tombstoned' WHERE id = ?")
      .run("lc-a");
    hubB.app.peerRegistry.reload();

    const bAsPeer = hubA.app.peerRegistry.peers.get("lc-b");
    const res = await hubA.app.federatedFetch(bAsPeer!, "/federation/peers", {
      asUser: "admin-lc-a",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });
});

describe("merge exclusion of non-active instances (#244)", () => {
  let db: Database.Database;
  let ownerId: string;
  let userId: string;
  const activeInst = "inst-active";
  const disabledInst = "inst-disabled";

  beforeEach(() => {
    db = createDatabase(":memory:");
    ownerId = crypto.randomUUID();
    userId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, ?)",
    ).run(ownerId, "admin", "fakehash", 1);
    db.prepare(
      "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, ?)",
    ).run(userId, "listener", "fakehash", 0);

    for (const inst of [activeInst, disabledInst]) {
      db.prepare(
        "INSERT INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(inst, inst, `https://${inst}.example.com`, "subsonic", "encrypted", ownerId, "online");
    }
  });

  afterEach(() => {
    db.close();
  });

  function seedInstance(instanceId: string, artistName: string, trackTitle: string) {
    const artistId = `${instanceId}:a1`;
    db.prepare(
      "INSERT INTO instance_artists (id, instance_id, remote_id, name, album_count) VALUES (?, ?, ?, ?, ?)",
    ).run(artistId, instanceId, "a1", artistName, 1);
    const albumId = `${instanceId}:al1`;
    db.prepare(
      `INSERT INTO instance_albums (id, instance_id, remote_id, name, artist_id, artist_name, track_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(albumId, instanceId, "al1", `${artistName} Album`, artistId, artistName, 1);
    const trackId = `${instanceId}:t1`;
    db.prepare(
      `INSERT INTO instance_tracks (id, instance_id, remote_id, album_id, title, artist_name, track_number, disc_number, duration_ms, format)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(trackId, instanceId, "t1", albumId, trackTitle, artistName, 1, 1, 200000, "flac");
  }

  it("excludes disabled/tombstoned instance rows from unified tables but keeps instance_* rows; round-trips ids and stars on re-enable", () => {
    seedInstance(activeInst, "Active Artist", "Active Track");
    seedInstance(disabledInst, "Disabled Artist", "Disabled Track");

    // Initial merge with both active.
    runMergePipeline(db);

    const beforeDisableTrack = db
      .prepare("SELECT id FROM unified_tracks WHERE title = 'Disabled Track'")
      .get() as { id: string } | undefined;
    expect(beforeDisableTrack).toBeDefined();
    const disabledUnifiedTrackId = beforeDisableTrack!.id;

    // Star the soon-to-be-disabled peer's track.
    db.prepare(
      "INSERT INTO user_stars (user_id, kind, target_id) VALUES (?, 'track', ?)",
    ).run(userId, disabledUnifiedTrackId);

    // Disable the peer and re-merge.
    db.prepare(
      "UPDATE instances SET lifecycle = 'disabled', lifecycle_changed_at = datetime('now') WHERE id = ?",
    ).run(disabledInst);
    runMergePipeline(db);

    // Excluded from unified tables.
    expect(
      db.prepare("SELECT id FROM unified_tracks WHERE title = 'Disabled Track'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT id FROM unified_artists WHERE name = 'Disabled Artist'").get(),
    ).toBeUndefined();
    // Active instance's entities are unaffected.
    expect(
      db.prepare("SELECT id FROM unified_tracks WHERE title = 'Active Track'").get(),
    ).toBeDefined();

    // Raw instance_* rows for the disabled peer are kept.
    expect(
      db.prepare("SELECT id FROM instance_tracks WHERE instance_id = ?").get(disabledInst),
    ).toBeDefined();

    // Star row is orphaned (target no longer resolves) while disabled.
    const orphanedStar = db
      .prepare(
        `SELECT us.target_id FROM user_stars us
         LEFT JOIN unified_tracks ut ON ut.id = us.target_id
         WHERE us.user_id = ? AND ut.id IS NULL`,
      )
      .get(userId) as { target_id: string } | undefined;
    expect(orphanedStar?.target_id).toBe(disabledUnifiedTrackId);

    // Re-enable and re-merge — no re-sync needed, instance_* rows are still there.
    db.prepare(
      "UPDATE instances SET lifecycle = 'active', lifecycle_changed_at = datetime('now') WHERE id = ?",
    ).run(disabledInst);
    runMergePipeline(db);

    const afterReenableTrack = db
      .prepare("SELECT id FROM unified_tracks WHERE title = 'Disabled Track'")
      .get() as { id: string } | undefined;
    expect(afterReenableTrack).toBeDefined();
    // Same unified id as before disabling — deterministic id generation means
    // the round trip needs no re-sync.
    expect(afterReenableTrack!.id).toBe(disabledUnifiedTrackId);

    // The star resolves again against the same target id.
    const resolvedStar = db
      .prepare(
        `SELECT ut.title FROM user_stars us
         JOIN unified_tracks ut ON ut.id = us.target_id
         WHERE us.user_id = ? AND us.kind = 'track'`,
      )
      .get(userId) as { title: string } | undefined;
    expect(resolvedStar?.title).toBe("Disabled Track");
  });

  it("mergeLibraries alone also excludes non-active instances (unit-level check)", () => {
    seedInstance(activeInst, "Solo Artist", "Solo Track");
    seedInstance(disabledInst, "Ghost Artist", "Ghost Track");
    db.prepare("UPDATE instances SET lifecycle = 'tombstoned' WHERE id = ?").run(disabledInst);

    mergeLibraries(db);

    expect(
      db.prepare("SELECT id FROM unified_tracks WHERE title = 'Ghost Track'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT id FROM unified_tracks WHERE title = 'Solo Track'").get(),
    ).toBeDefined();
  });
});

describe("gossip suppression of tombstoned peers (#244)", () => {
  let hubA: Hub;
  let hubB: Hub;
  let hubC: Hub;

  beforeEach(async () => {
    hubA = await startHub("lct-a");
    hubB = await startHub("lct-b");
    hubC = await startHub("lct-c");
  });

  afterEach(async () => {
    await hubA.app.close();
    await hubB.app.close();
    await hubC.app.close();
    for (const f of [hubA.keyPath, hubB.keyPath, hubC.keyPath]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("does not re-add a gossip entry whose id is locally tombstoned", async () => {
    await admit(hubB, hubC); // B <-> C
    await admit(hubA, hubB); // A <-> B; A now also knows C is reachable via gossip

    // A tombstones C locally (simulating a prior eviction) without removing
    // the peer_tombstones-style guard from its own instances row — set both
    // to exercise either code path.
    hubA.app.db
      .prepare("UPDATE instances SET lifecycle = 'tombstoned' WHERE id = 'lct-c'")
      .run();
    hubA.app.peerRegistry.reload();

    const knownIds = new Set<string>([
      "local",
      hubA.app.peerRegistry.instanceId,
      ...hubA.app.peerRegistry.peers.keys(),
    ]);
    // hub-c is still in the registry snapshot (non-active peers stay visible
    // for provenance pinning) — remove it from knownIds to simulate the
    // real gossip ingest path, which treats "known" as "already admitted",
    // not merely "present with any lifecycle". The tombstone guard is what
    // must reject it, not the knownIds cheap-path.
    knownIds.delete("lct-c");

    const bRow = hubB.app.db
      .prepare(
        `SELECT id, url, public_key, invitation_payload, invitation_signature,
                inviter_id, inviter_url, inviter_public_key
         FROM instances WHERE id = 'lct-c'`,
      )
      .get() as {
      id: string;
      url: string;
      public_key: string;
      invitation_payload: string;
      invitation_signature: string;
      inviter_id: string;
      inviter_url: string;
      inviter_public_key: string;
    };
    const entry: GossipPeerEntry = {
      id: bRow.id,
      url: bRow.url,
      public_key: bRow.public_key,
      invitation_payload: JSON.parse(bRow.invitation_payload),
      invitation_signature: bRow.invitation_signature,
      inviter_id: bRow.inviter_id,
      inviter_url: bRow.inviter_url,
      inviter_public_key: bRow.inviter_public_key,
    };

    const outcome = ingestGossipEntry(
      hubA.app.db,
      hubA.app.peerRegistry,
      entry,
      { sourceLabel: "test", ownerId: crypto.randomUUID(), knownIds },
    );

    expect(outcome).toBe("rejected");
  });

  it("rejects a gossip entry whose inviter is locally tombstoned", async () => {
    await admit(hubA, hubB); // A invites B — A is B's inviter

    // A evicts itself is nonsensical; instead simulate: hub-a tombstones its
    // own former invitee hub-b, then hub-b (still trusted as an inviter by
    // some other hub) tries to vouch for a brand new peer D. We simulate D's
    // entry directly since standing up a fourth hub isn't necessary — the
    // check only needs an entry whose inviter_id is a tombstoned instance id
    // in the receiver's own instances table.
    hubA.app.db
      .prepare("UPDATE instances SET lifecycle = 'tombstoned' WHERE id = 'lct-b'")
      .run();
    hubA.app.peerRegistry.reload();

    const keyPath = tmpPath("lifecycle-inviter", "d-key.pem");
    try {
      const { privateKey } = loadOrCreatePrivateKey(keyPath);
      const invite = createInvitation({
        privateKey,
        inviterId: "lct-b", // claims the now-tombstoned hub-b as inviter
        inviterUrl: hubB.url,
        inviterPublicKey: hubB.app.publicKeySpec,
        inviteeUrl: null,
      });

      const entry: GossipPeerEntry = {
        id: "lct-d",
        url: "http://lct-d.example",
        public_key: hubA.app.publicKeySpec, // arbitrary well-formed key
        invitation_payload: invite.payload,
        invitation_signature: invite.signature,
        inviter_id: "lct-b",
        inviter_url: hubB.url,
        inviter_public_key: hubB.app.publicKeySpec,
      };

      const knownIds = new Set<string>([
        "local",
        hubA.app.peerRegistry.instanceId,
        ...hubA.app.peerRegistry.peers.keys(),
      ]);
      const outcome = ingestGossipEntry(
        hubA.app.db,
        hubA.app.peerRegistry,
        entry,
        { sourceLabel: "test", ownerId: crypto.randomUUID(), knownIds },
      );

      expect(outcome).toBe("rejected");
      expect(hubA.app.peerRegistry.peers.has("lct-d")).toBe(false);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    }
  });
});

describe("syncAll skips non-active peers (#244)", () => {
  let hubA: Hub;
  let hubB: Hub;

  beforeEach(async () => {
    hubA = await startHub("lcs-a");
    hubB = await startHub("lcs-b");
    await admit(hubA, hubB);
  });

  afterEach(async () => {
    await hubA.app.close();
    await hubB.app.close();
    for (const f of [hubA.keyPath, hubB.keyPath]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("does not create a sync_operations row or sync a disabled peer", async () => {
    hubA.app.db
      .prepare("UPDATE instances SET lifecycle = 'disabled' WHERE id = ?")
      .run("lcs-b");
    hubA.app.peerRegistry.reload();

    const syncOpService = new SyncOperationService(hubA.app.db);
    await syncAll(
      hubA.app.db,
      hubA.app.config,
      hubA.app.peerRegistry,
      hubA.app.federatedFetch,
      "admin-lcs-a",
      syncOpService,
    );

    const peerOps = hubA.app.db
      .prepare(
        "SELECT COUNT(*) AS c FROM sync_operations WHERE scope = 'peer' AND scope_id = ?",
      )
      .get("lcs-b") as { c: number };
    expect(peerOps.c).toBe(0);

    // No sync attempt happened for the disabled peer — last_synced_at is
    // still unset (a real syncPeer() call would set it via readNavidromeViaProxy).
    const row = hubA.app.db
      .prepare("SELECT last_synced_at FROM instances WHERE id = ?")
      .get("lcs-b") as { last_synced_at: string | null };
    expect(row.last_synced_at).toBeNull();
  });
});

describe("AutoSyncService.pollPeers skips non-active peers (#244)", () => {
  let hubA: Hub;
  let hubB: Hub;

  beforeEach(async () => {
    hubA = await startHub("lcp-a");
    hubB = await startHub("lcp-b");
    await admit(hubA, hubB);
  });

  afterEach(async () => {
    await hubA.app.close();
    await hubB.app.close();
    for (const f of [hubA.keyPath, hubB.keyPath]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("skips the health check for a disabled peer even though it is reachable", async () => {
    hubA.app.db
      .prepare("UPDATE instances SET lifecycle = 'disabled' WHERE id = ?")
      .run("lcp-b");
    hubA.app.peerRegistry.reload();

    const svc = new AutoSyncService(
      hubA.app.db,
      hubA.app.config,
      { info: () => {}, error: () => {} },
      undefined,
      null,
      null,
      {
        peerRegistry: hubA.app.peerRegistry,
        federatedFetch: hubA.app.federatedFetch,
        asUser: "admin-lcp-a",
      },
    );
    await svc.pollPeers();

    // hubB is up and would answer /api/health successfully if probed (as
    // proven by auto-sync-peers.test.ts for an active peer) — last_seen
    // staying null here proves peerHealthCheck was never invoked for the
    // disabled peer.
    const row = hubA.app.db
      .prepare("SELECT last_seen FROM instances WHERE id = ?")
      .get("lcp-b") as { last_seen: string | null };
    expect(row.last_seen).toBeNull();
  });
});
