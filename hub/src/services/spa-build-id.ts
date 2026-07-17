/**
 * SPA build identity for the auto-update signal (issue #196).
 *
 * The buildId is a short content hash of the on-disk `${staticDir}/index.html`.
 * Vite content-hashes every JS/CSS chunk filename, and dynamic-import chunk
 * names cascade up into the entry chunk's hash, so any rebuild — even one that
 * doesn't bump APP_VERSION — changes index.html and therefore the buildId.
 * Reading from disk per request (behind an mtime+size cache) means a new
 * build dropped into staticDir is detected without restarting the hub.
 *
 * The SPA treats any *difference* between the buildId it booted with and the
 * one the hub reports as "update available" — hashes have no ordering, and a
 * rollback should propagate the same way as an upgrade.
 */

import { createHash } from "node:crypto";
import { stat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Returned when the hub runs without a staticDir (dev — Vite serves the SPA). */
export const DEV_BUILD_ID = "dev";
/** Returned when staticDir is set but index.html can't be read. */
export const UNKNOWN_BUILD_ID = "unknown";

export type SpaBuildIdReader = () => Promise<string>;

/**
 * Create a buildId reader bound to a staticDir. The hash is recomputed only
 * when index.html's mtime or size changes; the steady-state cost per call is
 * one stat(). Errors (missing dir, unreadable file) yield UNKNOWN_BUILD_ID
 * rather than throwing — the version endpoint must never 500 over this.
 */
export function createSpaBuildIdReader(
  staticDir: string | undefined,
): SpaBuildIdReader {
  if (!staticDir) return async () => DEV_BUILD_ID;
  const indexPath = join(resolve(staticDir), "index.html");
  let cached: { mtimeMs: number; size: number; id: string } | null = null;

  return async () => {
    try {
      const st = await stat(indexPath);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        return cached.id;
      }
      const content = await readFile(indexPath);
      const id = createHash("sha256").update(content).digest("hex").slice(0, 16);
      cached = { mtimeMs: st.mtimeMs, size: st.size, id };
      return id;
    } catch {
      return UNKNOWN_BUILD_ID;
    }
  };
}
