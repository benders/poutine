import type Database from "better-sqlite3";
import { Worker } from "node:worker_threads";
import { mergeLibraries } from "./merge.js";
import { auditOrphans, type OrphanReport } from "./orphan-audit.js";
import { applyRemap, snapshotIdentity, type RemapReport } from "./id-remap.js";

export interface MergePipelineOptions {
  logger?: {
    warn?(msg: string): void;
    info?(msg: string): void;
  };
}

export interface MergePipelineReport {
  orphans: OrphanReport;
  remap: RemapReport;
}

/**
 * Pure transactional core: snapshot the stable per-instance identities,
 * merge (rebuilds unified_* tables), remap user_stars / playlist_tracks /
 * play_events onto whatever new ids the merge produced, then audit for
 * anything still left dangling. All three steps run in one transaction —
 * never call mergeLibraries() directly outside tests, or the remap step is
 * skipped and user data is stranded on a metadata edit or dedup-key change
 * (#242).
 *
 * `run.immediate()` (rather than the default deferred `run()`) acquires the
 * write lock up front. This matters once this core also runs on a worker's
 * own connection (#242 Phase 3): a deferred transaction upgrades from a read
 * lock to a write lock on its first write, which can collide with the main
 * connection's writes mid-transaction and throw SQLITE_BUSY partway through
 * instead of blocking cleanly at the start.
 */
export function executeMergePipeline(db: Database.Database): MergePipelineReport {
  const run = db.transaction(() => {
    const snapshot = snapshotIdentity(db);
    mergeLibraries(db);
    const remap = applyRemap(db, snapshot);
    const orphans = auditOrphans(db);
    return { orphans, remap };
  });
  return run.immediate();
}

export function logPipelineReport(
  report: MergePipelineReport,
  logger: MergePipelineOptions["logger"] = {},
): void {
  const remapChanged =
    report.remap.tracks.changed + report.remap.albums.changed + report.remap.artists.changed;
  if (remapChanged > 0 || report.remap.collisionsDropped > 0) {
    logger.info?.(
      `[merge-pipeline] id remap: ` +
        `tracks=${report.remap.tracks.changed}(splits=${report.remap.tracks.splitsLogged}) ` +
        `albums=${report.remap.albums.changed}(splits=${report.remap.albums.splitsLogged}) ` +
        `artists=${report.remap.artists.changed}(splits=${report.remap.artists.splitsLogged}) ` +
        `userStars=${report.remap.userStarsUpdated} collisionsDropped=${report.remap.collisionsDropped} ` +
        `playlistTracks=${report.remap.playlistTracksUpdated} playEvents=${report.remap.playEventsUpdated}`,
    );
  }

  if (report.orphans.total > 0) {
    logger.warn?.(
      `[merge-pipeline] post-merge orphans found (total=${report.orphans.total}): ` +
        `starsTrack=${report.orphans.starsTrack.count} starsAlbum=${report.orphans.starsAlbum.count} ` +
        `starsArtist=${report.orphans.starsArtist.count} playlistTracks=${report.orphans.playlistTracks.count} ` +
        `playEvents=${report.orphans.playEvents.count}`,
    );
  } else {
    logger.info?.("[merge-pipeline] post-merge orphan audit: clean");
  }
}

/**
 * In-process merge pipeline: execute + log, synchronously, on the caller's
 * own connection. This is the path used by unit tests and in-memory DBs.
 * Production call sites go through `runMergePipelineAsync` (`merge-worker.ts`),
 * which runs this same transactional core on a `node:worker_threads` worker
 * with its own connection so the main thread's event loop isn't stalled for
 * the whole merge at 200k–600k track scale (#242 Phase 3).
 */
export function runMergePipeline(
  db: Database.Database,
  opts: MergePipelineOptions = {},
): MergePipelineReport {
  const report = executeMergePipeline(db);
  logPipelineReport(report, opts.logger);
  return report;
}

type WorkerMessage =
  | { ok: true; report: MergePipelineReport }
  | { ok: false; error: string };

// Module-level mutex + active-worker tracking. At most one merge runs at a
// time process-wide; concurrent callers queue behind `mergeQueue` — each
// still gets its own merge run (no coalescing). `activeWorker` is tracked
// separately so `shutdownMergeWorker` can terminate whatever is in flight
// during process shutdown.
let mergeQueue: Promise<unknown> = Promise.resolve();
let activeWorker: Worker | null = null;

function runInWorker(dbPath: string): Promise<MergePipelineReport> {
  return new Promise((resolvePromise, reject) => {
    const isTs = import.meta.url.endsWith(".ts");
    const entry = new URL(isTs ? "./merge-worker.ts" : "./merge-worker.js", import.meta.url);
    // `execArgv: ["--import", "tsx"]` does NOT reliably register tsx's ESM
    // hooks inside a Worker on this Node version — Node's own native
    // TypeScript type-stripping loads the `.ts` entry file regardless, then
    // fails to resolve its `.js`-specifier imports against sibling `.ts`
    // files. `merge-worker.ts` works around this itself (via `tsx/esm/api`'s
    // `tsImport`, which does its own scoped hook registration) rather than
    // depending on this flag; it's kept here only as a harmless additional
    // signal for Node versions where it does help.
    const worker = new Worker(entry, {
      workerData: { dbPath },
      ...(isTs ? { execArgv: ["--import", "tsx"] } : {}),
    });
    activeWorker = worker;

    let settled = false;
    const cleanup = () => {
      if (activeWorker === worker) activeWorker = null;
      worker.removeAllListeners();
    };

    worker.once("message", (msg: WorkerMessage) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      if (msg.ok) resolvePromise(msg.report);
      else reject(new Error(`merge-worker failed: ${msg.error}`));
    });
    worker.once("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`merge-worker exited with code ${code} before reporting a result`));
    });
  });
}

/**
 * Production entry point for the merge pipeline (#242 Phase 3). Runs
 * `executeMergePipeline` either in-process (in-memory DBs, or
 * `opts.inProcess: true` — the unit-test path) or on a dedicated
 * `node:worker_threads` worker with its own connection to the same
 * file-backed database (the production path — see `merge-worker.ts`).
 * Only one merge runs at a time process-wide; concurrent callers queue.
 * Logging happens on the main thread after the report comes back — the
 * worker itself does no logging.
 */
export function runMergePipelineAsync(
  db: Database.Database,
  opts: MergePipelineOptions & { inProcess?: boolean } = {},
): Promise<MergePipelineReport> {
  const dbPath = db.name;
  const useInProcess = opts.inProcess === true || dbPath === ":memory:" || dbPath === "";

  const task = mergeQueue.then(async () => {
    const report = useInProcess ? runMergePipeline(db, opts) : await runInWorker(dbPath);
    if (!useInProcess) logPipelineReport(report, opts.logger);
    return report;
  });

  // Keep the queue alive even if this task rejects — swallow here so a
  // failed merge doesn't wedge every subsequent queued caller; each caller
  // still observes its own rejection via the returned promise.
  mergeQueue = task.catch(() => undefined);

  return task;
}

/**
 * Terminate any in-flight merge worker and reset module state. Called from
 * `server.ts`'s `onClose` hook. Safe at any point — terminating mid-transaction
 * just rolls the transaction back; nothing is left half-applied.
 */
export async function shutdownMergeWorker(): Promise<void> {
  const worker = activeWorker;
  activeWorker = null;
  if (worker) {
    await worker.terminate();
  }
  mergeQueue = Promise.resolve();
}
