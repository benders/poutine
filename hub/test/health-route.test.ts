/**
 * Tests for the health endpoints (issues #178, #277).
 *
 * `/api/health` reflects local Navidrome reachability and returns HTTP 200 in
 * both cases so the federation handshake (which reads `apiVersion` /
 * `appVersion` from a peer's `/api/health`) keeps working when a peer's
 * Navidrome is briefly down. Operators key on `body.status` instead.
 *
 * `/api/health/ready` (#277) is the opposite contract: it exists precisely so
 * Synthetic monitors and k8s probes have an HTTP status to key on, and it
 * probes the real audio path — the outage that motivated it had a healthy
 * `/rest/ping` and a completely broken `/rest/stream`.
 *
 * `/api/health/live` is process liveness only: a sick Navidrome must never
 * fail it, or k8s would restart the hub over a dependency fault.
 */

import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { buildApp } from "../src/server.js";
import type { Config } from "../src/config.js";

/** Subsonic OK envelope for /rest/ping. */
const PING_OK = JSON.stringify({
  "subsonic-response": {
    status: "ok",
    version: "1.16.1",
    type: "navidrome",
    serverVersion: "0.52.0",
    openSubsonic: true,
  },
});

type StreamBehavior = "bytes" | "error" | "empty";

interface FakeNavidrome {
  url: string;
  close: () => Promise<void>;
  streamRequests: number;
}

/**
 * Minimal fake Navidrome: answers `/rest/ping` with an OK envelope, and
 * `/rest/stream` according to `stream`. Query params are ignored — the hub
 * just needs the status codes and bodies.
 */
async function startFakeNavidrome(
  stream: StreamBehavior = "bytes",
): Promise<FakeNavidrome> {
  const state = { streamRequests: 0 };
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/rest/ping")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(PING_OK);
      return;
    }
    if (url.startsWith("/rest/stream")) {
      state.streamRequests += 1;
      if (stream === "error") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("scanner wedged");
        return;
      }
      if (stream === "empty") {
        // The nastiest shape: 200 with no bytes. A ping-based check calls this
        // instance perfectly healthy.
        res.writeHead(200, { "content-type": "audio/flac", "content-length": "0" });
        res.end();
        return;
      }
      res.writeHead(206, {
        "content-type": "audio/flac",
        "accept-ranges": "bytes",
      });
      res.end(Buffer.from([0x66, 0x4c, 0x61, 0x43]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    get streamRequests() {
      return state.streamRequests;
    },
  };
}

/**
 * One local preferred track so the stream probe has a candidate. Foreign keys
 * off for the insert — see the same note in navidrome-monitor.test.ts.
 */
function seedLocalTrack(db: Database.Database, remoteId = "nd-1"): void {
  db.pragma("foreign_keys = OFF");
  db.prepare(
    `INSERT INTO instance_tracks (id, instance_id, remote_id, album_id, title, artist_name, format, size)
     VALUES (?, 'local', ?, 'al1', 'Probe Track', 'Probe Artist', 'flac', 1000)`,
  ).run(`local:${remoteId}`, remoteId);
  db.prepare(
    `INSERT INTO track_sources (id, unified_track_id, instance_id, instance_track_id, format, bitrate, size, preferred)
     VALUES (?, ?, 'local', ?, 'flac', 1000, 1000, 1)`,
  ).run(`ts-${remoteId}`, `ut-${remoteId}`, `local:${remoteId}`);
  db.pragma("foreign_keys = ON");
}

async function buildHub(
  navidromeUrl: string,
  name: string,
  overrides: Partial<Config> = {},
): Promise<FastifyInstance> {
  const app = await buildApp({
    databasePath: ":memory:",
    jwtSecret: `health-test-${name}`,
    navidromeUrl,
    navidromeUsername: "x",
    navidromePassword: "x",
    ...overrides,
  });
  await app.ready();
  return app;
}

