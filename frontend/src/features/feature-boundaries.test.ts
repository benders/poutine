import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bounded directory enforcement (#216 — issue body and parent #212).
 *
 * Hub-admin and Player-admin must not import from each other. Full
 * ESLint `no-restricted-paths` enforcement is #221's job; this is the
 * tactical guard until then so a refactor can't silently cross the line.
 *
 * Shared utilities live in `features/shared/` and are intentionally
 * importable from either side.
 */

const featuresDir = dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      out.push(...walk(p));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

function importsFrom(file: string): string[] {
  const src = readFileSync(file, "utf-8");
  // Match `from "..."` and `import("...")`. Imports must be quoted.
  const re = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

describe("feature boundaries (#216)", () => {
  it("hub-admin does not import from player-admin", () => {
    const files = walk(join(featuresDir, "hub-admin"));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const f of files) {
      for (const imp of importsFrom(f)) {
        if (imp.includes("features/player-admin") || imp.includes("../player-admin")) {
          offenders.push(`${f} imports ${imp}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("player-admin does not import from hub-admin", () => {
    const files = walk(join(featuresDir, "player-admin"));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const f of files) {
      for (const imp of importsFrom(f)) {
        if (imp.includes("features/hub-admin") || imp.includes("../hub-admin")) {
          offenders.push(`${f} imports ${imp}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
