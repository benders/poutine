import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import type { PeerRegistry } from "../federation/peers.js";
import { syncLocal } from "./sync-local.js";
import { syncPeer } from "./sync-peer.js";
import type { FederationFetcher } from "./sync-peer.js";
import type { SyncOperationType } from "../services/sync-operations.js";
import { SyncOperationService } from "../services/sync-operations.js";
import { runMergePipelineAsync } from "./merge-pipeline.js";
import { gossipFromPeer } from "../federation/gossip.js";
import type { LastFmClient } from "../services/lastfm.js";
import type { FanartTvClient } from "../services/fanarttv.js";

/** Minimal instance descriptor used by sync callers. */
export interface Instance {
  id: string;
  name: string;
  url: string;
  adapterType: string;
  ownerId: string;
  status: string;
  lastSeen: string | null;
  lastSyncedAt: string | null;
  trackCount: number;
  serverVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyncResult {
  instanceId: string;
  artistCount: number;
  albumCount: number;
  trackCount: number;
  errors: string[];
}

/**
 * Sync the local Navidrome and all known peers, then merge.
 */
export async function syncAll(
  db: Database.Database,
  config: Config,
  peerRegistry: PeerRegistry,
  federatedFetch: FederationFetcher,
  ownerUsername: string,
  syncOpService?: SyncOperationService,
  operationType: SyncOperationType = "manual",
  lastFmClient?: LastFmClient | null,
  fanartTvClient?: FanartTvClient | null,
): Promise<{ local: SyncResult; peers: SyncResult[] }> {
  const operationId = syncOpService?.start(operationType, "local") || null;
  let localResult: SyncResult;

  try {
    localResult = await syncLocal(db, config, lastFmClient ?? null, fanartTvClient ?? null);
  } catch (err) {
    if (operationId) {
      syncOpService!.fail(operationId, [`Local sync failed: ${String(err)}`]);
    }
    throw err;
  }

  const peers: SyncResult[] = [];
  // Process peers in a queue-style loop so gossip-discovered peers admitted
  // mid-pass are picked up in the same syncAll call. (We can't rely on the
  // for-of iterator over `peerRegistry.peers.values()` because reload()
  // replaces the underlying Map, leaving the active iterator pointing at the
  // previous snapshot.)
  const processed = new Set<string>();
  while (true) {
    const queue = Array.from(peerRegistry.peers.values()).filter(
      (p) => !processed.has(p.id),
    );
    if (queue.length === 0) break;
    for (const peer of queue) {
      processed.add(peer.id);
      // #244: disabled/tombstoned peers are skipped — no sync operations row,
      // no health check, no proxy calls.
      if (peer.lifecycle !== "active") continue;
      let peerOperationId: string | null = null;
      if (syncOpService) {
        peerOperationId = syncOpService.start(operationType, "peer", peer.id);
      }

      try {
      const peerResult = await syncPeer(db, peer, federatedFetch, ownerUsername, lastFmClient ?? null, fanartTvClient ?? null);
      peers.push(peerResult);
      if (peerOperationId && syncOpService) {
        syncOpService.complete(peerOperationId, 0, 0, peerResult.trackCount, peerResult.errors);
      }
      // Gossip: pull this peer's known-peers list and admit any new entries
      // whose embedded invitation signatures verify (#147). Errors here do
      // not fail the sync — gossip is best-effort. Older peers without
      // /federation/peers will return 404 and we move on.
      try {
        await gossipFromPeer(db, peerRegistry, peer, federatedFetch, ownerUsername, {
          info: (msg) => console.log(`[sync] ${msg}`),
          warn: (msg) => console.warn(`[sync] ${msg}`),
        });
      } catch {
        // swallow
      }
    } catch (err) {
      const syncMessage = `Peer sync failed: ${String(err)}`;
      db.prepare(
        "UPDATE instances SET status = 'offline', last_sync_ok = 0, last_sync_message = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(syncMessage, peer.id);
      peers.push({
        instanceId: peer.id,
        artistCount: 0,
        albumCount: 0,
        trackCount: 0,
        errors: [syncMessage],
      });
      if (peerOperationId && syncOpService) {
        syncOpService.fail(peerOperationId, [`Peer sync failed: ${String(err)}`]);
      }
    }
    }
  }

  const pipelineReport = await runMergePipelineAsync(db, {
    logger: {
      warn: (msg) => console.warn(`[sync] ${msg}`),
      info: (msg) => console.log(`[sync] ${msg}`),
    },
  });

  if (operationId && syncOpService) {
    syncOpService.setDetails(operationId, pipelineReport);
    syncOpService.complete(operationId, localResult.artistCount, localResult.albumCount, localResult.trackCount, localResult.errors);
  }

  return { local: localResult, peers };
}
