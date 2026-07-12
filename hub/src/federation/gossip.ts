// Federation peer gossip (issue #147, federation v5).
//
// During library sync, we ask each known peer for its peer list via
// GET /federation/peers. Each entry carries the signed invitation payload
// that originally admitted the peer to the cluster, so the receiver can
// verify provenance against the named inviter's public key without prior
// trust. Newly discovered peers are inserted into `instances` as enabled.

import type Database from "better-sqlite3";
import type { KeyObject } from "node:crypto";
import type { Peer, PeerRegistry } from "./peers.js";
import type { FederationFetcher } from "../library/sync-peer.js";
import {
  verifyInvitationSignature,
  type SignedInvitation,
  type InvitationPayload,
} from "./invitations.js";
import { parsePeerPublicKey } from "./signing.js";
import { verifyTombstone, type TombstoneRecord } from "./tombstones.js";

export interface GossipPeerEntry {
  id: string;
  url: string;
  public_key: string;
  invitation_payload: InvitationPayload;
  invitation_signature: string;
  inviter_id: string;
  inviter_url: string;
  inviter_public_key: string;
}

// #244 Phase 3: a gossiped tombstone. Wire-additive to GossipResponse — a v5/v6
// responder simply omits `tombstones`, and gossipFromPeer treats an absent
// field as an empty list.
export interface GossipTombstoneEntry {
  instance_id: string;
  removed_by: string;
  reason: string | null;
  created_at: string;
  signature: string;
}

interface GossipResponse {
  peers: GossipPeerEntry[];
  tombstones?: GossipTombstoneEntry[];
}

export interface GossipLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface GossipResult {
  added: string[];
  rejected: number;
  alreadyKnown: number;
  tombstonesAdded: number;
}

export type IngestOutcome = "added" | "alreadyKnown" | "rejected";

/**
 * #244: true if `instanceId` is tombstoned — either it has a row in
 * `peer_tombstones`, or we still hold an `instances` row for it with
 * `lifecycle = 'tombstoned'`. Minimal local-only check; full tombstone
 * semantics (signed records propagated cluster-wide) are Phase 3.
 */
function isLocallyTombstoned(db: Database.Database, instanceId: string): boolean {
  const tombstoned = db
    .prepare("SELECT 1 FROM peer_tombstones WHERE instance_id = ?")
    .get(instanceId);
  if (tombstoned) return true;
  const row = db
    .prepare("SELECT lifecycle FROM instances WHERE id = ?")
    .get(instanceId) as { lifecycle: string } | undefined;
  return row?.lifecycle === "tombstoned";
}

/**
 * #244 Phase 3: re-admission check. A locally tombstoned instance id can
 * come back if the invitation now being gossiped for it was issued *after*
 * the eviction — proof that the instance was re-invited post-tombstone.
 * Requires a signed `peer_tombstones` row to compare against; a bare
 * `instances.lifecycle = 'tombstoned'` with no tombstone row (e.g. set
 * directly in a test, or pre-Phase-3 data) has no provenance to compare and
 * stays blocked. Pure check — deliberately no side effects, because at the
 * point it runs the entry's invitation signature has NOT been verified yet;
 * the caller clears the tombstone only after full validation, so a forged
 * `issued_at` on an otherwise-invalid entry cannot un-evict anyone.
 */
function invitationPostdatesTombstone(
  db: Database.Database,
  instanceId: string,
  invitationPayload: unknown,
): boolean {
  const issuedAt = (invitationPayload as { issued_at?: unknown } | undefined)?.issued_at;
  if (typeof issuedAt !== "string") return false;
  const tombstone = db
    .prepare("SELECT created_at FROM peer_tombstones WHERE instance_id = ?")
    .get(instanceId) as { created_at: string } | undefined;
  if (!tombstone) return false;
  return new Date(issuedAt).getTime() > new Date(tombstone.created_at).getTime();
}

/**
 * #244 Phase 3: validate and ingest one gossiped tombstone. Trust model: any
 * hub whose pinned pubkey we can resolve (ourselves, or a peer we know —
 * including disabled ones, since disabled is local policy, not a trust
 * revocation) may evict any other instance id. A hub we've already evicted
 * cannot evict others. We never accept a tombstone naming ourselves — a peer
 * cannot evict the local hub from its own instance. Deliberately does NOT
 * run the merge pipeline — gossip happens every sync cycle and merging on
 * every cycle is too heavy; content disappears at the next merge (the same
 * sync call runs one right after gossip).
 */
