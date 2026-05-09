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

  let inserted = false;
  for (const entry of body.peers) {
    if (!entry || typeof entry !== "object") {
      result.rejected++;
      continue;
    }
    if (
      typeof entry.id !== "string" ||
      typeof entry.url !== "string" ||
      typeof entry.public_key !== "string" ||
      typeof entry.invitation_signature !== "string" ||
      !entry.invitation_payload ||
      typeof entry.invitation_payload !== "object"
    ) {
      result.rejected++;
      continue;
    }
    if (knownIds.has(entry.id)) {
      result.alreadyKnown++;
      continue;
    }

    // The embedded payload's fields must match the entry's claimed
    // inviter_*. Otherwise an attacker could swap inviter identity while
    // keeping a valid signature for some unrelated payload.
    const p = entry.invitation_payload;
    if (
      p.inviter_id !== entry.inviter_id ||
      p.inviter_url !== entry.inviter_url ||
      p.inviter_public_key !== entry.inviter_public_key
    ) {
      log?.warn?.(`gossip ${peer.id}: entry ${entry.id} inviter fields do not match payload`);
      result.rejected++;
      continue;
    }

    const signed: SignedInvitation = {
      payload: p,
      signature: entry.invitation_signature,
    };
    const verified = verifyInvitationSignature(signed, { checkExpiry: false });
    if (!verified.ok) {
      log?.warn?.(`gossip ${peer.id}: entry ${entry.id} signature invalid — ${verified.error}`);
      result.rejected++;
      continue;
    }

    // Sanity-check the peer's claimed public_key parses.
    try {
      parsePeerPublicKey(entry.public_key);
    } catch (err) {
      log?.warn?.(`gossip ${peer.id}: entry ${entry.id} public_key invalid — ${String(err)}`);
      result.rejected++;
      continue;
    }

    const url = entry.url.replace(/\/+$/, "");
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
        entry.id,
        entry.id,
        url,
        owner.id,
        next,
        entry.public_key,
        JSON.stringify(p),
        entry.invitation_signature,
        entry.inviter_id,
        entry.inviter_url,
        entry.inviter_public_key,
      );
      knownIds.add(entry.id);
      result.added.push(entry.id);
      inserted = true;
      log?.info?.(`gossip ${peer.id}: added ${entry.id} (via inviter ${entry.inviter_id})`);
    } catch (err) {
      log?.warn?.(`gossip ${peer.id}: insert failed for ${entry.id}: ${String(err)}`);
      result.rejected++;
    }
  }
  if (inserted) registry.reload();
  return result;
}
