/**
 * Unit tests for the navidrome-native provisioning service (#252 rework).
 *
 * Uses a fake Navidrome native-API HTTP server (plain node:http) modelling the
 * two endpoints the service touches: POST /auth/login and GET/PUT /api/player.
 * Verifies reportRealPath is flipped on poutine-sync/poutine-proxy records that
 * are false, that the full record is sent, that other clients are untouched,
 * and that every failure path resolves without throwing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  ensureRealPathPlayers,
  _resetWarnedOnce,
} from "../src/services/navidrome-native.js";

interface FakePlayer {
  id: string;
  client?: string;
  reportRealPath?: boolean;
  name?: string;
  maxBitRate?: number;
}

interface FakeOpts {
  loginStatus?: number; // status for /auth/login (default 200)
  loginBody?: unknown; // body for /auth/login when 200 (default { token })
  players?: FakePlayer[]; // GET /api/player body
  playerListStatus?: number; // status for GET /api/player (default 200)
  putStatus?: number; // status for PUT /api/player/:id (default 200)
  no404?: boolean; // when false (default) unknown routes 404
}

function startFake(opts: FakeOpts): Promise<{
  server: http.Server;
  url: string;
  puts: Array<{ id: string; body: Record<string, unknown> }>;
}> {
  const puts: Array<{ id: string; body: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;

    if (req.method === "POST" && p === "/auth/login") {
      const status = opts.loginStatus ?? 200;
      res.writeHead(status, { "content-type": "application/json" });
      if (status === 200) {
        res.end(JSON.stringify(opts.loginBody ?? { token: "jwt-token" }));
      } else {
        res.end(JSON.stringify({ error: "nope" }));
      }
      return;
    }

    if (req.method === "GET" && p === "/api/player") {
      const status = opts.playerListStatus ?? 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200 ? opts.players ?? [] : { error: "nope" }));
      return;
    }

    if (req.method === "PUT" && p.startsWith("/api/player/")) {
      const id = decodeURIComponent(p.slice("/api/player/".length));
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        puts.push({ id, body: JSON.parse(raw) as Record<string, unknown> });
        const status = opts.putStatus ?? 200;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(status === 200 ? raw : JSON.stringify({ error: "nope" }));
      });
      return;
    }

    // Anything else: 404 (models "not a Navidrome").
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}`, puts });
    });
  });
}

function makeLog(): { info: (m: string) => void; warn: (m: string) => void; infos: string[]; warns: string[] } {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    info: (m) => infos.push(m),
    warn: (m) => warns.push(m),
    infos,
    warns,
  };
}

async function run(url: string, log: { info: (m: string) => void; warn: (m: string) => void }): Promise<void> {
  await ensureRealPathPlayers({
    navidromeUrl: url,
    navidromeUsername: "admin",
    navidromePassword: "secret",
    log,
  });
}

describe("ensureRealPathPlayers", () => {
  let server: http.Server | null = null;

  beforeEach(() => {
    _resetWarnedOnce();
  });

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  it("flips reportRealPath on poutine-sync and poutine-proxy records that are false, sending the full record", async () => {
    const fake = await startFake({
      players: [
        { id: "p1", client: "poutine-sync", reportRealPath: false, name: "Sync", maxBitRate: 0 },
        { id: "p2", client: "poutine-proxy", reportRealPath: false, name: "Proxy", maxBitRate: 320 },
      ],
    });
    server = fake.server;
    const log = makeLog();

    await run(fake.url, log);

    expect(fake.puts).toHaveLength(2);
    const p1 = fake.puts.find((x) => x.id === "p1");
    const p2 = fake.puts.find((x) => x.id === "p2");
    expect(p1?.body).toMatchObject({ id: "p1", client: "poutine-sync", name: "Sync", maxBitRate: 0, reportRealPath: true });
    expect(p2?.body).toMatchObject({ id: "p2", client: "poutine-proxy", name: "Proxy", maxBitRate: 320, reportRealPath: true });
    expect(log.warns).toHaveLength(0);
    expect(log.infos).toHaveLength(2);
  });

  it("leaves other clients' records untouched", async () => {
    const fake = await startFake({
      players: [
        { id: "p1", client: "poutine-sync", reportRealPath: false },
        { id: "other", client: "DSub", reportRealPath: false },
        { id: "web", client: "NavidromeUI", reportRealPath: false },
      ],
    });
    server = fake.server;

    await run(fake.url, makeLog());

    expect(fake.puts.map((x) => x.id)).toEqual(["p1"]);
  });

  it("no-ops (no PUTs) when the record already reports real paths", async () => {
    const fake = await startFake({
      players: [
        { id: "p1", client: "poutine-sync", reportRealPath: true },
        { id: "p2", client: "poutine-proxy", reportRealPath: true },
      ],
    });
    server = fake.server;

    await run(fake.url, makeLog());

    expect(fake.puts).toHaveLength(0);
  });

  it("no matching records → no PUTs, no error", async () => {
    const fake = await startFake({ players: [{ id: "x", client: "DSub", reportRealPath: false }] });
    server = fake.server;
    const log = makeLog();

    await run(fake.url, log);

    expect(fake.puts).toHaveLength(0);
    expect(log.warns).toHaveLength(0);
  });

  it("login 401 → resolves without throwing, logs one warning", async () => {
    const fake = await startFake({ loginStatus: 401 });
    server = fake.server;
    const log = makeLog();

    await expect(run(fake.url, log)).resolves.toBeUndefined();
    expect(fake.puts).toHaveLength(0);
    expect(log.warns).toHaveLength(1);
  });

  it("login 500 → resolves without throwing", async () => {
    const fake = await startFake({ loginStatus: 500 });
    server = fake.server;
    const log = makeLog();

    await expect(run(fake.url, log)).resolves.toBeUndefined();
    expect(log.warns).toHaveLength(1);
  });

  it("login 200 but no token in body → resolves, warns", async () => {
    const fake = await startFake({ loginBody: { notAToken: 1 } });
    server = fake.server;
    const log = makeLog();

    await expect(run(fake.url, log)).resolves.toBeUndefined();
    expect(fake.puts).toHaveLength(0);
    expect(log.warns).toHaveLength(1);
  });

  it("/auth/login 404 (not a Navidrome) → resolves without throwing", async () => {
    // Server that 404s everything except a route we never hit.
    const fake = await startFake({ loginStatus: 404 });
    server = fake.server;
    const log = makeLog();

    await expect(run(fake.url, log)).resolves.toBeUndefined();
    expect(log.warns).toHaveLength(1);
  });

  it("player list malformed (not an array) → resolves, warns, no PUTs", async () => {
    const fake = await startFake({ players: undefined, playerListStatus: 200 });
    // Override: return an object instead of an array.
    server = fake.server;
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      const p = new URL(req.url ?? "/", "http://localhost").pathname;
      if (p === "/auth/login") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "t" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ not: "an array" }));
    });
    const log = makeLog();

    await expect(run(fake.url, log)).resolves.toBeUndefined();
    expect(fake.puts).toHaveLength(0);
    expect(log.warns).toHaveLength(1);
  });

  it("PUT fails (500) → still resolves without throwing", async () => {
    const fake = await startFake({
      players: [{ id: "p1", client: "poutine-sync", reportRealPath: false }],
      putStatus: 500,
    });
    server = fake.server;
    const log = makeLog();

    await expect(run(fake.url, log)).resolves.toBeUndefined();
    expect(fake.puts).toHaveLength(1); // attempted
    expect(log.warns).toHaveLength(1);
    expect(log.infos).toHaveLength(0);
  });

  it("network error (nothing listening) → resolves without throwing", async () => {
    const log = makeLog();
    // Port 1 is not listening.
    await expect(run("http://127.0.0.1:1", log)).resolves.toBeUndefined();
    expect(log.warns).toHaveLength(1);
  });

  it("warns only once per process across repeated failures", async () => {
    const log = makeLog();
    await run("http://127.0.0.1:1", log);
    await run("http://127.0.0.1:1", log);
    await run("http://127.0.0.1:1", log);
    expect(log.warns).toHaveLength(1);
  });
});

// ── Scanner config drift check (#296) ───────────────────────────────────────

import {
  checkScannerConfig,
  getLastScannerConfig,
  scannerConfigProblems,
  _resetScannerConfigState,
} from "../src/services/navidrome-native.js";

function startConfigFake(opts: { configStatus?: number; scanner?: unknown; extra?: Record<string, unknown> }): Promise<{
  server: http.Server;
  url: string;
  paths: string[];
}> {
  const paths: string[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      paths.push(`${req.method} ${req.url}`);
      if (req.method === "POST" && req.url === "/auth/login") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "tok" }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/config/") {
        if (req.headers["x-nd-authorization"] !== "Bearer tok") {
          res.writeHead(401);
          res.end();
          return;
        }
        res.writeHead(opts.configStatus ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "config", config: { Scanner: opts.scanner, ...opts.extra } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths });
    });
  });
}

describe("checkScannerConfig (#296)", () => {
  let fake: Awaited<ReturnType<typeof startConfigFake>> | undefined;
  let warnings: string[];
  const log = { info: () => {}, warn: (m: string) => warnings.push(m) };
  const run = () =>
    checkScannerConfig({ navidromeUrl: fake!.url, navidromeUsername: "admin", navidromePassword: "pw", log });

  beforeEach(() => {
    _resetScannerConfigState();
    warnings = [];
  });

  afterEach(async () => {
    if (fake) await new Promise<void>((r) => fake!.server.close(() => r()));
    fake = undefined;
  });

  it("reads the effective schedule and purge mode; no warning when as intended", async () => {
    fake = await startConfigFake({ scanner: { Schedule: "@every 1h", PurgeMissing: "never", WatcherWait: 5e9 } });

    expect(await run()).toEqual({ schedule: "@every 1h", purgeMissing: "never" });
    expect(getLastScannerConfig()).toEqual({ schedule: "@every 1h", purgeMissing: "never" });
    expect(warnings).toEqual([]);
    // Trailing slash matters: /api/config 404s on Navidrome 0.64.
    expect(fake.paths).toContain("GET /api/config/");
  });

  it("warns once per process when periodic scanning is off or purge mode drifted", async () => {
    fake = await startConfigFake({ scanner: { Schedule: "", PurgeMissing: "always" } });

    await run();
    await run();

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/periodic scan is DISABLED/);
    expect(warnings[1]).toMatch(/PurgeMissing is "always"/);
  });

  it("never logs the rest of the config, which can carry secrets", async () => {
    fake = await startConfigFake({
      scanner: { Schedule: "0", PurgeMissing: "never" },
      extra: { LastFM: { Secret: "sekrit-value" } },
    });

    await run();

    expect(warnings.join("\n")).not.toMatch(/sekrit-value/);
  });

  it("returns null without throwing when the API is unavailable or reshaped", async () => {
    fake = await startConfigFake({ configStatus: 500, scanner: {} });
    expect(await run()).toBeNull();
    await new Promise<void>((r) => fake!.server.close(() => r()));

    fake = await startConfigFake({ scanner: { Schedule: 5 } });
    expect(await run()).toBeNull();

    expect(
      await checkScannerConfig({ navidromeUrl: "http://127.0.0.1:1", navidromeUsername: "a", navidromePassword: "b", log }),
    ).toBeNull();
    expect(getLastScannerConfig()).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("treats \"0\" as disabled, like Navidrome's own default", () => {
    expect(scannerConfigProblems({ schedule: "0", purgeMissing: "never" })).toHaveLength(1);
    expect(scannerConfigProblems({ schedule: "0 * * * *", purgeMissing: "never" })).toEqual([]);
  });
});