describe("health endpoints (#178, #277)", () => {
  let app: FastifyInstance;
  let navidrome: FakeNavidrome | undefined;

  afterEach(async () => {
    if (app) await app.close();
    if (navidrome) await navidrome.close();
    navidrome = undefined;
  });

  // ── /api/health (#178) ───────────────────────────────────────────────────

  it("reports navidrome=unreachable / status=degraded when local Navidrome is down", async () => {
    // 127.0.0.1:1 reliably refuses connections — nothing listens there.
    app = await buildHub("http://127.0.0.1:1", "down");

    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.navidrome).toBe("unreachable");
    expect(body.status).toBe("degraded");
    expect(body).toHaveProperty("appVersion");
    expect(body).toHaveProperty("apiVersion");
    // Issue #287: the test process runs inside the git checkout.
    expect(body.gitSha).toMatch(/^[0-9a-f]{40}(-dirty)?$/);
  });

  it("reports navidrome=ok / status=ok when local Navidrome ping succeeds", async () => {
    navidrome = await startFakeNavidrome();
    app = await buildHub(navidrome.url, "up");

    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.navidrome).toBe("ok");
    expect(body.status).toBe("ok");
    expect(body).toHaveProperty("appVersion");
    expect(body).toHaveProperty("apiVersion");
  });

  it("never probes the stream path itself — one ping, as before (#277)", async () => {
    navidrome = await startFakeNavidrome();
    app = await buildHub(navidrome.url, "cheap");

    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(navidrome.streamRequests).toBe(0);
    // Nothing has probed yet, so there is no stream verdict to report.
    expect(res.json().navidromeStream).toBe("unknown");
  });

  it("rolls a failed stream probe into status while staying HTTP 200 (#277)", async () => {
    navidrome = await startFakeNavidrome("error");
    app = await buildHub(navidrome.url, "stream-broken");
    seedLocalTrack(app.db);

    // Readiness runs the probe; /api/health then reports what it found.
    await app.inject({ method: "GET", url: "/api/health/ready" });

    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.navidrome).toBe("ok");
    expect(body.navidromeStream).toBe("failed");
    expect(body.status).toBe("degraded");
  });

  // ── /api/health/live (#277) ──────────────────────────────────────────────

  it("live returns 200 even when Navidrome is unreachable", async () => {
    app = await buildHub("http://127.0.0.1:1", "live");

    const res = await app.inject({ method: "GET", url: "/api/health/live" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body).toHaveProperty("appVersion");
    expect(typeof body.uptimeSeconds).toBe("number");
  });

  // ── /api/health/ready (#277) ─────────────────────────────────────────────

  it("ready returns 200 when ping and the byte-range stream probe both pass", async () => {
    navidrome = await startFakeNavidrome("bytes");
    app = await buildHub(navidrome.url, "ready-ok");
    seedLocalTrack(app.db);

    const res = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.checks.hubDb.status).toBe("ok");
    expect(body.checks.navidromePing.status).toBe("ok");
    expect(body.checks.navidromeStream.status).toBe("ok");
    expect(navidrome.streamRequests).toBe(1);
  });

  it("ready returns 503 when Navidrome 500s on the stream path but pings fine", async () => {
    navidrome = await startFakeNavidrome("error");
    app = await buildHub(navidrome.url, "ready-500");
    seedLocalTrack(app.db);

    const res = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
    const body = res.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.navidromePing.status).toBe("ok");
    expect(body.checks.navidromeStream.status).toBe("failed");
    expect(body.checks.navidromeStream.detail).toMatch(/500/);
  });

  it("ready returns 503 when Navidrome answers the stream with zero bytes", async () => {
    navidrome = await startFakeNavidrome("empty");
    app = await buildHub(navidrome.url, "ready-empty");
    seedLocalTrack(app.db);

    const res = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.navidromeStream.detail).toMatch(/zero bytes/);
  });

  it("ready returns 503 when Navidrome is unreachable", async () => {
    app = await buildHub("http://127.0.0.1:1", "ready-down");

    const res = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.checks.navidromePing.status).toBe("failed");
    expect(body.checks.navidromeStream.status).toBe("skipped");
  });

  it("ready returns 200 on an empty library — nothing to stream is not a fault", async () => {
    navidrome = await startFakeNavidrome("error");
    app = await buildHub(navidrome.url, "ready-empty-library");

    const res = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.navidromeStream.status).toBe("skipped");
    expect(navidrome.streamRequests).toBe(0);
  });

  it("ready reuses a cached probe so a tight poll cadence doesn't hammer Navidrome", async () => {
    navidrome = await startFakeNavidrome("bytes");
    app = await buildHub(navidrome.url, "ready-cache");
    seedLocalTrack(app.db);

    const first = await app.inject({ method: "GET", url: "/api/health/ready" });
    const second = await app.inject({ method: "GET", url: "/api/health/ready" });

    expect(first.json().cached).toBe(false);
    expect(second.json().cached).toBe(true);
    expect(second.statusCode).toBe(200);
    expect(navidrome.streamRequests).toBe(1);
  });

  it("ready skips the stream leg when NAVIDROME_STREAM_PROBE is off", async () => {
    navidrome = await startFakeNavidrome("error");
    app = await buildHub(navidrome.url, "ready-probe-off", {
      navidromeStreamProbeEnabled: false,
    });
    seedLocalTrack(app.db);

    const res = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.navidromeStream.status).toBe("skipped");
    expect(navidrome.streamRequests).toBe(0);
  });

  it("ready degrades on real-traffic stream faults seen through the adapter observer", async () => {
    navidrome = await startFakeNavidrome("error");
    app = await buildHub(navidrome.url, "ready-observed");

    // No catalog rows: the synthetic probe has nothing to pull, so the only
    // possible signal is real traffic. Drive five failing Navidrome stream
    // calls through the adapter — exactly what a listener pressing play does.
    for (let i = 0; i < 5; i++) {
      await expect(app.navidromeClient.stream("nd-x")).rejects.toThrow();
    }

    const res = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.checks.navidromeStream.status).toBe("skipped");
    expect(body.observed.consecutiveStreamFailures).toBeGreaterThanOrEqual(5);
    expect(body.observed.lastFailure.path).toBe("/rest/stream");
  });
});
