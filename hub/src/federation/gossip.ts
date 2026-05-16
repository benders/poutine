// Federation peer gossip (issue #147, federation v5).
//
// During library sync, we ask each known peer for its peer list via
// GET /federation/peers. Each entry carries the signed invitation payload
// that originally admitted the peer to the cluster, so the receiver can
// verify provenance against the named inviter's public key without prior
// trust. Newly discovered peers are inserted into `instances` as enabled.

import type Database from "better-sqlite3";
import type { Peer, PeerRegistry } from "./peers.js";
import type { FederationFetcher } from "../library/sync-peer.js";
import {
  verifyInvitationSignature,
  type SignedInvitation,
  type InvitationPayload,
} from "./invitations.js";
import { parsePeerPublicKey } from "./signing.js";

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

interface GossipResponse {
  peers: GossipPeerEntry[];
}

export interface GossipLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface GossipResult {
  added: string[];
  rejected: number;
  alreadyKnown: number;
}

export type IngestOutcome = "added" | "alreadyKnown" | "rejected";

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
    db.prepare(
      `INSERT INTO instances
         (id, name, url, adapter_type, encrypted_credentials, owner_id, status, musicfolder_id,
          public_key, invitation_payload, invitation_signature, inviter_id, inviter_url, inviter_public_key)
       VALUES (?, ?, ?, 'subsonic', '', ?, 'offline', ?, ?, ?, ?, ?, ?, ?)`,
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
    knownIds.add(e.id);
    log?.info?.(`${sourceLabel}: added ${e.id} (via inviter ${e.inviter_id})`);
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
  const result: GossipResult = { added: [], rejected: 0, alreadyKnown: 0 };
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
  const knownIds = new Set<string>(["local", localId, ...registry.peers.keys()]);

  const owner = db.prepare("SELECT id FROM users LIMIT 1").get() as
    | { id: string }
    | undefined;
  if (!owner) {
    log?.warn?.(`gossip ${peer.id}: no user row available; skipping ingest`);
    return result;
  }

  const sourceLabel = `gossip ${peer.id}`;
  let inserted = false;
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
      inserted = true;
    } else if (outcome === "alreadyKnown") {
      result.alreadyKnown++;
    } else {
      result.rejected++;
    }
  }
  if (inserted) registry.reload();
  return result;
}
