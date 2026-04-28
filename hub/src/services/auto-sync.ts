import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { SubsonicClient } from "../adapters/subsonic.js";
import { syncLocal } from "../library/sync-local.js";
import { mergeLibraries } from "../library/merge.js";
import { SyncOperationService } from "./sync-operations.js";
import { LastFmClient } from "./lastfm.js";

const POLL_INTERVAL_MS = 30_000;

export class AutoSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly db: Database.Database,
    private readonly config: Config,
    private readonly log: { info: (msg: string) => void; error: (msg: string) => void },
    private readonly syncOpService?: SyncOperationService,
    private readonly lastFmClient?: LastFmClient | null,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.log.info("AutoSyncService started (poll interval 30s)");
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;

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
        const result = await syncLocal(this.db, this.config, this.lastFmClient ?? null);
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
      this.running = false;
    }
  }
}
