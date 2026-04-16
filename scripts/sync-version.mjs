#!/usr/bin/env node
/**
 * Propagates the version from root package.json to:
 *   - hub/package.json
 *   - frontend/package.json
 *   - hub/src/version.ts
 *
 * Run directly:  node scripts/sync-version.mjs
 * Or via pnpm:   pnpm sync-version
 *
 * Also wired as the `version` lifecycle hook so `pnpm version <bump>`
 * keeps everything in sync automatically.
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

function writeJson(rel, obj) {
  writeFileSync(join(root, rel), JSON.stringify(obj, null, 2) + "\n");
}

const { version } = readJson("package.json");
console.log(`Syncing version ${version} to all packages…`);

// hub/package.json
const hubPkg = readJson("hub/package.json");
hubPkg.version = version;
writeJson("hub/package.json", hubPkg);

// frontend/package.json
const frontendPkg = readJson("frontend/package.json");
frontendPkg.version = version;
writeJson("frontend/package.json", frontendPkg);

// hub/src/version.ts — preserve existing content, replace only APP_VERSION
const versionTsPath = join(root, "hub/src/version.ts");
const src = readFileSync(versionTsPath, "utf8");
const updated = src.replace(
  /^export const APP_VERSION = ".*?";/m,
  `export const APP_VERSION = "${version}";`
);
writeFileSync(versionTsPath, updated);

console.log("Done.");
