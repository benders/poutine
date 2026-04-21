/**
 * peer-sync.ts
 *
 * Automatic peer synchronization service.
 *
 * Checks peers on a configurable frequency (default 5 minutes with ±30s splay)
 * and syncs if the peer's last Navidrome sync was more recent than our last
 * peer sync.
 *
 * Updates last_seen on successful health checks and last_synced_at on successful
 * peer syncs.
 */

import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import type { PeerRegistry, Peer } from "../federation/peers.js";
import type { FederationFetcher } from "../library/sync-peer.js";
import { syncPeer } from "../library/sync-peer.js";
import { SyncOperationService } from "./sync-operations.js";
import type { LastFmClient } from "./lastfm.js";
import { USER_AGENT } from "../version.js";

const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SPLAY_RANGE_MS = 30 * 1000; // ±30 seconds

export class PeerSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private splayMs: number;

  constructor(
    private readonly db: Database.Database,
    private readonly config: Config,
    private readonly peerRegistry: PeerRegistry,
    private readonly federatedFetch: FederationFetcher,
    private readonly log: { info: (msg: string) => void; error: (msg: string) => void },
    private readonly syncOpService?: SyncOperationService,
    private readonly lastFmClient?: LastFmClient | null,
    private readonly ownerUsername?: string,
    intervalMs: number = DEFAULT_SYNC_INTERVAL_MS,
  ) {
    // Add random splay to avoid thundering herd
    this.splayMs = Math.floor(Math.random() * (SPLAY_RANGE_MS * 2)) - SPLAY_RANGE_MS;
    this.log.info(
      `PeerSyncService initialized with interval ${intervalMs}ms and splay ${this.splayMs}ms`,
    );
  }

  start(): void {
    if (this.timer !== null) return;

    const intervalWithSplay = Math.max(
      60_000, // Minimum 1 minute
      DEFAULT_SYNC_INTERVAL_MS + this.splayMs,
    );

    this.timer = setInterval(() => void this.checkAndSync(), intervalWithSplay);
    this.log.info(
      `PeerSyncService started (check interval ${intervalWithSplay}ms)`,
    );
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log.info("PeerSyncService stopped");
  }

  /**
   * Check if any sync is currently running (manual or auto).
   * Returns true if a sync is in progress.
   */
  private isSyncRunning(): boolean {
    const running = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM sync_operations WHERE status = 'running'",
      )
      .get() as { count: number };
    return running.count > 0;
  }

  /**
   * Get the last time we synced with a specific peer.
   */
  private getLastPeerSync(peerId: string): Date | null {
    const row = this.db
      .prepare(
        "SELECT last_synced_at FROM instances WHERE id = ?",
      )
      .get(peerId) as { last_synced_at: string | null } | undefined;

    if (!row?.last_synced_at) return null;
    return new Date(row.last_synced_at);
  }

  /**
   * Update last_seen for a peer (called on health checks).
   */
  private updateLastSeen(peerId: string): void {
    this.db
      .prepare(
        "UPDATE instances SET last_seen = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      )
      .run(peerId);
  }

  /**
   * Check a single peer's health and update last_seen.
   * Returns the peer's last Navidrome sync timestamp if available.
   */
  private async checkPeerHealth(peer: Peer): Promise<Date | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(`${peer.url}/api/health`, {
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT },
      });

      if (!res.ok) {
        this.log.info(`[${peer.id}] health check failed: ${res.status}`);
        return null;
      }

      const health = await res.json() as {
        lastNavidromeSync?: string | null;
      };

      // Update last_seen on successful health check
      this.updateLastSeen(peer.id);

      if (health.lastNavidromeSync) {
        return new Date(health.lastNavidromeSync);
      }

      return null;
    } catch (err) {
      this.log.info(`[${peer.id}] health check error: ${String(err)}`);
      // Still update last_seen even on error (we attempted contact)
      this.updateLastSeen(peer.id);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Sync a single peer if needed.
   */
  private async syncPeerIfNeeded(peer: Peer): Promise<void> {
    // Get peer's last Navidrome sync time
    const peerNavidromeSync = await this.checkPeerHealth(peer);
    if (!peerNavidromeSync) {
      this.log.info(
        `[${peer.id}] skipping sync — could not determine peer's Navidrome sync time`,
      );
      return;
    }

    // Get our last sync time with this peer
    const ourLastSync = this.getLastPeerSync(peer.id);

    // Only sync if peer's Navidrome sync is newer than our last peer sync
    if (ourLastSync && peerNavidromeSync <= ourLastSync) {
      this.log.info(
        `[${peer.id}] skipping sync — peer's last Navidrome sync (${peerNavidromeSync.toISOString()}) is not newer than our last sync (${ourLastSync.toISOString()})`,
      );
      return;
    }

    this.log.info(
      `[${peer.id}] syncing — peer's last Navidrome sync (${peerNavidromeSync.toISOString()}) is newer than our last sync (${ourLastSync?.toISOString() ?? "never"})`,
    );

    // Start tracking the sync operation
    const operationId = this.syncOpService?.start("auto", "peer", peer.id) || null;

    try {
      const result = await syncPeer(
        this.db,
        peer,
        this.federatedFetch,
        this.ownerUsername || "system",
        this.lastFmClient ?? null,
        {
          concurrency: this.config.instanceConcurrency,
          log: {
            info: (msg) => this.log.info(`[${peer.id}] ${msg}`),
            error: (msg) => this.log.error(`[${peer.id}] ${msg}`),
          },
        },
      );

      this.log.info(
        `[${peer.id}] sync complete: ${result.artistCount} artists, ${result.albumCount} albums, ${result.trackCount} tracks`,
      );

      if (operationId && this.syncOpService) {
        this.syncOpService.complete(
          operationId,
          result.artistCount,
          result.albumCount,
          result.trackCount,
          result.errors,
        );
      }
    } catch (err) {
      this.log.error(`[${peer.id}] sync failed: ${String(err)}`);
      if (operationId && this.syncOpService) {
        this.syncOpService.fail(operationId, [`Peer sync failed: ${String(err)}`]);
      }
    }
  }

  /**
   * Main check and sync loop.
   */
  private async checkAndSync(): Promise<void> {
    if (this.running) {
      this.log.info("Peer sync already in progress, skipping this interval");
      return;
    }

    if (this.isSyncRunning()) {
      this.log.info("Another sync (manual or local) is running, skipping peer sync");
      return;
    }

    this.running = true;

    try {
      const peers = Array.from(this.peerRegistry.peers.values());
      if (peers.length === 0) {
        return; // No peers configured
      }

      this.log.info(`Checking ${peers.length} peer(s) for sync`);

      // Sync peers sequentially (same as syncAll)
      for (const peer of peers) {
        await this.syncPeerIfNeeded(peer);
      }
    } finally {
      this.running = false;
    }
  }
}
