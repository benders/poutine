import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { createDatabase } from "../src/db/client.js";
import { createTombstone, verifyTombstone, tombstonePayload } from "../src/federation/tombstones.js";

describe("tombstones (#244 Phase 2)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("createTombstone signs and inserts a row; verifyTombstone confirms it against the signer's pubkey", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const record = createTombstone(db, privateKey, {
      instanceId: "peer-x",
      removedBy: "local",
      reason: "evicted for cause",
    });

    expect(record.instanceId).toBe("peer-x");
    expect(record.removedBy).toBe("local");
    expect(record.reason).toBe("evicted for cause");
    expect(typeof record.createdAt).toBe("string");
    expect(verifyTombstone(record, publicKey)).toBe(true);

    const row = db
      .prepare("SELECT * FROM peer_tombstones WHERE instance_id = 'peer-x'")
      .get() as { created_at: string; signature: string };
    // The stored created_at must be exactly what was signed — not a
    // SQLite-generated DEFAULT value.
    expect(row.created_at).toBe(record.createdAt);
    expect(row.signature).toBe(record.signature);
  });

  it("is idempotent — a second createTombstone call for the same instance keeps the original signature", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const first = createTombstone(db, privateKey, { instanceId: "peer-y", removedBy: "local" });
    const second = createTombstone(db, privateKey, {
      instanceId: "peer-y",
      removedBy: "local",
      reason: "different reason, should be ignored",
    });
    expect(second).toEqual(first);

    const count = db
      .prepare("SELECT COUNT(*) AS n FROM peer_tombstones WHERE instance_id = 'peer-y'")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("verifyTombstone fails when instance_id is tampered", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const record = createTombstone(db, privateKey, { instanceId: "peer-z", removedBy: "local" });
    expect(verifyTombstone({ ...record, instanceId: "peer-other" }, publicKey)).toBe(false);
  });

  it("verifyTombstone fails when created_at is tampered", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const record = createTombstone(db, privateKey, { instanceId: "peer-z2", removedBy: "local" });
    expect(
      verifyTombstone({ ...record, createdAt: new Date(0).toISOString() }, publicKey),
    ).toBe(false);
  });

  it("verifyTombstone fails against the wrong public key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const { privateKey: otherPrivate } = generateKeyPairSync("ed25519");
    const wrongPublicKey = createPublicKey(otherPrivate);
    const record = createTombstone(db, privateKey, { instanceId: "peer-z3", removedBy: "local" });
    expect(verifyTombstone(record, wrongPublicKey)).toBe(false);
  });

  it("tombstonePayload is deterministic for the same inputs", () => {
    const a = tombstonePayload({ instanceId: "p", removedBy: "local", createdAt: "2026-01-01T00:00:00.000Z" });
    const b = tombstonePayload({ instanceId: "p", removedBy: "local", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(a.equals(b)).toBe(true);
  });
});
