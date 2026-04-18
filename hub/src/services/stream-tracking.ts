import type Database from "better-sqlite3";

export interface StreamOperation {
  id: string;
  username: string;
  trackId: string;
  trackTitle: string;
  artistName: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  bytesTransferred: number | null;
}

export interface ActiveStream {
  id: string;
  username: string;
  trackId: string;
  trackTitle: string;
  artistName: string;
  startedAt: string;
  durationMs: number | null; // null if still playing
}

/**
 * In-memory tracking of currently active streams.
 * Keys are stream operation IDs.
 */
interface ActiveStreamEntry {
  operationId: string;
  username: string;
  trackId: string;
  trackTitle: string;
  artistName: string;
  startedAt: Date;
}

export class StreamTrackingService {
  private activeStreams = new Map<string, ActiveStreamEntry>();

  constructor(private readonly db: Database.Database) {}

  /**
   * Start tracking a new stream.
   * Returns the operation ID for later updates.
   */
  start(
    username: string,
    trackId: string,
    trackTitle: string,
    artistName: string,
  ): string {
    const id = crypto.randomUUID();
    
    // Insert into database
    this.db
      .prepare(
        `INSERT INTO stream_operations (id, username, track_id, track_title, artist_name, started_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(id, username, trackId, trackTitle, artistName);

    // Track in memory as active
    this.activeStreams.set(id, {
      operationId: id,
      username,
      trackId,
      trackTitle,
      artistName,
      startedAt: new Date(),
    });

    return id;
  }

  /**
   * Mark a stream as finished with optional duration and bytes.
   */
  finish(operationId: string, durationMs: number | null = null, bytesTransferred: number | null = null): void {
    // Update database
    this.db
      .prepare(
        `UPDATE stream_operations
         SET finished_at = datetime('now'),
             duration_ms = ?,
             bytes_transferred = ?
         WHERE id = ?`,
      )
      .run(durationMs, bytesTransferred, operationId);

    // Remove from active streams
    this.activeStreams.delete(operationId);
  }

  /**
   * Get currently active streams.
   */
  getActive(): ActiveStream[] {
    const now = new Date();
    return Array.from(this.activeStreams.values()).map((entry) => ({
      id: entry.operationId,
      username: entry.username,
      trackId: entry.trackId,
      trackTitle: entry.trackTitle,
      artistName: entry.artistName,
      startedAt: entry.startedAt.toISOString(),
      durationMs: null, // Still playing
    }));
  }

  /**
   * Get recent stream history (last 100).
   */
  getRecent(limit: number = 100): StreamOperation[] {
    const rows = this.db
      .prepare(
        `SELECT id, username, track_id, track_title, artist_name, started_at, finished_at,
                duration_ms, bytes_transferred
         FROM stream_operations
        ORDER BY started_at DESC, id DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
        id: string;
        username: string;
        track_id: string;
        track_title: string;
        artist_name: string;
        started_at: string;
        finished_at: string | null;
        duration_ms: number | null;
        bytes_transferred: number | null;
      }>;

    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      trackId: row.track_id,
      trackTitle: row.track_title,
      artistName: row.artist_name,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      bytesTransferred: row.bytes_transferred,
    }));
  }

  /**
   * Clear all stream history.
   */
  clearAll(): void {
    this.db.prepare("DELETE FROM stream_operations").run();
    this.activeStreams.clear();
  }

  /**
   * Get a count of active streams.
   */
  getActiveCount(): number {
    return this.activeStreams.size;
  }
}
