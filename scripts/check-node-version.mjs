#!/usr/bin/env node
// Node.js CVE gate (#290). Fails when a Node version is behind a security release
// on its own line, or its line is past end-of-life. Release data comes from the
// Node project itself: dist/index.json (`security: true` per release) and the
// nodejs/Release schedule.
//
// Usage: node scripts/check-node-version.mjs                    # the repo pin (.node-version) + pin drift
//        node scripts/check-node-version.mjs --version v22.23.2 # any version, e.g. a live container's `node -v`
//
// Exit 0 = OK. 1 = vulnerable, EOL, or pins drifted. 2 = release data unavailable
// (never a silent pass).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const INDEX_URL = "https://nodejs.org/dist/index.json";
const SCHEDULE_URL = "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json";
const EOL_WARN_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) throw new Error(`not a Node.js version: ${JSON.stringify(v)}`);
  return m.slice(1).map(Number);
}

export function compareVersions(a, b) {
  const [pa, pb] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** Security releases on `version`'s line newer than `version`. Non-empty = vulnerable. */
export function securityFixesSince(version, index) {
  const [major] = parseVersion(version);
  return index
    .filter((r) => r.security && parseVersion(r.version)[0] === major && compareVersions(r.version, version) > 0)
    .map((r) => r.version)
    .sort(compareVersions);
}

/** End-of-life state of `version`'s line. A line missing from the schedule counts as EOL. */
export function eolStatus(version, schedule, today) {
  const entry = schedule[`v${parseVersion(version)[0]}`];
  if (!entry) return { eol: true, end: null, daysLeft: 0 };
  const daysLeft = Math.ceil((Date.parse(entry.end) - Date.parse(today)) / DAY_MS);
  return { eol: daysLeft <= 0, end: entry.end, daysLeft };
}

/** Every place that pins Node must name the `.node-version` release exactly. */
export function pinDrift(pin, { dockerfile, engines }) {
  const problems = [];
  const tags = [...dockerfile.matchAll(/^FROM\s+node:(\S+)/gm)].map((m) => m[1]);
  if (tags.length === 0) problems.push("hub/Dockerfile: no `FROM node:` line");
  for (const tag of tags) {
    if (tag !== `${pin}-slim`) problems.push(`hub/Dockerfile: FROM node:${tag} (expected node:${pin}-slim)`);
  }
  if (engines !== `^${pin}`) problems.push(`package.json engines.node: ${JSON.stringify(engines)} (expected "^${pin}")`);
  return problems;
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const flag = argv.indexOf("--version");
  const explicit = flag === -1 ? null : argv[flag + 1];
  const problems = [];

  let version;
  if (explicit) {
    version = explicit.replace(/^v/, "");
  } else {
    version = readFileSync(resolve(root, ".node-version"), "utf8").trim();
    problems.push(
      ...pinDrift(version, {
        dockerfile: readFileSync(resolve(root, "hub/Dockerfile"), "utf8"),
        engines: JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).engines?.node,
      }),
    );
  }
  parseVersion(version);

  let index, schedule;
  try {
    [index, schedule] = await Promise.all([fetchJson(INDEX_URL), fetchJson(SCHEDULE_URL)]);
  } catch (err) {
    console.error(`✖ could not fetch Node.js release data: ${err.message}`);
    return 2;
  }

  if (!index.some((r) => r.version === `v${version}`)) problems.push(`v${version} is not a published Node.js release`);
  const fixes = securityFixesSince(version, index);
  if (fixes.length > 0) {
    problems.push(`v${version} has known vulnerabilities, fixed in security release(s) ${fixes.join(", ")}`);
  }
  const eol = eolStatus(version, schedule, new Date().toISOString().slice(0, 10));
  if (eol.eol) {
    problems.push(`Node ${parseVersion(version)[0]}.x is end-of-life${eol.end ? ` since ${eol.end}` : ""}`);
  } else if (eol.daysLeft <= EOL_WARN_DAYS) {
    console.warn(`⚠ Node ${parseVersion(version)[0]}.x reaches end-of-life on ${eol.end} (${eol.daysLeft} days) — plan the major upgrade`);
  }

  if (problems.length > 0) {
    for (const p of problems) console.error(`✖ ${p}`);
    console.error("Bump procedure: docs/hub-internals.md#nodejs-version-policy-290");
    return 1;
  }
  console.log(`✔ Node.js v${version}: no newer security release on its line, supported until ${eol.end}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
