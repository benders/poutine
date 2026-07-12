import { describe, it, expect, beforeAll } from "vitest";
import { ESLint } from "eslint";
import { resolve } from "node:path";

/**
 * Programmatic check that the boundary lint config (#221) actually
 * fires on Player-file violations. Catches regressions in the config
 * itself (e.g. someone narrowing the glob too far, or accidentally
 * disabling `no-restricted-imports`).
 */

const cwd = resolve(__dirname, "..");

async function lintInline(filename: string, source: string) {
  const eslint = new ESLint({
    cwd,
    overrideConfigFile: resolve(cwd, "eslint.boundary.config.js"),
  });
  const [result] = await eslint.lintText(source, { filePath: resolve(cwd, filename) });
  return result;
}

describe("hub boundary lint config (#221)", () => {
  let cleanResult: ESLint.LintResult;

  beforeAll(async () => {
    cleanResult = await lintInline(
      "src/routes/sonos.ts",
      `import type { FastifyPluginAsync } from "fastify";\nexport const x = 1;\n`,
    );
  });

  it("clean Player file produces zero errors", () => {
    expect(cleanResult.errorCount).toBe(0);
  });

  it("flags better-sqlite3 runtime import from sonos route", async () => {
    const r = await lintInline(
      "src/routes/sonos.ts",
      `import Database from "better-sqlite3";\nconst x = new Database(":memory:");\n`,
    );
    expect(r.errorCount).toBeGreaterThan(0);
    expect(
      r.messages.some((m) => m.ruleId === "no-restricted-imports"),
    ).toBe(true);
  });

  it("ALLOWS type-only better-sqlite3 import from sonos route", async () => {
    const r = await lintInline(
      "src/routes/sonos.ts",
      `import type Database from "better-sqlite3";\nexport type X = Database;\n`,
    );
    expect(r.errorCount).toBe(0);
  });

  it("flags in-process Subsonic adapter import from sonos route", async () => {
    const r = await lintInline(
      "src/routes/sonos.ts",
      `import { SubsonicClient } from "../adapters/subsonic.js";\nconsole.log(SubsonicClient);\n`,
    );
    expect(
      r.messages.some((m) => m.ruleId === "no-restricted-imports"),
    ).toBe(true);
  });

  it("flags Hub DB module import from dlna service", async () => {
    const r = await lintInline(
      "src/services/dlna-objects.ts",
      `import { getPreferredSource } from "../db/preferred-source.js";\nconsole.log(getPreferredSource);\n`,
    );
    expect(
      r.messages.some((m) => m.ruleId === "no-restricted-imports"),
    ).toBe(true);
  });

  it("ALLOWS the player.db opener to import better-sqlite3", async () => {
    const r = await lintInline(
      "src/db/player-db.ts",
      `import Database from "better-sqlite3";\nexport const x = Database;\n`,
    );
    expect(r.errorCount).toBe(0);
  });

  it("Hub-side files are unaffected — Hub may import better-sqlite3", async () => {
    const r = await lintInline(
      "src/services/auto-sync.ts",
      `import Database from "better-sqlite3";\nexport const x = Database;\n`,
    );
    expect(
      r.messages.some((m) => m.ruleId === "no-restricted-imports"),
    ).toBe(false);
  });
});
