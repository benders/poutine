/**
 * peer-sync.ts
 *
 * Automatic peer synchronization service (issue #14).
 *
 * - Checks peers on a configurable interval (default 5 minutes) with random splay (±30s)
 * - Updates "Last Seen" on successful health checks
 * - Syncs when peer's last Navidrome sync is newer than our last sync with them
 * - Guards against concurrent syncs (automated or manual)
 */

import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import type { PeerRegistry, Peer } from "../federation/peers.js";
import { syncPeer } from "../library/sync-peer.js";
import type { FederationFetcher } from "../library/sync-peer.js";
import { USER_AGENT } from "../version.js";
import type { LastFmClient } from "./lastfm.js";

interface SyncDecision {
  shouldSync: boolean;
  peerLastNavidromeSync: Date | null;
  ourLastSyncWithPeer: Date | null;
  reason: string;
}

export class PeerSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly db: Database.Database,
    private readonly config: Config,
    private readonly peerRegistry: PeerRegistry,
    private readonly federatedFetch: FederationFetcher,
    private readonly ownerUsername: string,
    private readonly log: { info: (msg: string) => void; debug: (msg: string) => void; error: (msg: string) => void; warn: (msg: string) => void },
    private readonly lastFmClient: LastFmClient | null = null,
  ) {}

  /**
   * Start the automatic peer sync service.
   * @param initialDelayMs - Optional delay before first sync (for splay)
   */
  start(initialDelayMs?: number): void {
    if (this.timer !== null) return;

    const delay = initialDelayMs ?? this.calculateSplayedDelay();

    this.log.info(`PeerSyncService starting — first check in ${Math.round(delay / 1000)}s, then every ${Math.round(this.config.peerSyncIntervalMs / 1000)}s`);

    // Initial delayed start
    const initialTimer = setTimeout(() => {
      this.timer = setInterval(() => void this.checkAndSync(), this.config.peerSyncIntervalMs);
      void this.checkAndSync();
    }, delay);

    // Handle startup by clearing the initial timer when first check runs
    const originalCheck = this.checkAndSync.bind(this);
    this.checkAndSync = async () => {
      clearTimeout(initialTimer);
      this.checkAndSync = originalCheck;
      await originalCheck();
    };
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log.info("PeerSyncService stopped");
  }

  /**
   * Calculate a splayed delay for initial startup to avoid thundering herd.
   * Returns a random value between (interval - splay) and (interval + splay).
   */
  private calculateSplayedDelay(): number {
    const splayMs = this.config.peerSyncSplayMs;
    const baseMs = this.config.peerSyncIntervalMs;
    const minMs = Math.max(0, baseMs - splayMs);
    const maxMs = baseMs + splayMs;
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  }

  /**
   * Main sync loop: check all peers and sync when appropriate.
   */
  private async checkAndSync(): Promise<void> {
    if (this.running) {
      this.log.debug("PeerSyncService tick skipped — sync already running");
      return;
    }

    // Check for any running sync operations (manual or auto)
    const runningSyncs = this.getRunningSyncCount();
    if (runningSyncs > 0) {
      this.log.debug(`PeerSyncService tick skipped — ${runningSyncs} sync operation(s) already running`);
      return;
    }

    this.running = true;

    try {
      await this.syncAllPeers();
    } catch (err) {
      this.log.error(`PeerSyncService error: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Count running sync operations from sync_operations table.
   */
  private getRunningSyncCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM sync_operations WHERE status = 'running'")
      .get() as { count: number };
    return row.count;
  }

  /**
   * Check and sync all configured peers.
   */
  private async syncAllPeers(): Promise<void> {
    const peers = Array.from(this.peerRegistry.peers.values());

    if (peers.length === 0) {
      this.log.debug("PeerSyncService — no peers configured");
      return;
    }

    this.log.info(`PeerSyncService checking ${peers.length} peer(s)`);

    for (const peer of peers) {
      await this.checkAndSyncPeer(peer);
    }
  }

  /**
   * Check a single peer and sync if needed.
   */
  private async checkAndSyncPeer(peer: Peer): Promise<void> {
    // Perform health check and update last_seen
    const health = await this.healthCheckPeer(peer);
    if (!health) {
      this.log.debug(`[${peer.id}] peer unreachable — last_seen updated, skipping sync`);
      return;
    }

    // Update last_seen in database
    this.updateLastSeen(peer.id);

    // Get last Navidrome sync from peer's health response
    const peerLastNavidromeSync = health.lastNavidromeSync ? new Date(health.lastNavidromeSync) : null;

    // Get our last sync with this peer
    const ourLastSync = this.getLastSyncWithPeer(peer.id);

    // Decide whether to sync
    const decision = this.decideSync(peer, peerLastNavidromeSync, ourLastSync);

    this.log.info(`[${peer.id}] ${decision.reason}`);

    if (!decision.shouldSync) {
      return;
    }

    // Perform sync
    await this.syncPeer(peer);
  }

  /**
   * Perform health check on a peer.
   * Updates last_seen regardless of sync decision.
   */
  private async healthCheckPeer(peer: Peer): Promise<PeerHealth | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.instanceTimeoutMs);

    try {
      const res = await fetch(`${peer.url}/api/health`, {
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT },
      });

      if (!res.ok) {
        this.log.debug(`[${peer.id}] health check failed — status ${res.status}`);
        return null;
      }

      const health = (await res.json()) as PeerHealth;
      this.log.debug(`[${peer.id}] health check OK — lastNavidromeSync=${health.lastNavidromeSync ?? "never"}`);
      return health;
    } catch (err) {
      this.log.debug(`[${peer.id}] health check failed — ${String(err)}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Update last_seen timestamp for a peer.
   */
  private updateLastSeen(peerId: string): void {
    this.db
      .prepare(
        "UPDATE instances SET last_seen = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      )
      .run(peerId);
  }

  /**
   * Get our last sync timestamp with a peer.
   */
  private getLastSyncWithPeer(peerId: string): Date | null {
    const row = this.db
      .prepare("SELECT last_synced_at FROM instances WHERE id = ?")
      .get(peerId) as { last_synced_at: string | null } | undefined;

    if (!row?.last_synced_at) return null;
    return new Date(row.last_synced_at);
  }

  /**
   * Decide whether to sync with a peer based on timestamps.
   */
  private decideSync(
    peer: Peer,
    peerLastNavidromeSync: Date | null,
    ourLastSyncWithPeer: Date | null,
  ): SyncDecision {
    // If peer has never synced with Navidrome, no point syncing
    if (!peerLastNavidromeSync) {
      return {
        shouldSync: false,
        peerLastNavidromeSync: null,
        ourLastSyncWithPeer,
        reason: "peer has never synced with Navidrome — skipping",
      };
    }

    // If we've never synced with this peer, sync now
    if (!ourLastSyncWithPeer) {
      return {
        shouldSync: true,
        peerLastNavidromeSync,
        ourLastSyncWithPeer: null,
        reason: "first sync with peer — syncing",
      };
    }

    // Sync if peer's Navidrome sync is newer than our last sync with them
    if (peerLastNavidromeSync > ourLastSyncWithPeer) {
      return {
        shouldSync: true,
        peerLastNavidromeSync,
        ourLastSyncWithPeer,
        reason: `peer's Navidrome sync (${peerLastNavidromeSync.toISOString()}) is newer than our last sync (${ourLastSyncWithPeer.toISOString()}) — syncing`,
      };
    }

    return {
      shouldSync: false,
      peerLastNavidromeSync,
      ourLastSyncWithPeer,
      reason: `peer's Navidrome sync (${peerLastNavidromeSync.toISOString()}) is not newer than our last sync (${ourLastSyncWithPeer.toISOString()}) — skipping`,
    };
  }

  /**
   * Perform a full sync with a peer.
   */
  private async syncPeer(peer: Peer): Promise<void> {
    this.log.info(`[${peer.id}] starting sync`);

    try {
      const result = await syncPeer(
        this.db,
        peer,
        this.federatedFetch,
        this.ownerUsername,
        this.lastFmClient,
        {
          concurrency: this.config.instanceConcurrency,
          log: {
            info: (msg) => this.log.info(`[${peer.id}] ${msg}`),
            error: (msg) => this.log.error(`[${peer.id}] ${msg}`),
          },
        },
      );

      // Update last_synced_at and mark sync as successful
      this.db
        .prepare(
          `UPDATE instances SET 
             last_synced_at = datetime('now'),
             last_sync_ok = 1,
             last_sync_message = NULL,
             track_count = ?,
             status = 'online',
             updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(result.trackCount, peer.id);

      this.log.info(
        `[${peer.id}] sync complete — ${result.artistCount} artists, ${result.albumCount} albums, ${result.trackCount} tracks`,
      );
    } catch (err) {
      // Update last_synced_at but mark as failed
      this.db
        .prepare(
          `UPDATE instances SET 
             last_synced_at = datetime('now'),
             last_sync_ok = 0,
             last_sync_message = ?,
             status = 'offline',
             updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(`Sync failed: ${String(err)}`, peer.id);

      this.log.error(`[${peer.id}] sync failed — ${String(err)}`);
    }
  }
}

interface PeerHealth {
  status: string;
  appVersion?: string;
  apiVersion?: number;
  lastNavidromeSync?: string | null;
}