export function ingestGossipTombstone(
  db: Database.Database,
  registry: PeerRegistry,
  entry: unknown,
  ctx: { sourceLabel: string },
  log?: GossipLogger,
): IngestOutcome {
  const { sourceLabel } = ctx;
  if (!entry || typeof entry !== "object") return "rejected";
  const e = entry as Partial<GossipTombstoneEntry>;
  if (
    typeof e.instance_id !== "string" ||
    typeof e.removed_by !== "string" ||
    typeof e.created_at !== "string" ||
    typeof e.signature !== "string" ||
    (e.reason !== null && e.reason !== undefined && typeof e.reason !== "string")
  ) {
    return "rejected";
  }

  if (e.instance_id === registry.instanceId) {
    log?.warn?.(`${sourceLabel}: refused tombstone naming this hub's own instance id`);
    return "rejected";
  }

  // Already on file (relayed by more than one peer) — nothing to do.
  if (db.prepare("SELECT 1 FROM peer_tombstones WHERE instance_id = ?").get(e.instance_id)) {
    return "alreadyKnown";
  }

  // A tombstone older than the invitation we hold for that instance is
  // stale — the instance was re-invited after this eviction (#244
  // re-admission). Rejecting it is what lets the mesh converge after a
  // re-admission: without this, any hub still relaying the old tombstone
  // would re-evict the peer, flipping it back and forth forever.
  const inst = db
    .prepare("SELECT invitation_payload FROM instances WHERE id = ?")
    .get(e.instance_id) as { invitation_payload: string | null } | undefined;
  if (inst?.invitation_payload) {
    let issuedAt: unknown;
    try {
      issuedAt = (JSON.parse(inst.invitation_payload) as { issued_at?: unknown }).issued_at;
    } catch {
      issuedAt = undefined; // unparseable stored payload — treat as no invitation
    }
    if (
      typeof issuedAt === "string" &&
      new Date(issuedAt).getTime() > new Date(e.created_at).getTime()
    ) {
      log?.info?.(
        `${sourceLabel}: stale tombstone for ${e.instance_id} rejected — local invitation postdates it`,
      );
      return "rejected";
    }
  }

  let removerPublicKey: KeyObject | undefined;
  if (e.removed_by === registry.instanceId) {
    removerPublicKey = parsePeerPublicKey(registry.publicKeySpec);
  } else {
    removerPublicKey = registry.peers.get(e.removed_by)?.publicKey;
  }
  if (!removerPublicKey) {
    log?.warn?.(
      `${sourceLabel}: tombstone for ${e.instance_id} rejected — remover ${e.removed_by} is not a known peer`,
    );
    return "rejected";
  }

  if (isLocallyTombstoned(db, e.removed_by)) {
    log?.warn?.(
      `${sourceLabel}: tombstone for ${e.instance_id} rejected — remover ${e.removed_by} is locally tombstoned`,
    );
    return "rejected";
  }

  const record: TombstoneRecord = {
    instanceId: e.instance_id,
    removedBy: e.removed_by,
    reason: e.reason ?? null,
    createdAt: e.created_at,
    signature: e.signature,
  };
  if (!verifyTombstone(record, removerPublicKey)) {
    log?.warn?.(`${sourceLabel}: tombstone for ${e.instance_id} signature invalid`);
    return "rejected";
  }

  // Relay verbatim — keep the original signature/remover/timestamp, we are
  // not re-signing on their behalf.
  db.prepare(
    `INSERT INTO peer_tombstones (instance_id, removed_by, reason, created_at, signature)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(instance_id) DO NOTHING`,
  ).run(record.instanceId, record.removedBy, record.reason, record.createdAt, record.signature);

  const instRow = db
    .prepare("SELECT lifecycle FROM instances WHERE id = ?")
    .get(e.instance_id) as { lifecycle: string } | undefined;
  if (instRow && instRow.lifecycle !== "tombstoned") {
    db.prepare(
      "UPDATE instances SET lifecycle = 'tombstoned', lifecycle_changed_at = datetime('now') WHERE id = ?",
    ).run(e.instance_id);
  }

  log?.info?.(`${sourceLabel}: relayed tombstone for ${e.instance_id} (removed by ${e.removed_by})`);
  return "added";
}

/**
 * Validate a single gossip entry and insert it into `instances` if new.
 *
 * Does NOT call `registry.reload()` — callers that batch entries should reload
 * once after the loop. `sourceLabel` is only used for log prefixes.
 *
 * The trust model is identical regardless of who delivered the entry: the
 * embedded invitation must verify against the named inviter's public key, and
 * if we already know the inviter the keys must match (key-swap defense).
 * That's why the same function serves both `GET /federation/peers` ingestion
 * and `POST /federation/peers/announce` ingestion (#163).
 */
