import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { SubsonicClient } from "../adapters/subsonic.js";
import { syncLocal } from "../library/sync-local.js";
import { mergeLibraries } from "../library/merge.js";

const POLL_INTERVAL_MS = 30_000;

export class AutoSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly db: Database.Database,
    private readonly config: Config,
    private readonly log: { info: (msg: string) => void; error: (msg: string) => void },
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

    this.running = true;
    this.log.info(
      `AutoSync: Navidrome lastScan=${scanStatus.lastScan} is newer than lastSyncedAt=${lastSyncedAt?.toISOString() ?? "never"} — syncing local library`,
    );
    try {
      const result = await syncLocal(this.db, this.config);
      mergeLibraries(this.db);
      this.log.info(
        `AutoSync complete: ${result.artistCount} artists, ${result.albumCount} albums, ${result.trackCount} tracks`,
      );
    } catch (err) {
      this.log.error(`AutoSync failed: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
