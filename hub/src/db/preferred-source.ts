import type * as Database from "better-sqlite3";

export interface PreferredSource {
  instance_id: string;
  format: string | null;
  bitrate: number | null;
  remote_id: string;
}

/**
 * The hub's preferred-source row for a unified track. Joins
 * `track_sources` to `instance_tracks` to expose the upstream
 * `remote_id`. Returns `undefined` when no source is marked preferred
 * (track exists in the unified library but every contributing instance
 * is offline / unmerged — operationally "object missing for streaming").
 *
 * Callers: `routes/sonos.ts` cast planner + `services/stream-relay.ts`
 * source picker. Both have to agree on the same row, hence one helper.
 */
export function getPreferredSource(
  db: Database.Database,
  unifiedTrackId: string,
): PreferredSource | undefined {
  return db
    .prepare(
      `SELECT ts.instance_id, ts.format, ts.bitrate, it.remote_id
         FROM track_sources ts
         JOIN instance_tracks it ON it.id = ts.instance_track_id
        WHERE ts.unified_track_id = ? AND ts.preferred = 1
        LIMIT 1`,
    )
    .get(unifiedTrackId) as PreferredSource | undefined;
}