export function ingestGossipEntry(
  db: Database.Database,
  registry: PeerRegistry,
  entry: unknown,
  ctx: { sourceLabel: string; ownerId: string; knownIds: Set<string> },
  log?: GossipLogger,
): IngestOutcome {
  const { sourceLabel, ownerId, knownIds } = ctx;

  if (!entry || typeof entry !== "object") return "rejected";
  const e = entry as Partial<GossipPeerEntry>;
  // Cheap id-check first: if we already know this peer there's nothing to do,
  // and validating an entry we'd throw away wastes log-warn noise.
  if (typeof e.id === "string" && knownIds.has(e.id)) return "alreadyKnown";

  // #244: refuse to re-introduce an instance id we've locally evicted, unless
  // the invitation now being gossiped for it postdates our tombstone (Phase
  // 3 re-admission — proof the instance was re-invited after eviction).
  // Pure check only at this point — the tombstone is cleared further down,
  // after the entry's invitation signature has actually been verified.
  let readmit = false;
  if (typeof e.id === "string" && isLocallyTombstoned(db, e.id)) {
    if (!invitationPostdatesTombstone(db, e.id, e.invitation_payload)) {
      log?.info?.(`${sourceLabel}: suppressed re-introduction of tombstoned peer ${e.id}`);
      return "rejected";
    }
    readmit = true;
  }
  if (
    typeof e.id !== "string" ||
    typeof e.url !== "string" ||
    typeof e.public_key !== "string" ||
    typeof e.invitation_signature !== "string" ||
    !e.invitation_payload ||
    typeof e.invitation_payload !== "object" ||
    typeof e.inviter_id !== "string" ||
    typeof e.inviter_url !== "string" ||
    typeof e.inviter_public_key !== "string"
  ) {
    return "rejected";
  }

  // The embedded payload's fields must match the entry's claimed inviter_*.
  // Otherwise an attacker could swap inviter identity while keeping a valid
  // signature for some unrelated payload.
  const p = e.invitation_payload;
  if (
    p.inviter_id !== e.inviter_id ||
    p.inviter_url !== e.inviter_url ||
    p.inviter_public_key !== e.inviter_public_key
  ) {
    log?.warn?.(`${sourceLabel}: entry ${e.id} inviter fields do not match payload`);
    return "rejected";
  }

  // #244: an inviter we've locally tombstoned must not be allowed to grow
  // the mesh — an evicted hub could otherwise keep vouching for new peers.
  // Disabled inviters are NOT rejected here: disabled is local-only policy,
  // not a trust revocation, so their invitations still verify.
  if (isLocallyTombstoned(db, p.inviter_id)) {
    log?.warn?.(`${sourceLabel}: entry ${e.id} rejected — inviter ${p.inviter_id} is locally tombstoned`);
    return "rejected";
  }

  // Pin the inviter's public key when we already know that inviter. The
  // overall trust model is intentionally transitive — gossip is how new
  // peers reach us — but if a peer claims a known inviter while supplying
  // a different key for them, that's an attempted key-swap and we refuse.
  // Unknown inviters are accepted; their signature still has to verify
  // against the embedded key. (Stronger restriction tracked in #153.)
  const localId = registry.instanceId;
  const inviterIsLocal = p.inviter_id === localId;
  const inviterPeer = registry.peers.get(p.inviter_id);
  const expectedInviterKey = inviterIsLocal
    ? registry.publicKeySpec
    : inviterPeer?.publicKeySpec;
  if (expectedInviterKey && p.inviter_public_key !== expectedInviterKey) {
    log?.warn?.(
      `${sourceLabel}: entry ${e.id} rejected — inviter_public_key does not match registry for ${p.inviter_id}`,
    );
    return "rejected";
  }

  const signed: SignedInvitation = {
    payload: p,
    signature: e.invitation_signature,
  };
  const verified = verifyInvitationSignature(signed, { checkExpiry: false });
  if (!verified.ok) {
    log?.warn?.(`${sourceLabel}: entry ${e.id} signature invalid — ${verified.error}`);
    return "rejected";
  }

  // Sanity-check the peer's claimed public_key parses.
  try {
    parsePeerPublicKey(e.public_key);
  } catch (err) {
    log?.warn?.(`${sourceLabel}: entry ${e.id} public_key invalid — ${String(err)}`);
    return "rejected";
  }

  const url = e.url.replace(/\/+$/, "");
  const next = (
    db
      .prepare("SELECT COALESCE(MAX(musicfolder_id), 0) + 1 AS next FROM instances")
      .get() as { next: number }
  ).next;
  try {
    // The entry is fully verified — only now is it safe to act on the
    // re-admission the postdated invitation proves. ON CONFLICT is scoped to
    // tombstoned rows (mirrors the handshake upsert in routes/federation.ts):
    // the kept-through-eviction row is refreshed and flipped back to
    // 'active'; any other conflicting row (e.g. one outside the registry
    // snapshot because it has no public_key) is left untouched, matching the
    // pre-#244 behavior where the plain INSERT threw.
    if (readmit) {
      db.prepare("DELETE FROM peer_tombstones WHERE instance_id = ?").run(e.id);
    }
    const info = db.prepare(
      `INSERT INTO instances
         (id, name, url, adapter_type, encrypted_credentials, owner_id, status, musicfolder_id,
          public_key, invitation_payload, invitation_signature, inviter_id, inviter_url, inviter_public_key)
       VALUES (?, ?, ?, 'subsonic', '', ?, 'offline', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         url = excluded.url,
         public_key = excluded.public_key,
         invitation_payload = excluded.invitation_payload,
         invitation_signature = excluded.invitation_signature,
         inviter_id = excluded.inviter_id,
         inviter_url = excluded.inviter_url,
         inviter_public_key = excluded.inviter_public_key,
         lifecycle = 'active',
         lifecycle_changed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE instances.lifecycle = 'tombstoned'`,
    ).run(
      e.id,
      e.id,
      url,
      ownerId,
      next,
      e.public_key,
      JSON.stringify(p),
      e.invitation_signature,
      e.inviter_id,
      e.inviter_url,
      e.inviter_public_key,
    );
    if (info.changes === 0) {
      log?.warn?.(`${sourceLabel}: entry ${e.id} conflicts with an existing non-readmission row`);
      return "rejected";
    }
    knownIds.add(e.id);
    if (readmit) {
      log?.info?.(`${sourceLabel}: cleared tombstone for ${e.id} — invitation postdates eviction`);
    } else {
      log?.info?.(`${sourceLabel}: added ${e.id} (via inviter ${e.inviter_id})`);
    }
    return "added";
  } catch (err) {
    log?.warn?.(`${sourceLabel}: insert failed for ${e.id}: ${String(err)}`);
    return "rejected";
  }
}

