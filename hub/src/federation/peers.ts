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

export interface Peer {
  id: string;
  url: string;       // hub base URL, no trailing slash
  proxyUrl: string;  // base URL for /proxy/* calls; equals url since v5
  publicKey: KeyObject;
  publicKeySpec: string; // original "ed25519:<base64>" string for logging
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
}

function buildSnapshot(
  db: Database.Database,
  instanceId: string,
  warn: (msg: string) => void,
): Map<string, Peer> {
  const peers = new Map<string, Peer>();
  const rows = db
    .prepare(
      "SELECT id, url, public_key FROM instances WHERE id != 'local' AND public_key IS NOT NULL",
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
