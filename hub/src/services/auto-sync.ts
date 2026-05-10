import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { SubsonicClient } from "../adapters/subsonic.js";
import { syncLocal } from "../library/sync-local.js";
import { syncPeer } from "../library/sync-peer.js";
import { mergeLibraries } from "../library/merge.js";
import { gossipFromPeer } from "../federation/gossip.js";
import { SyncOperationService } from "./sync-operations.js";
import { LastFmClient } from "./lastfm.js";
import { FanartTvClient } from "./fanarttv.js";
import type { PeerRegistry, Peer } from "../federation/peers.js";
import type { FederationFetcher } from "../library/sync-peer.js";
import { USER_AGENT } from "../version.js";

const POLL_INTERVAL_MS = 30_000;

// Issue #14: poll peers every ~5 min with up-to-60s splay to spread load
// across the cluster when many hubs restart together.
const PEER_POLL_INTERVAL_MS = 5 * 60_000;
const PEER_POLL_SPLAY_MS = 60_000;

export interface AutoSyncPeerDeps {
  peerRegistry: PeerRegistry;
  federatedFetch: FederationFetcher;
  asUser: string;
}

export class AutoSyncService {
  private localTimer: ReturnType<typeof setInterval> | null = null;
  private peerTimer: ReturnType<typeof setTimeout> | null = null;
  private localRunning = false;
  private peerRunning = false;

  constructor(
    private readonly db: Database.Database,
    private readonly config: Config,
    private readonly log: { info: (msg: string) => void; error: (msg: string) => void },
    private readonly syncOpService?: SyncOperationService,
    private readonly lastFmClient?: LastFmClient | null,
    private readonly fanartTvClient?: FanartTvClient | null,
    private readonly peerDeps?: AutoSyncPeerDeps,
  ) {}

  start(): void {
    if (this.localTimer === null) {
      this.localTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
      // unref so the timer never holds the process open during shutdown.
      this.localTimer.unref();
      this.log.info("AutoSyncService started (local poll interval 30s)");
    }
    if (this.peerTimer === null && this.peerDeps) {
      this.schedulePeerPoll();
      this.log.info("AutoSyncService peer polling started (interval ~5min ± 60s splay)");
    }
  }

  stop(): void {
    if (this.localTimer !== null) {
      clearInterval(this.localTimer);
      this.localTimer = null;
    }
    if (this.peerTimer !== null) {
      clearTimeout(this.peerTimer);
      this.peerTimer = null;
    }
  }

  private schedulePeerPoll(): void {
    const splay = Math.floor(Math.random() * PEER_POLL_SPLAY_MS);
    this.peerTimer = setTimeout(() => {
      void this.pollPeers().finally(() => {
        if (this.peerTimer !== null) this.schedulePeerPoll();
      });
    }, PEER_POLL_INTERVAL_MS + splay);
    this.peerTimer.unref();
  }

  private async poll(): Promise<void> {
    if (this.localRunning) return;
    this.localRunning = true;

    try {
      const client = new SubsonicClient({
        url: this.config.navidromeUrl,
        username: this.config.navidromeUsername,
        password: this.config.navidromePassword,
      });

      let scanStatus;
      try {
        scanStatus = await client.getScanStatus();
      } catch {
        // Navidrome not reachable yet — skip this tick
        return;
      }

      if (scanStatus.scanning) return;
      if (!scanStatus.lastScan) return;

      const lastScan = new Date(scanStatus.lastScan);

      const row = this.db
        .prepare("SELECT last_synced_at FROM instances WHERE id = 'local'")
        .get() as { last_synced_at: string | null } | undefined;

      const lastSyncedAt = row?.last_synced_at ? new Date(row.last_synced_at) : null;

      if (lastSyncedAt !== null && lastScan <= lastSyncedAt) return;

      this.log.info(
        `AutoSync: Navidrome lastScan=${scanStatus.lastScan} is newer than lastSyncedAt=${lastSyncedAt?.toISOString() ?? "never"} — syncing local library`,
      );
      // Record the operation only when we have actual work to do — avoids
      // a "running" sync row appearing every 30s for no-op poll ticks.
      const operationId = this.syncOpService?.start("auto", "local") || null;
      try {
        const result = await syncLocal(
          this.db,
          this.config,
          this.lastFmClient ?? null,
          this.fanartTvClient ?? null,
        );
        mergeLibraries(this.db);
        this.log.info(
          `AutoSync complete: ${result.artistCount} artists, ${result.albumCount} albums, ${result.trackCount} tracks`,
        );
        if (operationId && this.syncOpService) {
          this.syncOpService.complete(operationId, result.artistCount, result.albumCount, result.trackCount, result.errors);
        }
      } catch (err) {
        this.log.error(`AutoSync failed: ${String(err)}`);
        if (operationId && this.syncOpService) {
          this.syncOpService.fail(operationId, [`AutoSync failed: ${String(err)}`]);
        }
      }
    } finally {
      this.localRunning = false;
    }
  }