/**
 * Pull `GET /federation/peers` from `peer` and ingest entries we don't yet
 * know. Returns { added, rejected, alreadyKnown }.
 */
export async function gossipFromPeer(
  db: Database.Database,
  registry: PeerRegistry,
  peer: Peer,
  federatedFetch: FederationFetcher,
  asUser: string,
  log?: GossipLogger,
): Promise<GossipResult> {
  const result: GossipResult = { added: [], rejected: 0, alreadyKnown: 0, tombstonesAdded: 0 };
  const res = await federatedFetch(peer, "/federation/peers", { asUser });
  if (!res.ok) {
    throw new Error(`gossip ${peer.id}: HTTP ${res.status}`);
  }
  const body = (await res.json()) as GossipResponse;
  if (!body || !Array.isArray(body.peers)) {
    log?.warn?.(`gossip ${peer.id}: malformed response (no peers array)`);
    return result;
  }

  const localId = registry.instanceId;
  // Tombstoned peer ids are deliberately excluded from "known" — they must
  // still be re-evaluated by ingestGossipEntry so a postdated re-invitation
  // can clear the tombstone (#244 Phase 3 re-admission). Disabled peers stay
  // in knownIds: disabled is local-only policy, not something gossip should
  // ever re-validate or reinsert.
  const knownIds = new Set<string>([
    "local",
    localId,
    ...Array.from(registry.peers.values())
      .filter((p) => p.lifecycle !== "tombstoned")
      .map((p) => p.id),
  ]);

  const owner = db.prepare("SELECT id FROM users LIMIT 1").get() as
    | { id: string }
    | undefined;
  if (!owner) {
    log?.warn?.(`gossip ${peer.id}: no user row available; skipping ingest`);
    return result;
  }

  const sourceLabel = `gossip ${peer.id}`;
  let changed = false;
  for (const entry of body.peers) {
    const outcome = ingestGossipEntry(
      db,
      registry,
      entry,
      { sourceLabel, ownerId: owner.id, knownIds },
      log,
    );
    if (outcome === "added") {
      result.added.push((entry as GossipPeerEntry).id);
      changed = true;
    } else if (outcome === "alreadyKnown") {
      result.alreadyKnown++;
    } else {
      result.rejected++;
    }
  }

  // #244 Phase 3: absent on a v5/v6 responder — treat as no tombstones.
  const tombstones = Array.isArray(body.tombstones) ? body.tombstones : [];
  for (const entry of tombstones) {
    const outcome = ingestGossipTombstone(db, registry, entry, { sourceLabel }, log);
    if (outcome === "added") {
      result.tombstonesAdded++;
      changed = true;
    }
  }

  if (changed) registry.reload();
  return result;
}
