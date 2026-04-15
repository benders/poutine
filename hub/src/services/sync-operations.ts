import type Database from "better-sqlite3";

export type SyncOperationType = "manual" | "auto";
export type SyncOperationScope = "local" | "peer";
export type SyncOperationStatus = "running" | "complete" | "failed";

export interface SyncOperation {
  id: string;
  type: SyncOperationType;
  scope: SyncOperationScope;
  scopeId: string | null;
  status: SyncOperationStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  artistCount: number;
  albumCount: number;
  trackCount: number;
  errors: string[];
}

export class SyncOperationService {
  constructor(private readonly db: Database.Database) {}

  /**
   * Start tracking a new sync operation.
   * Returns the operation ID for later updates.
   */
  start(
    type: SyncOperationType,
    scope: SyncOperationScope,
    scopeId: string | null = null,
  ): string {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO sync_operations (id, type, scope, scope_id, status, started_at)
         VALUES (?, ?, ?, ?, 'running', datetime('now'))`,
      )
      .run(id, type, scope, scopeId);
    return id;
  }

  /**
   * Mark a sync operation as complete with results.
   */
  complete(
    operationId: string,
    artistCount: number,
    albumCount: number,
    trackCount: number,
    errors: string[] = [],
  ): void {
    this.db
      .prepare(
        `UPDATE sync_operations
         SET status = 'complete',
             finished_at = datetime('now'),
             duration_ms = (julianday(datetime('now')) - julianday(started_at)) * 86400000,
             artist_count = ?,
             album_count = ?,
             track_count = ?,
             errors = ?
         WHERE id = ?`,
      )
      .run(artistCount, albumCount, trackCount, JSON.stringify(errors), operationId);
  }

  /**
   * Mark a sync operation as failed.
   */
  fail(operationId: string, errors: string[] = []): void {
    this.db
      .prepare(
        `UPDATE sync_operations
         SET status = 'failed',
             finished_at = datetime('now'),
             duration_ms = (julianday(datetime('now')) - julianday(started_at)) * 86400000,
             errors = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(errors), operationId);
  }

  /**
   * Get recent sync operations (last 100).
   */
  getRecent(limit: number = 100): SyncOperation[] {
    const rows = this.db
      .prepare(
        `SELECT id, type, scope, scope_id, status, started_at, finished_at,
                duration_ms, artist_count, album_count, track_count, errors
         FROM sync_operations
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
        id: string;
        type: SyncOperationType;
        scope: SyncOperationScope;
        scope_id: string | null;
        status: SyncOperationStatus;
        started_at: string;
        finished_at: string | null;
        duration_ms: number | null;
        artist_count: number;
        album_count: number;
        track_count: number;
        errors: string;
      }>;

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      scope: row.scope,
      scopeId: row.scope_id,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      artistCount: row.artist_count,
      albumCount: row.album_count,
      trackCount: row.track_count,
      errors: row.errors ? JSON.parse(row.errors) : [],
    }));
  }

  /**
   * Get currently running sync operations.
   */
  getRunning(): SyncOperation[] {
    const rows = this.db
      .prepare(
        `SELECT id, type, scope, scope_id, status, started_at, finished_at,
                duration_ms, artist_count, album_count, track_count, errors
         FROM sync_operations
         WHERE status = 'running'
         ORDER BY started_at DESC`,
      )
      .all() as Array<{
        id: string;
        type: SyncOperationType;
        scope: SyncOperationScope;
        scope_id: string | null;
        status: SyncOperationStatus;
        started_at: string;
        finished_at: string | null;
        duration_ms: number | null;
        artist_count: number;
        album_count: number;
        track_count: number;
        errors: string;
      }>;

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      scope: row.scope,
      scopeId: row.scope_id,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      artistCount: row.artist_count,
      albumCount: row.album_count,
      trackCount: row.track_count,
      errors: row.errors ? JSON.parse(row.errors) : [],
    }));
  }

  /**
   * Clear all sync operation history.
   */
  clearAll(): void {
    this.db.prepare("DELETE FROM sync_operations").run();
  }
}
