import type Database from "better-sqlite3";
import { mergeLibraries } from "./merge.js";
import { auditOrphans, type OrphanReport } from "./orphan-audit.js";

export interface MergePipelineOptions {
  logger?: {
    warn(msg: string): void;
    info?(msg: string): void;
  };
}

/**
 * Thin orchestrator around mergeLibraries(): merge, then audit for rows
 * elsewhere in the DB left pointing at unified ids that no longer exist
 * post-rebuild. Phase 1 only merges + reports; Phase 2 (#242) adds
 * snapshot/remap to actually preserve those rows across a merge.
 */
export function runMergePipeline(
  db: Database.Database,
  opts: MergePipelineOptions = {},
): OrphanReport {
  // better-sqlite3 transactions nest via savepoints, so calling
  // mergeLibraries's own db.transaction(...) from inside this one is fine.
  const run = db.transaction(() => {
    mergeLibraries(db);
    return auditOrphans(db);
  });
  const report = run();

  if (report.total > 0) {
    opts.logger?.warn(
      `[merge-pipeline] post-merge orphans found (total=${report.total}): ` +
        `starsTrack=${report.starsTrack.count} starsAlbum=${report.starsAlbum.count} ` +
        `starsArtist=${report.starsArtist.count} playlistTracks=${report.playlistTracks.count} ` +
        `playEvents=${report.playEvents.count}`,
    );
  } else {
    opts.logger?.info?.("[merge-pipeline] post-merge orphan audit: clean");
  }

  return report;
}