  /**
   * Issue #14: poll each peer's /api/health (updates last_seen), then run
   * library sync + gossip if the peer's reported scan is newer than what
   * we last pulled. Best-effort per peer; one failing peer doesn't block
   * the others. Public so tests can trigger one round without a timer.
   */
  async pollPeers(): Promise<void> {
    if (this.peerRunning) return;
    if (!this.peerDeps) return;
    this.peerRunning = true;
    let anySynced = false;
    try {
      for (const peer of this.peerDeps.peerRegistry.peers.values()) {
        try {
          const alive = await this.peerHealthCheck(peer);
          if (!alive) continue;

          if (!(await this.peerHasNewScan(peer))) continue;

          const op = this.syncOpService?.start("auto", "peer", peer.id) ?? null;
          try {
            const result = await syncPeer(
              this.db,
              peer,
              this.peerDeps.federatedFetch,
              this.peerDeps.asUser,
              this.lastFmClient ?? null,
              this.fanartTvClient ?? null,
            );
            if (op && this.syncOpService) {
              this.syncOpService.complete(op, 0, 0, result.trackCount, result.errors);
            }
            anySynced = true;
            try {
              await gossipFromPeer(
                this.db,
                this.peerDeps.peerRegistry,
                peer,
                this.peerDeps.federatedFetch,
                this.peerDeps.asUser,
                {
                  info: (msg) => this.log.info(msg),
                  warn: (msg) => this.log.error(msg),
                },
              );
            } catch {
              // older peers may 404 on /federation/peers
            }
          } catch (err) {
            if (op && this.syncOpService) {
              this.syncOpService.fail(op, [`AutoSync peer ${peer.id} failed: ${String(err)}`]);
            }
            this.db.prepare(
              "UPDATE instances SET status = 'offline', last_sync_ok = 0, last_sync_message = ?, updated_at = datetime('now') WHERE id = ?",
            ).run(String(err), peer.id);
          }
        } catch (err) {
          this.log.error(`AutoSync peer poll ${peer.id}: ${String(err)}`);
        }
      }
      if (anySynced) mergeLibraries(this.db);
    } finally {
      this.peerRunning = false;
    }
  }

  /**
   * GET {peer.url}/api/health with a short timeout. Updates last_seen on
   * success; marks status='offline' on failure. Returns alive boolean.
   */
  private async peerHealthCheck(peer: Peer): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${peer.url}/api/health`, {
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT },
      });
      if (!res.ok) {
        this.markOffline(peer.id);
        return false;
      }
      this.db
        .prepare(
          "UPDATE instances SET last_seen = datetime('now'), status = 'online', updated_at = datetime('now') WHERE id = ?",
        )
        .run(peer.id);
      return true;
    } catch {
      this.markOffline(peer.id);
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private markOffline(peerId: string): void {
    this.db
      .prepare(
        "UPDATE instances SET status = 'offline', updated_at = datetime('now') WHERE id = ?",
      )
      .run(peerId);
  }

  /**
   * Ask the peer's Navidrome (via /proxy/rest/getScanStatus, federation-
   * signed) for its lastScan timestamp. Returns true if it's newer than
   * our last_synced_at for this peer, false if older or unavailable.
   */
  private async peerHasNewScan(peer: Peer): Promise<boolean> {
    const row = this.db
      .prepare("SELECT last_synced_at FROM instances WHERE id = ?")
      .get(peer.id) as { last_synced_at: string | null } | undefined;
    const ourLast = row?.last_synced_at ? new Date(row.last_synced_at) : null;
    if (!ourLast) return true; // never synced — go.

    if (!this.peerDeps) return false;
    try {
      const proxyPeer: Peer = { ...peer, url: peer.proxyUrl };
      const res = await this.peerDeps.federatedFetch(
        proxyPeer,
        "/proxy/rest/getScanStatus?f=json&v=1.16.1&c=poutine-autosync",
        { asUser: this.peerDeps.asUser },
      );
      if (!res.ok) return true; // can't tell — sync to be safe
      const body = (await res.json()) as {
        "subsonic-response"?: { scanStatus?: { lastScan?: string } };
      };
      const lastScan = body["subsonic-response"]?.scanStatus?.lastScan;
      if (!lastScan) return true;
      return new Date(lastScan) > ourLast;
    } catch {
      return true; // unknown — try sync, will surface real failure
    }
  }
}
