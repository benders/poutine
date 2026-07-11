import Database from "better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";

/**
 * Worker entry for the merge pipeline (#242 Phase 3). Runs on its OWN
 * connection to `workerData.dbPath` so the main thread's WAL readers (and,
 * once the busy timeout elapses, writers) are never blocked by better-sqlite3
 * synchronously holding the whole event loop hostage for the duration of a
 * 200k–600k track merge. Spawned and awaited by `runMergePipelineAsync` in
 * `merge-pipeline.ts` — never construct this Worker directly from anywhere
 * else.
 *
 * Deliberately dependency-light: this file is loaded in a worker context
 * (dev/test load the `.ts` source below via `tsx/esm/api`'s `tsImport`; prod
 * loads the compiled `.js` directly with plain dynamic `import()`), so it
 * must not pull in fastify, routes, or services.
 *
 * NOTE: renaming or moving this file requires updating both the dev/test
 * (`.ts`) and prod (`dist/.js`) resolution branches in
 * `runMergePipelineAsync` — see `docs/pitfalls.md` ("Merge / unified IDs").
 */

/**
 * Node 22's native TypeScript support transpiles this entry file directly
 * when it's loaded as `.ts` (no tsx needed to get *this* far) — but it only
 * strips types, it does not remap `.js` specifiers to sibling `.ts` files.
 * A plain `import("./merge-pipeline.js")` from here would fail to resolve
 * under `.ts` (the transitive `merge.js`/`id-remap.js` specifiers inside
 * `merge-pipeline.ts` would fail the same way one level down).
 *
 * `execArgv: ["--import", "tsx"]` on the `Worker` constructor does NOT
 * reliably register tsx's ESM hooks for a worker thread on this Node
 * version — confirmed by hand: the entry loads via native stripping
 * regardless, and its own `.js`-specifier imports still fail to resolve.
 * `tsx/esm/api`'s `tsImport(specifier, parentURL)` sidesteps that: it does
 * the hook registration + import itself, scoped to this call, and reliably
 * works inside a worker thread. In prod, the compiled `dist/*.js` tree has
 * real `.js` files at every one of those specifiers, so this branch is a
 * no-op and a plain dynamic import resolves normally.
 */
async function loadExecuteMergePipeline() {
  const isTs = import.meta.url.endsWith(".ts");
  if (isTs) {
    // Non-literal specifiers and dynamic package import so `tsc` treats
    // these as opaque rather than trying (and failing) to resolve a
    // `.ts`-extensioned module path or find type declarations for `tsx`.
    const tsxApiSpecifier: string = "tsx/esm/api";
    const { tsImport } = (await import(tsxApiSpecifier)) as {
      tsImport: (specifier: string, parentURL: string) => Promise<{ executeMergePipeline: typeof import("./merge-pipeline.js").executeMergePipeline }>;
    };
    const pipelineSpecifier: string = ["./merge-pipeline", ".ts"].join("");
    const mod = await tsImport(pipelineSpecifier, import.meta.url);
    return mod.executeMergePipeline;
  }
  const mod = await import("./merge-pipeline.js");
  return mod.executeMergePipeline;
}

async function main(): Promise<void> {
  const { dbPath } = workerData as { dbPath: string };
  const executeMergePipeline = await loadExecuteMergePipeline();
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    const report = executeMergePipeline(db);
    parentPort?.postMessage({ ok: true, report });
  } catch (err) {
    parentPort?.postMessage({ ok: false, error: String(err) });
  } finally {
    db.close();
  }
}

void main();
