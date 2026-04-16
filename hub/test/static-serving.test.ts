/**
 * Tests for static file serving + SPA fallback.
 *
 * When PUBLIC_DIR / config.staticDir is set, the hub should:
 * - Serve static files (JS, CSS, images) from the directory
 * - Return index.html for any unmatched frontend route (SPA fallback)
 * - Return JSON 404 for unmatched API routes (/admin/*, /rest/*, /proxy/*, /api/*)
 * - Not interfere with existing API routes
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import type { Config } from "../src/config.js";

// Create a temp static dir with a minimal SPA structure
function makeStaticDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "poutine-static-"));
  writeFileSync(
    join(dir, "index.html"),
    "<!doctype html><html><body>SPA</body></html>",
  );
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), 'console.log("app")');
  return dir;
}

const baseConfig: Partial<Config> = {
  databasePath: ":memory:",
  jwtSecret: "test-secret-for-static-tests",
};

describe("static serving — disabled (no staticDir)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({ ...baseConfig, staticDir: undefined });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 404 for unknown routes when static serving is off", async () => {
    const res = await app.inject({ method: "GET", url: "/some/spa/route" });
    expect(res.statusCode).toBe(404);
  });

  it("health check still works", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });
});

describe("static serving — enabled (staticDir set)", () => {
  let app: FastifyInstance;
  let staticDir: string;

  beforeEach(async () => {
    staticDir = makeStaticDir();
    app = await buildApp({ ...baseConfig, staticDir });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("serves index.html at /", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("SPA");
  });

  it("serves a static asset file", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.body).toContain('console.log("app")');
  });

  it("SPA fallback: unknown frontend route returns index.html", async () => {
    const res = await app.inject({ method: "GET", url: "/artists/ar123" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("SPA");
  });

  it("SPA fallback: /admin (bare, no trailing slash) returns index.html", async () => {
    const res = await app.inject({ method: "GET", url: "/admin" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("SPA");
  });

  it("SPA fallback: /admin/ (trailing slash) returns index.html", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("SPA");
  });

  it("API route /api/health still works", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });

  it("unmatched /admin/* returns JSON 404, not index.html", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/nonexistent-route",
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.json()).toMatchObject({ error: "Not found" });
  });

  it("unmatched /rest/* returns JSON 404, not index.html", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/nonexistent",
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("unmatched /api/* returns JSON 404, not index.html", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/nonexistent",
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });
});
