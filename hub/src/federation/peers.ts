// Federation peer registry — DB-backed since v0.5.0 / federation API v5.
//
// Peers used to come from `config/peers.yaml`; that file is no longer read.
// Peers are admitted via signed invitations (POST /admin/peers/invite +
// POST /federation/handshake) and discovered via gossip on sync. The
// `instances` table is authoritative; this registry is a typed snapshot of
// rows where `id != 'local'` and `public_key IS NOT NULL`.

import type Database from "better-sqlite3";
import type { KeyObject } from "node:crypto";
import { parsePeerPublicKey } from "./signing.js";

// Peer admission state (issue #244) — orthogonal to the DB `status` column
// (online/offline/degraded), which tracks liveness. `lifecycle` tracks
// whether we still admit this peer at all: active (normal), disabled
// (local-only policy, reversible), tombstoned (evicted).
export type PeerLifecycle = "active" | "disabled" | "tombstoned";

export interface Peer {
  id: string;
  url: string;       // hub base URL, no trailing slash
  proxyUrl: string;  // base URL for /proxy/* calls; equals url since v5
  publicKey: KeyObject;
  publicKeySpec: string; // original "ed25519:<base64>" string for logging
  lifecycle: PeerLifecycle;
}

export interface PeerRegistry {
  instanceId: string;
  publicKeySpec: string; // this hub's own "ed25519:<base64>" — for trust pinning
  peers: Map<string, Peer>;
  reload(): void;
}

interface InstanceRow {
  id: string;
  url: string;
  public_key: string;
  lifecycle: PeerLifecycle;
}

// Snapshot includes non-active peers on purpose — gossip provenance pinning
// (gossip.ts) needs a disabled/tombstoned inviter's pubkey to still be
// resolvable. Consumers that must not act on non-active peers (sync, inbound
// auth, proxy) gate explicitly on `peer.lifecycle` (#244).
function buildSnapshot(
  db: Database.Database,
  instanceId: string,
  warn: (msg: string) => void,
): Map<string, Peer> {
  const peers = new Map<string, Peer>();
  const rows = db
    .prepare(
      "SELECT id, url, public_key, lifecycle FROM instances WHERE id != 'local' AND public_key IS NOT NULL",
    )
    .all() as InstanceRow[];

  for (const row of rows) {
    if (row.id === instanceId) continue; // never proxy to self
    let publicKey: KeyObject;
    try {
      publicKey = parsePeerPublicKey(row.public_key);
    } catch (err) {
      warn(`Skipping peer "${row.id}": invalid public_key — ${String(err)}`);
      continue;
    }
    const url = row.url.replace(/\/+$/, "");
    peers.set(row.id, {
      id: row.id,
      url,
      proxyUrl: url,
      publicKey,
      publicKeySpec: row.public_key,
      lifecycle: row.lifecycle,
    });
  }
  return peers;
}

export function loadPeerRegistry(
  db: Database.Database,
  instanceId: string,
  publicKeySpec: string,
): PeerRegistry {
  const warn = (msg: string) => console.warn(`[peers] ${msg}`);
  let snapshot = buildSnapshot(db, instanceId, warn);

  return {
    get instanceId() {
      return instanceId;
    },
    get publicKeySpec() {
      return publicKeySpec;
    },
    get peers() {
      return snapshot;
    },
    reload() {
      snapshot = buildSnapshot(db, instanceId, warn);
    },
  };
}
