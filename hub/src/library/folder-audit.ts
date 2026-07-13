import type Database from "better-sqlite3";

/**
 * Read-only folder audit (#252).
 *
 * Detects untagged-compilation damage: one source folder whose tracks got
 * split across several per-artist "[Unknown Album]" entries because the files
 * carry no album tag. Groups instance_tracks by (instance_id, dirname(path))
 * and flags folders that span ≥ 2 instance_albums, proposing a regroup only
 * when ≥ 2 of those albums are sentinel-named.
 *
 * This is deliberately detect-and-flag only — it makes ZERO catalog changes
 * and never touches merge.ts. Automatic regrouping is out of scope because
 * rewriting album identity churns deterministic ids (docs/pitfalls.md,
 * "Merge / unified IDs"). Excludes non-active instances to match merge.ts.
 */

export interface FolderAuditCoverage {
  instanceId: string;
  instanceName: string;
  trackCount: number;
  tracksWithPath: number;
}

export interface FolderAuditAlbum {
  instanceAlbumId: string;
  name: string;
  artistName: string;
  tracksInFolder: number;
  albumTrackCount: number;
  unifiedReleaseGroupId: string | null;
}

export interface FolderAuditProposal {
  kind: "group-into-compilation";
  albumCount: number;
  trackCount: number;
}

export interface FolderAuditCluster {
  instanceId: string;
  folder: string;
  albums: FolderAuditAlbum[];
  sentinelCount: number;
  proposal: FolderAuditProposal | null;
}

export interface FolderAuditReport {
  generatedAt: string;
  coverage: FolderAuditCoverage[];
  clusters: FolderAuditCluster[];
}

// Album names that mark a track as untagged. Compared case-insensitively
// against the trimmed album name; "" catches empty/whitespace-only names.
const SENTINEL_NAMES = new Set(["[unknown album]", "unknown album", ""]);

function isSentinel(albumName: string): boolean {
  return SENTINEL_NAMES.has(albumName.trim().toLowerCase());
}

// dirname of a library-relative path: text before the last "/". A path with
// no "/" (a bare filename) groups under "".
function folderOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

export function runFolderAudit(db: Database.Database): FolderAuditReport {
  const activeInstances = db
    .prepare<[], { id: string; name: string }>(
      "SELECT id, name FROM instances WHERE lifecycle = 'active' ORDER BY name",
    )
    .all();

  // Coverage: total tracks and tracks carrying a non-NULL path per instance.
  // Older peers/rows are NULL until their next sync, so a 0% instance is
  // normal and must not crash or vanish from the report.
  const coverageStmt = db.prepare<
    [string],
    { total: number; with_path: number }
  >(
    `SELECT COUNT(*) AS total, COUNT(path) AS with_path
       FROM instance_tracks WHERE instance_id = ?`,
  );

  const coverage: FolderAuditCoverage[] = activeInstances.map((inst) => {
    const row = coverageStmt.get(inst.id) ?? { total: 0, with_path: 0 };
    return {
      instanceId: inst.id,
      instanceName: inst.name,
      trackCount: row.total,
      tracksWithPath: row.with_path,
    };
  });

  // Album metadata for every active instance, keyed by instance_album id.
  const albumStmt = db.prepare<
    [string],
    { id: string; name: string; artist_name: string; track_count: number }
  >(
    "SELECT id, name, artist_name, track_count FROM instance_albums WHERE instance_id = ?",
  );

  // Tracks with a path, so we can derive folders in JS.
  const trackStmt = db.prepare<[string], { album_id: string; path: string }>(
    "SELECT album_id, path FROM instance_tracks WHERE instance_id = ? AND path IS NOT NULL",
  );

  // Which unified release group an instance album currently feeds, for
  // click-through into the merged catalog. NULL-safe: albums not yet merged
  // (or from an unmerged instance) have no source row.
  const rgStmt = db.prepare<[string], { rgid: string }>(
    `SELECT ur.release_group_id AS rgid
       FROM unified_release_sources urs
       JOIN unified_releases ur ON urs.unified_release_id = ur.id
      WHERE urs.instance_album_id = ?
      LIMIT 1`,
  );

  const clusters: FolderAuditCluster[] = [];

  for (const inst of activeInstances) {
    const albums = new Map<
      string,
      { name: string; artistName: string; albumTrackCount: number }
    >();
    for (const a of albumStmt.all(inst.id)) {
      albums.set(a.id, {
        name: a.name,
        artistName: a.artist_name,
        albumTrackCount: a.track_count,
      });
    }

    // folder → (album_id → tracks-in-folder count)
    const folders = new Map<string, Map<string, number>>();
    for (const t of trackStmt.all(inst.id)) {
      const folder = folderOf(t.path);
      let byAlbum = folders.get(folder);
      if (!byAlbum) {
        byAlbum = new Map();
        folders.set(folder, byAlbum);
      }
      byAlbum.set(t.album_id, (byAlbum.get(t.album_id) ?? 0) + 1);
    }

    for (const [folder, byAlbum] of folders) {
      // A cluster needs ≥ 2 distinct albums sharing the folder.
      if (byAlbum.size < 2) continue;

      const clusterAlbums: FolderAuditAlbum[] = [];
      let sentinelCount = 0;
      let sentinelTracks = 0;

      for (const [albumId, tracksInFolder] of byAlbum) {
        const meta = albums.get(albumId);
        const name = meta?.name ?? "";
        const sentinel = isSentinel(name);
        if (sentinel) {
          sentinelCount += 1;
          sentinelTracks += tracksInFolder;
        }
        clusterAlbums.push({
          instanceAlbumId: albumId,
          name,
          artistName: meta?.artistName ?? "",
          tracksInFolder,
          albumTrackCount: meta?.albumTrackCount ?? 0,
          unifiedReleaseGroupId: rgStmt.get(albumId)?.rgid ?? null,
        });
      }

      // Proposal only when ≥ 2 sentinel-named albums share the folder — the
      // signature of untagged-compilation damage. Legit multi-album folders
      // (multi-disc layouts, artist folders) stay informational.
      const proposal: FolderAuditProposal | null =
        sentinelCount >= 2
          ? {
              kind: "group-into-compilation",
              albumCount: sentinelCount,
              trackCount: sentinelTracks,
            }
          : null;

      clusters.push({
        instanceId: inst.id,
        folder,
        albums: clusterAlbums,
        sentinelCount,
        proposal,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    coverage,
    clusters,
  };
}
