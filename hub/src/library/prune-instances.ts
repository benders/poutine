import type Database from "better-sqlite3";
import type { PeerRegistry } from "../federation/peers.js";

export interface PruneResult {
  removed: string[];
}

/**
 * Remove `instances` rows (and cascaded instance_* and unified_source rows) for any
 * peer that is no longer present in peers.yaml. The synthetic `local` row is
 * always preserved. FK `ON DELETE CASCADE` handles instance_artists / _albums /
 * _tracks and the unified_*_sources / track_sources join tables. Orphan
 * unified_* rows are cleaned up by the next mergeLibraries() call.
 */
export function pruneOrphanInstances(
  db: Database.Database,
  peerRegistry: PeerRegistry,
): PruneResult {
  const allowed = new Set<string>(["local", ...peerRegistry.peers.keys()]);

  const rows = db
    .prepare("SELECT id FROM instances")
    .all() as Array<{ id: string }>;

  const orphans = rows.map((r) => r.id).filter((id) => !allowed.has(id));
  if (orphans.length === 0) return { removed: [] };

  const del = db.prepare("DELETE FROM instances WHERE id = ?");
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) del.run(id);
  });
  tx(orphans);

  return { removed: orphans };
}
