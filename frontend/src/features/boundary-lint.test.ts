import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Programmatic check that the boundary lint config (#221) actually
 * fires on cross-feature imports. Catches regressions in the config
 * itself.
 */

// The file URL points into vitest's transformed virtual location; walk
// upward until we find a directory containing the boundary config.
import { existsSync } from "node:fs";
function findFrontendRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "eslint.boundary.config.js"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Could not locate frontend root containing eslint.boundary.config.js");
}
const cwd = findFrontendRoot();

async function lintInline(filename: string, source: string) {
  const eslint = new ESLint({
    cwd,
    overrideConfigFile: resolve(cwd, "eslint.boundary.config.js"),
  });
  const [result] = await eslint.lintText(source, { filePath: resolve(cwd, filename) });
  return result;
}

describe("frontend boundary lint config (#221)", () => {
  it("flags hub-admin importing from player-admin", async () => {
    const r = await lintInline(
      "src/features/hub-admin/Evil.tsx",
      `import { SonosSection } from "../player-admin/SonosSection";\nexport const X = SonosSection;\n`,
    );
    expect(
      r.messages.some((m) => m.ruleId === "no-restricted-imports"),
    ).toBe(true);
  });

  it("flags player-admin importing from hub-admin", async () => {
    const r = await lintInline(
      "src/features/player-admin/Evil.tsx",
      `import { UsersSection } from "../hub-admin/UsersSection";\nexport const X = UsersSection;\n`,
    );
    expect(
      r.messages.some((m) => m.ruleId === "no-restricted-imports"),
    ).toBe(true);
  });

  it("flags player importing from hub-admin", async () => {
    const r = await lintInline(
      "src/features/player/Evil.tsx",
      `import { UsersSection } from "../hub-admin/UsersSection";\nexport const X = UsersSection;\n`,
    );
    expect(
      r.messages.some((m) => m.ruleId === "no-restricted-imports"),
    ).toBe(true);
  });

  it("ALLOWS hub-admin importing from features/shared/", async () => {
    const r = await lintInline(
      "src/features/hub-admin/OK.tsx",
      `import { CopyButton } from "../shared/CopyButton";\nexport const X = CopyButton;\n`,
    );
    expect(
      r.messages.some((m) => m.ruleId === "no-restricted-imports"),
    ).toBe(false);
  });
});
