/**
 * Tests for GET /api/version + the SPA buildId reader (issue #196).
 *
 * The endpoint is the SPA's auto-update polling target: cheap (no Navidrome
 * ping, unlike /api/health) and unauthenticated. `buildId` is a content hash
 * of the on-disk `${staticDir}/index.html`, recomputed when the file changes
 * — so a rebuild dropped on disk is detected without a hub restart and
 * without an APP_VERSION bump.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { APP_VERSION } from "../src/version.js";
import {
  createSpaBuildIdReader,
  DEV_BUILD_ID,
  UNKNOWN_BUILD_ID,
} from "../src/services/spa-build-id.js";
import type { Config } from "../src/config.js";

const baseConfig: Partial<Config> = {
  databasePath: ":memory:",
  jwtSecret: "version-test",
  // Nothing listens on port 1 — /api/version must not care.
  navidromeUrl: "http://127.0.0.1:1",
  navidromeUsername: "x",
  navidromePassword: "x",
};

describe("createSpaBuildIdReader (issue #196)", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("returns 'dev' when no staticDir is configured", async () => {
    const read = createSpaBuildIdReader(undefined);
    expect(await read()).toBe(DEV_BUILD_ID);
  });

  it("returns 'unknown' when index.html is missing", async () => {
    dir = await mkdtemp(join(tmpdir(), "poutine-buildid-"));
    const read = createSpaBuildIdReader(dir);
    expect(await read()).toBe(UNKNOWN_BUILD_ID);
  });

  it("hashes index.html and is stable across calls", async () => {
    dir = await mkdtemp(join(tmpdir(), "poutine-buildid-"));
    await writeFile(join(dir, "index.html"), "<html>build one</html>");
    const read = createSpaBuildIdReader(dir);
    const first = await read();
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(await read()).toBe(first);
  });

  it("changes when index.html is rewritten — no restart, no version bump", async () => {
    dir = await mkdtemp(join(tmpdir(), "poutine-buildid-"));
    const indexPath = join(dir, "index.html");
    await writeFile(indexPath, "<html>build one</html>");
    const read = createSpaBuildIdReader(dir);
    const first = await read();

    await writeFile(indexPath, "<html>build two</html>");
    // Pin a distinct mtime so the mtime+size cache can't mask the rewrite
    // on filesystems with coarse timestamp granularity.
    const later = new Date(Date.now() + 5000);
    await utimes(indexPath, later, later);

    const second = await read();
    expect(second).toMatch(/^[0-9a-f]{16}$/);
    expect(second).not.toBe(first);
  });

  it("recovers from 'unknown' once index.html appears", async () => {
    dir = await mkdtemp(join(tmpdir(), "poutine-buildid-"));
    const read = createSpaBuildIdReader(dir);
    expect(await read()).toBe(UNKNOWN_BUILD_ID);
    await writeFile(join(dir, "index.html"), "<html>late build</html>");
    expect(await read()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("GET /api/version (issue #196)", () => {
  let app: FastifyInstance;
  let dir: string | null = null;

  afterEach(async () => {
    if (app) await app.close();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("returns appVersion + buildId 'dev' without a staticDir", async () => {
    app = await buildApp(baseConfig);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/version" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      appVersion: APP_VERSION,
      buildId: DEV_BUILD_ID,
    });
  });

  it("returns the on-disk index.html hash with a staticDir", async () => {
    dir = await mkdtemp(join(tmpdir(), "poutine-version-route-"));
    await writeFile(join(dir, "index.html"), "<html>deployed build</html>");
    app = await buildApp({ ...baseConfig, staticDir: dir });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/version" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.appVersion).toBe(APP_VERSION);
    expect(body.buildId).toMatch(/^[0-9a-f]{16}$/);
  });
});
