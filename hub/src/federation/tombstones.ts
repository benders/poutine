// Signed peer-tombstone records (issue #244, Phase 2).
//
// A tombstone is the local hub's assertion that it has evicted a peer.
// Phase 3 gossips these rows so eviction propagates cluster-wide; peers
// verify the signature against the remover's pinned pubkey before honoring
// it. This phase only creates and locally enforces tombstones.

import type Database from "better-sqlite3";
import type { KeyObject } from "node:crypto";
import { signRequest, verifyRequest } from "./signing.js";

export interface TombstoneRecord {
  instanceId: string;
  removedBy: string;
  reason: string | null;
  createdAt: string;
  signature: string;
}

// Canonical signed payload — deterministic so any peer can recompute and
// verify it. `createdAt` must be the exact string stored in the row; never
// let SQLite's column DEFAULT generate a value independent of what was
// signed (generate it here, sign it, then INSERT that same string).
export function tombstonePayload(input: {
  instanceId: string;
  removedBy: string;
  createdAt: string;
}): Buffer {
  return Buffer.from(
    `TOMBSTONE\n${input.instanceId}\n${input.removedBy}\n${input.createdAt}`,
    "utf8",
  );
}

/**
 * Build, sign, and persist a tombstone for `instanceId`. Idempotent: if a
 * tombstone row already exists (PK on instance_id), returns the existing
 * row unchanged rather than re-signing — callers (e.g. DELETE peer route)
 * should check `peer_tombstones` first if they need to distinguish "already
 * tombstoned" from "newly tombstoned".
 */
export function createTombstone(
  db: Database.Database,
  privateKey: KeyObject,
  input: { instanceId: string; removedBy: string; reason?: string | null },
): TombstoneRecord {
  const createdAt = new Date().toISOString();
  const payload = tombstonePayload({
    instanceId: input.instanceId,
    removedBy: input.removedBy,
    createdAt,
  });
  const signature = signRequest(privateKey, payload);

  db.prepare(
    `INSERT INTO peer_tombstones (instance_id, removed_by, reason, created_at, signature)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(instance_id) DO NOTHING`,
  ).run(input.instanceId, input.removedBy, input.reason ?? null, createdAt, signature);

  return db
    .prepare(
      "SELECT instance_id AS instanceId, removed_by AS removedBy, reason, created_at AS createdAt, signature FROM peer_tombstones WHERE instance_id = ?",
    )
    .get(input.instanceId) as TombstoneRecord;
}

/**
 * Verify a tombstone record's signature against the claimed remover's
 * public key. Used locally now for the unit round trip; Phase 3 reuses it
 * to validate gossiped tombstones against the pinned inviter/remover pubkey.
 */
export function verifyTombstone(
  record: TombstoneRecord,
  removerPublicKey: KeyObject,
): boolean {
  const payload = tombstonePayload({
    instanceId: record.instanceId,
    removedBy: record.removedBy,
    createdAt: record.createdAt,
  });
  return verifyRequest(removerPublicKey, payload, record.signature);
}
