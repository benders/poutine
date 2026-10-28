/**
 * Resolves the git commit the running hub was built from (issue #287),
 * reported as `gitSha` by /api/health.
 *
 * Docker images can't run git at runtime (`.git` is dockerignored and the
 * slim image has no git binary), so the build bakes the SHA in via the
 * `GIT_SHA` build arg → `POUTINE_GIT_SHA` env var. Outside Docker (dev,
 * native hub) we fall back to asking git directly about the checkout this
 * file lives in. Either form carries a `-dirty` suffix when the tree had
 * uncommitted changes to tracked files. `null` when neither source knows.
 */

import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Full SHA, `-dirty` suffix when the work tree differs from HEAD. */
export const GIT_DESCRIBE_ARGS = [
  "describe",
  "--always",
  "--dirty",
  "--abbrev=40",
  "--exclude=*",
];

function runGit(): string {
  return execFileSync("git", GIT_DESCRIBE_ARGS, {
    cwd: dirname(fileURLToPath(import.meta.url)),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  });
}

export function resolveGitSha(
  env: NodeJS.ProcessEnv = process.env,
  git: () => string = runGit,
): string | null {
  const fromEnv = env.POUTINE_GIT_SHA?.trim();
  if (fromEnv) return fromEnv;
  try {
    return git().trim() || null;
  } catch {
    // No git binary, not a checkout, or timed out.
    return null;
  }
}
