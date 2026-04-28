import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import type { Peer, PeerRegistry } from "../federation/peers.js";
import { syncPeer } from "../library/sync-peer.js";
import type { FederationFetcher } from "../library/sync-peer.js";
import { mergeLibraries } from "../library/merge.js";
import type { LastFmClient } from "./lastfm.js";
import { SyncOperationService } from "./sync-operations.js";
import { USER_AGENT } from "../version.js";

export class PeerAutoSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly db: Database.Database,
    private readonly config: Config,
    private readonly peerRegistry: PeerRegistry,
    private readonly federatedFetch: FederationFetcher,
    private readonly ownerUsername: string,
    private readonly log: { info: (msg: string) => void; error: (msg: string) => void; debug: (msg: string) => void },
    private readonly lastFmClient: LastFmClient | null = null,
    private readonly syncOpService?: SyncOperationService,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    
    // Do initial sync immediately
    void this.checkAndSync();
    
    const intervalMs = this.config.peerSyncIntervalSeconds * 1000;
    this.timer = setInterval(() => void this.checkAndSync(), intervalMs);
    this.log.info(`PeerAutoSyncService started (interval: ${this.config.peerSyncIntervalSeconds}s)`);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async checkAndSync(): Promise<void> {
    if (this.running) {
      this.log.debug("PeerAutoSync: already running, skipping tick");
      return;
    }

    const runningSync = this.db
      .prepare("SELECT id FROM sync_operations WHERE status = 'running' LIMIT 1")
      .get() as { id: string } | undefined;

    if (runningSync) {
      this.log.debug(`PeerAutoSync: sync operation ${runningSync.id} is running, skipping tick`);
      return;
    }

    this.running = true;

    try {
      const peers = Array.from(this.peerRegistry.peers.values());
      if (peers.length === 0) return;

      const results = await Promise.allSettled(
        peers.map(async (peer) => {
          await this.checkAndSyncPeer(peer);
        })
      );

      // Merge libraries once after all peers processed
      mergeLibraries(this.db);
    } finally {
      this.running = false;
    }
  }

  private async checkAndSyncPeer(peer: Peer): Promise<void> {
    // Check for concurrent sync at peer level too
    const runningSync = this.db
      .prepare("SELECT id FROM sync_operations WHERE status = 'running' LIMIT 1")
      .get() as { id: string } | undefined;

    if (runningSync) {
      this.log.debug(`[${peer.id}] sync operation ${runningSync.id} is running, skipping`);
      return;
    }

    const health = await this.healthCheckPeer(peer);
    
    if (!health) {
      this.log.debug(`[${peer.id}] peer is offline or unreachable, skipping sync`);
      return;
    }

    const peerNavidromeSync = health.lastNavidromeSync ? new Date(health.lastNavidromeSync) : null;

    const row = this.db
      .prepare("SELECT last_synced_at FROM instances WHERE id = ?")
      .get(peer.id) as { last_synced_at: string | null } | undefined;
    
    const lastPeerSync = row?.last_synced_at ? new Date(row.last_synced_at) : null;

    if (peerNavidromeSync === null) {
      this.log.debug(`[${peer.id}] peer lastNavidromeSync is null, skipping sync`);
      return;
    }

    if (lastPeerSync !== null && peerNavidromeSync <= lastPeerSync) {
      this.log.debug(`[${peer.id}] no sync needed (peer navidrome sync is not newer than our last sync)`);
      return;
    }

    const reason = lastPeerSync === null ? "never synced" : `peer navidrome sync is newer than our last sync`;
    this.log.info(`[${peer.id}] syncing peer - ${reason}`);

    const operationId = this.syncOpService?.start("auto", "peer", peer.id) || null;

    try {
      const result = await syncPeer(
        this.db,
        peer,
        this.federatedFetch,
        this.ownerUsername,
        this.lastFmClient,
      );

      this.log.info(
        `[${peer.id}] sync complete: ${result.artistCount} artists, ${result.albumCount} albums, ${result.trackCount} tracks`,
      );

      if (operationId && this.syncOpService) {
        this.syncOpService.complete(operationId, result.artistCount, result.albumCount, result.trackCount, result.errors);
      }
    } catch (err) {
      this.log.error(`[${peer.id}] sync failed: ${String(err)}`);
      if (operationId && this.syncOpService) {
        this.syncOpService.fail(operationId, [`Peer sync failed: ${String(err)}`]);
      }
      
      this.db
        .prepare(
          "UPDATE instances SET status = 'offline', last_sync_ok = 0, last_sync_message = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(`Peer sync failed: ${String(err)}`, peer.id);
    }
  }

  private async healthCheckPeer(peer: { id: string; url: string }): Promise<{ lastNavidromeSync: string | null } | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const res = await fetch(`${peer.url}/api/health`, {
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT },
      });
      
      clearTimeout(timeout);
      
      if (!res.ok) return null;
      
      const health = await res.json() as { lastNavidromeSync?: string | null };
      return { lastNavidromeSync: health.lastNavidromeSync ?? null };
    } catch {
      return null;
    }
  }
}
