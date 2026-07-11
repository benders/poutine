import type Database from "better-sqlite3";
import { mergeLibraries } from "./merge.js";
import { auditOrphans, type OrphanReport } from "./orphan-audit.js";
import { applyRemap, snapshotIdentity, type RemapReport } from "./id-remap.js";

export interface MergePipelineOptions {
  logger?: {
    warn(msg: string): void;
    info?(msg: string): void;
  };
}

export interface MergePipelineReport {
  orphans: OrphanReport;
  remap: RemapReport;
}

/**
 * Orchestrator around mergeLibraries(): snapshot the stable per-instance
 * identities, merge (rebuilds unified_* tables), remap user_stars /
 * playlist_tracks / play_events onto whatever new ids the merge produced,
 * then audit for anything still left dangling. All three steps run in one
 * transaction — never call mergeLibraries() directly outside tests, or the
 * remap step is skipped and user data is stranded on a metadata edit or
 * dedup-key change (#242).
 */
export function runMergePipeline(
  db: Database.Database,
  opts: MergePipelineOptions = {},
): MergePipelineReport {
  // better-sqlite3 transactions nest via savepoints, so calling
  // mergeLibraries's own db.transaction(...) from inside this one is fine.
  const run = db.transaction(() => {
    const snapshot = snapshotIdentity(db);
    mergeLibraries(db);
    const remap = applyRemap(db, snapshot);
    const orphans = auditOrphans(db);
    return { orphans, remap };
  });
  const report = run();

  const remapChanged =
    report.remap.tracks.changed + report.remap.albums.changed + report.remap.artists.changed;
  if (remapChanged > 0 || report.remap.collisionsDropped > 0) {
    opts.logger?.info?.(
      `[merge-pipeline] id remap: ` +
        `tracks=${report.remap.tracks.changed}(splits=${report.remap.tracks.splitsLogged}) ` +
        `albums=${report.remap.albums.changed}(splits=${report.remap.albums.splitsLogged}) ` +
        `artists=${report.remap.artists.changed}(splits=${report.remap.artists.splitsLogged}) ` +
        `userStars=${report.remap.userStarsUpdated} collisionsDropped=${report.remap.collisionsDropped} ` +
        `playlistTracks=${report.remap.playlistTracksUpdated} playEvents=${report.remap.playEventsUpdated}`,
    );
  }

  if (report.orphans.total > 0) {
    opts.logger?.warn(
      `[merge-pipeline] post-merge orphans found (total=${report.orphans.total}): ` +
        `starsTrack=${report.orphans.starsTrack.count} starsAlbum=${report.orphans.starsAlbum.count} ` +
        `starsArtist=${report.orphans.starsArtist.count} playlistTracks=${report.orphans.playlistTracks.count} ` +
        `playEvents=${report.orphans.playEvents.count}`,
    );
  } else {
    opts.logger?.info?.("[merge-pipeline] post-merge orphan audit: clean");
  }

  return report;
}
