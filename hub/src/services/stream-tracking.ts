import type Database from "better-sqlite3";

export type StreamKind = "subsonic" | "proxy";
export type SourceKind = "local" | "peer";

export interface StreamStartOptions {
  kind: StreamKind;
  username: string;
  trackId: string;
  trackTitle: string;
  artistName: string;
  clientName?: string | null;
  clientVersion?: string | null;
  peerId?: string | null;
  sourceKind?: SourceKind | null;
  sourcePeerId?: string | null;
  format?: string | null;
  bitrate?: number | null;
  transcoded?: boolean;
  maxBitrate?: number | null;
}

export interface StreamOperation {
  id: string;
  kind: StreamKind;
  username: string;
  trackId: string;
  trackTitle: string;
  artistName: string;
  clientName: string | null;
  clientVersion: string | null;
  peerId: string | null;
  sourceKind: SourceKind | null;
  sourcePeerId: string | null;
  format: string | null;
  bitrate: number | null;
  transcoded: boolean;
  maxBitrate: number | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  bytesTransferred: number | null;
  error: string | null;
}

export interface ActiveStream extends Omit<StreamOperation, "finishedAt" | "durationMs" | "error"> {
  bytesTransferred: number;
}

interface ActiveEntry {
  opts: StreamStartOptions;
  startedAt: Date;
  bytesTransferred: number;
}

export class StreamTrackingService {
  private active = new Map<string, ActiveEntry>();
  private maxRows = 10000;

  constructor(private readonly db: Database.Database) {}

  setMaxRows(n: number): void {
    this.maxRows = Math.max(0, Math.floor(n));
    this.pruneToCount();
  }

  getMaxRows(): number {
    return this.maxRows;
  }

  start(opts: StreamStartOptions): string {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO stream_operations (
           id, kind, username, track_id, track_title, artist_name,
           client_name, client_version, peer_id,
           source_kind, source_peer_id, format, bitrate, transcoded, max_bitrate,
           started_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        id,
        opts.kind,
        opts.username,
        opts.trackId,
        opts.trackTitle,
        opts.artistName,
        opts.clientName ?? null,
        opts.clientVersion ?? null,
        opts.peerId ?? null,
        opts.sourceKind ?? null,
        opts.sourcePeerId ?? null,
        opts.format ?? null,
        opts.bitrate ?? null,
        opts.transcoded ? 1 : 0,
        opts.maxBitrate ?? null,
      );

    this.active.set(id, {
      opts,
      startedAt: new Date(),
      bytesTransferred: 0,
    });

    return id;
  }

  /**
   * Update bytes-transferred counter for an active stream (in-memory only).
   */
  updateBytes(operationId: string, bytes: number): void {
    const entry = this.active.get(operationId);
    if (entry) entry.bytesTransferred = bytes;
  }

  finish(
    operationId: string,
    bytesTransferred: number | null = null,
    error: string | null = null,
  ): void {
    this.db
      .prepare(
        `UPDATE stream_operations
         SET finished_at = datetime('now'),
             duration_ms = CAST((julianday(datetime('now')) - julianday(started_at)) * 86400000 AS INTEGER),
             bytes_transferred = ?,
             error = ?
         WHERE id = ?`,
      )
      .run(bytesTransferred, error, operationId);

    this.active.delete(operationId);
    this.pruneToCount();
  }

  getActive(): ActiveStream[] {
    return Array.from(this.active.entries()).map(([id, entry]) => ({
      id,
      kind: entry.opts.kind,
      username: entry.opts.username,
      trackId: entry.opts.trackId,
      trackTitle: entry.opts.trackTitle,
      artistName: entry.opts.artistName,
      clientName: entry.opts.clientName ?? null,
      clientVersion: entry.opts.clientVersion ?? null,
      peerId: entry.opts.peerId ?? null,
      sourceKind: entry.opts.sourceKind ?? null,
      sourcePeerId: entry.opts.sourcePeerId ?? null,
      format: entry.opts.format ?? null,
      bitrate: entry.opts.bitrate ?? null,
      transcoded: !!entry.opts.transcoded,
      maxBitrate: entry.opts.maxBitrate ?? null,
      startedAt: entry.startedAt.toISOString(),
      bytesTransferred: entry.bytesTransferred,
    }));
  }

  getRecent(limit: number = 100): StreamOperation[] {
    const rows = this.db
      .prepare(
        `SELECT id, kind, username, track_id, track_title, artist_name,
                client_name, client_version, peer_id,
                source_kind, source_peer_id, format, bitrate, transcoded, max_bitrate,
                started_at, finished_at, duration_ms, bytes_transferred, error
         FROM stream_operations
         ORDER BY started_at DESC, id DESC
         LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: r.id as string,
      kind: r.kind as StreamKind,
      username: r.username as string,
      trackId: r.track_id as string,
      trackTitle: r.track_title as string,
      artistName: r.artist_name as string,
      clientName: (r.client_name as string | null) ?? null,
      clientVersion: (r.client_version as string | null) ?? null,
      peerId: (r.peer_id as string | null) ?? null,
      sourceKind: (r.source_kind as SourceKind | null) ?? null,
      sourcePeerId: (r.source_peer_id as string | null) ?? null,
      format: (r.format as string | null) ?? null,
      bitrate: (r.bitrate as number | null) ?? null,
      transcoded: !!(r.transcoded as number),
      maxBitrate: (r.max_bitrate as number | null) ?? null,
      startedAt: r.started_at as string,
      finishedAt: (r.finished_at as string | null) ?? null,
      durationMs: (r.duration_ms as number | null) ?? null,
      bytesTransferred: (r.bytes_transferred as number | null) ?? null,
      error: (r.error as string | null) ?? null,
    }));
  }

  clearAll(): void {
    this.db.prepare("DELETE FROM stream_operations").run();
    this.active.clear();
  }

  getActiveCount(): number {
    return this.active.size;
  }

  pruneToCount(): void {
    if (this.maxRows <= 0) return;
    // Never prune rows whose stream is still active — their DB row is updated
    // on finish(), so deleting it would silently lose the result.
    this.db
      .prepare(
        `DELETE FROM stream_operations
         WHERE finished_at IS NOT NULL
           AND id NOT IN (
             SELECT id FROM stream_operations
             ORDER BY started_at DESC, id DESC
             LIMIT ?
           )`,
      )
      .run(this.maxRows);
  }
}
