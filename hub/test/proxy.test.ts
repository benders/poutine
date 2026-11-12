/**
 * Tests for /proxy/* — peer-only, read-only Navidrome proxy tier.
 *
 * Covers:
 *   - Ed25519 peer auth accepts a signed, active peer at or above the floor
 *   - Every allowlisted endpoint (with and without `.view`) is forwarded
 *   - Surface gate: non-GET, non-allowlisted endpoint, non-/rest path and
 *     request bodies are refused and never reach Navidrome
 *   - Local-user credentials (JWT, Subsonic) are not accepted
 *   - Lifecycle gate: disabled / tombstoned peers refused
 *   - Passthrough: response bytes piped, credentials injected, headers filtered
 *   - 12 concurrent requests do not block (smoke test)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { setPassword } from "../src/auth/passwords.js";
import { createAccessToken } from "../src/auth/jwt.js";
import {
  loadOrCreatePrivateKey,
  canonicalSigningPayload,
  signRequest,
} from "../src/federation/signing.js";
import {
  PROXY_ALLOWED_ENDPOINTS,
  resolveProxyTarget,
} from "../src/routes/proxy.js";
import { FEDERATION_API_VERSION } from "../src/version.js";
import { seedPeer } from "./helpers/seed-peer.js";
import type { KeyObject } from "node:crypto";
import type { Config } from "../src/config.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpPath(suffix = "") {
  return path.join(
    os.tmpdir(),
    `poutine-proxy-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}`,
  );
}

/** Minimal MP3 header bytes — stands in for any binary payload (cover art). */
const FAKE_BYTES = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0xde, 0xad, 0xbe, 0xef]);

interface UpstreamRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

/**
 * Start a fake Navidrome that returns a fixed buffer on any request and
 * records everything it receives. `delayMs` holds each response open so
 * concurrent requests overlap.
 */
function startFakeNavidrome(delayMs = 0): Promise<{
  server: http.Server;
  port: number;
  requests: UpstreamRequest[];
}> {
  const requests: UpstreamRequest[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
      });
      setTimeout(() => {
        res.writeHead(200, {
          "content-type": "audio/mpeg",
          "content-length": String(FAKE_BYTES.length),
          "set-cookie": "nd-session=abc",
        });
        res.end(FAKE_BYTES);
      }, delayMs);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port, requests });
    });
  });
}

function seedUser(
  app: FastifyInstance,
  username = "tester",
  password = "secret",
): { id: string; username: string } {
  const enc = setPassword(password, app.passwordKey);
  const id = "user-proxy-test";
  app.db
    .prepare(
      "INSERT OR IGNORE INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, 1)",
    )
    .run(id, username, enc);
  return { id, username };
}

function makePeerHeaders(opts: {
  privateKey: KeyObject;
  instanceId: string;
  url: string;
  method?: string;
}): Record<string, string> {
  const ts = String(Date.now());
  const payload = canonicalSigningPayload({
    method: opts.method ?? "GET",
    path: opts.url,
    bodyHash: "-",
    timestamp: ts,
    instanceId: opts.instanceId,
    userAssertion: "test-user",
  });
  const sig = signRequest(opts.privateKey, payload);
  return {
    "x-poutine-instance": opts.instanceId,
    "x-poutine-user": "test-user",
    "x-poutine-timestamp": ts,
    "x-poutine-signature": sig,
    "poutine-api-version": String(FEDERATION_API_VERSION),
  };
}

// ── Shared setup/teardown ──────────────────────────────────────────────────────

interface TestSetup {
  app: FastifyInstance;
  navidrome: http.Server;
  navidromeRequests: UpstreamRequest[];
  keyPathA: string;   // peer A (the caller)
  keyPathApp: string; // the hub under test
  privKeyA: KeyObject;
}

async function buildTestSetup(navidromeDelayMs = 0): Promise<TestSetup> {
  const keyPathA = tmpPath("key-a.pem");
  const keyPathApp = tmpPath("key-app.pem");

  const { privateKey: privKeyA, publicKeyBase64: pubKeyBase64A } =
    loadOrCreatePrivateKey(keyPathA);

  const { server: navidrome, port: navidromePort, requests: navidromeRequests } =
    await startFakeNavidrome(navidromeDelayMs);

  const config: Partial<Config> = {
    databasePath: ":memory:",
    jwtSecret: "proxy-test-secret",
    poutinePrivateKeyPath: keyPathApp,
    poutineInstanceId: "hub-under-test",
    navidromeUrl: `http://127.0.0.1:${navidromePort}`,
    navidromeUsername: "nav-admin",
    navidromePassword: "nav-pass",
  };

  const app = await buildApp(config);
  await app.ready();

  // Hub under test trusts caller "peer-a" (DB-backed registry, federation v5).
  seedPeer(app, {
    id: "peer-a",
    url: "http://localhost",
    publicKeySpec: `ed25519:${pubKeyBase64A}`,
  });

  return { app, navidrome, navidromeRequests, keyPathA, keyPathApp, privKeyA };
}

async function teardown(setup: TestSetup) {
  await setup.app.close();
  await new Promise<void>((resolve) => setup.navidrome.close(() => resolve()));
  for (const f of [setup.keyPathA, setup.keyPathApp]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

/** Inject a request validly signed by the active peer "peer-a". */
function signedRequest(
  setup: TestSetup,
  url: string,
  opts: {
    method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
    headers?: Record<string, string>;
    payload?: string;
  } = {},
) {
  const method = opts.method ?? "GET";
  return setup.app.inject({
    method,
    url,
    headers: {
      ...makePeerHeaders({
        privateKey: setup.privKeyA,
        instanceId: "peer-a",
        url,
        method,
      }),
      ...opts.headers,
    },
    payload: opts.payload,
  });
}

/** The read every sync starts with — a known-allowlisted URL. */
const ALLOWED_URL = "/proxy/rest/getArtists?f=json";

// ── Peer auth ─────────────────────────────────────────────────────────────────

describe("proxy — auth accept: Ed25519 peer signature", () => {
  let setup: TestSetup;

  beforeEach(async () => {
    setup = await buildTestSetup();
  });

  afterEach(async () => {
    await teardown(setup);
  });

  it("allows a request with valid Ed25519 signature from a known peer", async () => {
    // request.url inside a Fastify prefixed plugin retains the full path
    // including the /proxy prefix. The signing payload must use it.
    const res = await signedRequest(setup, ALLOWED_URL);

    expect(res.statusCode).toBe(200);
    expect(setup.navidromeRequests).toHaveLength(1);
  });

  it("accepts a peer at the version floor, not just the current version (v5 vs v7)", async () => {
    // Regression for the #244 bump: the check must compare against
    // MIN_FEDERATION_API_VERSION (5), or every protocol bump cuts
    // older-but-supported peers off from /proxy/*.
    const res = await signedRequest(setup, ALLOWED_URL, {
      headers: { "poutine-api-version": "5" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a peer below the version floor", async () => {
    const res = await signedRequest(setup, ALLOWED_URL, {
      headers: { "poutine-api-version": "4" },
    });
    expect(res.statusCode).toBe(403);
    expect(setup.navidromeRequests).toHaveLength(0);
  });

  it("rejects a signed peer that sends no api version", async () => {
    const url = ALLOWED_URL;
    const headers = makePeerHeaders({
      privateKey: setup.privKeyA,
      instanceId: "peer-a",
      url,
    });
    delete headers["poutine-api-version"];
    const res = await setup.app.inject({ method: "GET", url, headers });
    expect(res.statusCode).toBe(403);
    expect(setup.navidromeRequests).toHaveLength(0);
  });
});

describe("proxy — lifecycle gate on peer auth (#244)", () => {
  let setup: TestSetup;

  beforeEach(async () => {
    setup = await buildTestSetup();
  });

  afterEach(async () => {
    await teardown(setup);
  });

  it("refuses a disabled peer's validly signed request with a uniform 403", async () => {
    setup.app.db
      .prepare("UPDATE instances SET lifecycle = 'disabled' WHERE id = 'peer-a'")
      .run();
    setup.app.peerRegistry.reload();

    const res = await signedRequest(setup, ALLOWED_URL);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
    expect(setup.navidromeRequests).toHaveLength(0);
  });

  it("refuses a tombstoned peer with the identical 403 body as disabled", async () => {
    setup.app.db
      .prepare("UPDATE instances SET lifecycle = 'tombstoned' WHERE id = 'peer-a'")
      .run();
    setup.app.peerRegistry.reload();

    const res = await signedRequest(setup, ALLOWED_URL);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
    expect(setup.navidromeRequests).toHaveLength(0);
  });
});

// ── Endpoint allowlist ────────────────────────────────────────────────────────

describe("proxy — endpoint allowlist", () => {
  let setup: TestSetup;

  beforeEach(async () => {
    setup = await buildTestSetup();
  });

  afterEach(async () => {
    await teardown(setup);
  });

  it("is exactly the set of reads peer sync, auto-sync and cover art issue", () => {
    // Pinned on purpose: widening the peer-facing surface must be a visible,
    // reviewed diff here as well as in routes/proxy.ts.
    expect([...PROXY_ALLOWED_ENDPOINTS].sort()).toEqual([
      "getAlbum",
      "getArtist",
      "getArtists",
      "getCoverArt",
      "getScanStatus",
    ]);
  });

  it.each(PROXY_ALLOWED_ENDPOINTS.map((e) => [e]))(
    "forwards GET /proxy/rest/%s for a signed active peer",
    async (endpoint) => {
      const res = await signedRequest(setup, `/proxy/rest/${endpoint}?id=x1&f=json`);

      expect(res.statusCode).toBe(200);
      expect(setup.navidromeRequests).toHaveLength(1);
      const upstream = new URL(setup.navidromeRequests[0].url, "http://nd");
      expect(setup.navidromeRequests[0].method).toBe("GET");
      expect(upstream.pathname).toBe(`/rest/${endpoint}`);
      expect(upstream.searchParams.get("id")).toBe("x1");
    },
  );

  it.each(PROXY_ALLOWED_ENDPOINTS.map((e) => [e]))(
    "forwards GET /proxy/rest/%s.view to the same upstream endpoint",
    async (endpoint) => {
      const res = await signedRequest(setup, `/proxy/rest/${endpoint}.view?id=x1`);

      expect(res.statusCode).toBe(200);
      expect(setup.navidromeRequests).toHaveLength(1);
      const upstream = new URL(setup.navidromeRequests[0].url, "http://nd");
      expect(upstream.pathname).toBe(`/rest/${endpoint}`);
    },
  );

  it.each([
    ["HEAD"],
    ["POST"],
    ["PUT"],
    ["PATCH"],
    ["DELETE"],
  ] as const)(
    "rejects %s on an allowlisted endpoint with 405",
    async (method) => {
      const res = await signedRequest(setup, ALLOWED_URL, { method });

      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe("GET");
      expect(setup.navidromeRequests).toHaveLength(0);
    },
  );

  it("never forwards OPTIONS (answered by the CORS layer, not the proxy)", async () => {
    await signedRequest(setup, ALLOWED_URL, { method: "OPTIONS" });
    await signedRequest(setup, ALLOWED_URL, {
      method: "OPTIONS",
      headers: { origin: "http://example.test", "access-control-request-method": "POST" },
    });

    expect(setup.navidromeRequests).toHaveLength(0);
  });

  it.each([
    // Subsonic endpoints outside the allowlist — reads and writes alike.
    ["/proxy/rest/ping?f=json"],
    ["/proxy/rest/stream?id=trk-1"],
    ["/proxy/rest/getAlbumList2?type=newest"],
    ["/proxy/rest/startScan"],
    ["/proxy/rest/startScan.view"],
    // Near-misses of an allowlisted name: the match is exact and undecoded.
    ["/proxy/rest/getartists"],
    ["/proxy/rest/getArtists/"],
    ["/proxy/rest/getArtists.view.view"],
    ["/proxy/rest/getArtists.json"],
    ["/proxy/rest/getArtists/../startScan"],
    ["/proxy/rest/getArtists%2F..%2FstartScan"],
    ["/proxy/rest/%67etArtists"],
    ["/proxy/rest//getArtists"],
    ["/proxy//rest/getArtists"],
    ["/proxy/rest/getArtists;x=1"],
  ])("rejects non-allowlisted endpoint %s with 404", async (url) => {
    const res = await signedRequest(setup, url);

    expect(res.statusCode).toBe(404);
    expect(setup.navidromeRequests).toHaveLength(0);
  });

  it.each([
    ["/proxy/"],
    ["/proxy/rest"],
    ["/proxy/rest/"],
    ["/proxy/auth/login"],
    ["/proxy/api/song"],
    ["/proxy/app/"],
    ["/proxy/share/abc"],
    ["/proxy/getArtists"],
    ["/proxy/x/rest/getArtists"],
  ])("rejects non-/rest path %s with 404", async (url) => {
    const res = await signedRequest(setup, url);

    expect(res.statusCode).toBe(404);
    expect(setup.navidromeRequests).toHaveLength(0);
  });

  it("rejects a GET that carries a body with 400", async () => {
    const res = await signedRequest(setup, ALLOWED_URL, {
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ a: 1 }),
    });

    expect(res.statusCode).toBe(400);
    expect(setup.navidromeRequests).toHaveLength(0);
  });

  it("rejects a GET that declares a chunked body with 400", async () => {
    const res = await signedRequest(setup, ALLOWED_URL, {
      headers: { "transfer-encoding": "chunked" },
    });

    expect(res.statusCode).toBe(400);
    expect(setup.navidromeRequests).toHaveLength(0);
  });

  it("refuses off-surface requests before auth, with no credentials at all", async () => {
    const post = await setup.app.inject({ method: "POST", url: ALLOWED_URL });
    const offList = await setup.app.inject({ method: "GET", url: "/proxy/rest/ping" });

    expect(post.statusCode).toBe(405);
    expect(offList.statusCode).toBe(404);
    expect(setup.navidromeRequests).toHaveLength(0);
  });
});

describe("resolveProxyTarget", () => {
  it("maps an allowlisted URL to its upstream path and raw query", () => {
    expect(resolveProxyTarget("/proxy/rest/getAlbum?id=a%201&f=json")).toEqual({
      upstreamPath: "/rest/getAlbum",
      search: "id=a%201&f=json",
    });
    expect(resolveProxyTarget("/proxy/rest/getArtists.view")).toEqual({
      upstreamPath: "/rest/getArtists",
      search: "",
    });
  });

  it("does not let the query string satisfy the path match", () => {
    expect(resolveProxyTarget("/proxy/rest/ping?x=/proxy/rest/getArtists")).toBeNull();
    expect(resolveProxyTarget("/proxy/auth/login?/proxy/rest/getArtists")).toBeNull();
  });

  it("returns null for absolute-form and prefix-less URLs", () => {
    expect(resolveProxyTarget("http://hub/proxy/rest/getArtists")).toBeNull();
    expect(resolveProxyTarget("/rest/getArtists")).toBeNull();
    expect(resolveProxyTarget("")).toBeNull();
  });
});

// ── Auth reject ───────────────────────────────────────────────────────────────

describe("proxy — auth reject: local-user credentials are not accepted", () => {
  let setup: TestSetup;
  let userId: string;

  beforeEach(async () => {
    setup = await buildTestSetup();
    ({ id: userId } = seedUser(setup.app));
  });

  afterEach(async () => {
    await teardown(setup);
  });

  it("rejects a valid JWT in the Authorization header", async () => {
    const token = await createAccessToken(userId, setup.app.config);
    const res = await setup.app.inject({
      method: "GET",
      url: ALLOWED_URL,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(setup.navidromeRequests).toHaveLength(0);
  });

  it("rejects a valid JWT in the access_token cookie", async () => {
    const token = await createAccessToken(userId, setup.app.config);
    const res = await setup.app.inject({
      method: "GET",
      url: ALLOWED_URL,
      cookies: { access_token: token },
    });
    expect(res.statusCode).toBe(401);
    expect(setup.navidromeRequests).toHaveLength(0);
  });

  it("rejects a valid JWT in the token query param", async () => {
    const token = await createAccessToken(userId, setup.app.config);
    const res = await setup.app.inject({
      method: "GET",
      url: `${ALLOWED_URL}&token=${token}`,
    });
    expect(res.statusCode).toBe(401);
    expect(setup.navidromeRequests).toHaveLength(0);
  });

  it("rejects valid Subsonic u+p credentials", async () => {
    const res = await setup.app.inject({
      method: "GET",
      url: `${ALLOWED_URL}&u=tester&p=secret`,
    });
    expect(res.statusCode).toBe(401);
    expect(setup.navidromeRequests).toHaveLength(0);
  });

  it("rejects valid Subsonic u+p with an enc:<hex> password", async () => {
    const hexPassword = Buffer.from("secret", "utf8").toString("hex");
    const res = await setup.app.inject({
      method: "GET",
      url: `${ALLOWED_URL}&u=tester&p=enc:${hexPassword}`,
    });
    expect(res.statusCode).toBe(401);
    expect(setup.navidromeRequests).toHaveLength(0);
  });

  it("rejects valid Subsonic u+t+s credentials", async () => {
    const salt = "deadbeef";
    const token = crypto.createHash("md5").update("secret" + salt).digest("hex");
    const res = await setup.app.inject({
      method: "GET",
      url: `${ALLOWED_URL}&u=tester&t=${token}&s=${salt}`,
    });
    expect(res.statusCode).toBe(401);
    expect(setup.navidromeRequests).toHaveLength(0);
  });

  it("rejects a local user who also sends an incomplete set of peer headers", async () => {
    const token = await createAccessToken(userId, setup.app.config);
    const headers = makePeerHeaders({
      privateKey: setup.privKeyA,
      instanceId: "peer-a",
      url: ALLOWED_URL,
    });
    delete headers["x-poutine-signature"];
    const res = await setup.app.inject({
      method: "GET",
      url: ALLOWED_URL,
      headers: { ...headers, authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(setup.navidromeRequests).toHaveLength(0);
  });
});

describe("proxy — auth reject: peer signature", () => {
  let setup: TestSetup;

  beforeEach(async () => {
    setup = await buildTestSetup();
  });

  afterEach(async () => {
    await teardown(setup);
  });

  it("rejects with 401 when no auth provided", async () => {
    const res = await setup.app.inject({ method: "GET", url: ALLOWED_URL });
    expect(res.statusCode).toBe(401);
    expect(setup.navidromeRequests).toHaveLength(0);
  });

  it("rejects with 401 when Ed25519 signature is tampered", async () => {
    const res = await signedRequest(setup, ALLOWED_URL, {
      headers: {
        "x-poutine-signature": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      },
    });
    expect(res.statusCode).toBe(401);
    expect(setup.navidromeRequests).toHaveLength(0);
  });

  it("rejects with 401 when the signature covers a different endpoint", async () => {
    const headers = makePeerHeaders({
      privateKey: setup.privKeyA,
      instanceId: "peer-a",
      url: "/proxy/rest/getArtist?id=1",
    });
    const res = await setup.app.inject({
      method: "GET",
      url: "/proxy/rest/getAlbum?id=1",
      headers,
    });
    expect(res.statusCode).toBe(401);
    expect(setup.navidromeRequests).toHaveLength(0);
  });

  it("rejects with 401 when Ed25519 instance ID is not a known peer", async () => {
    const headers = makePeerHeaders({
      privateKey: setup.privKeyA,
      instanceId: "unknown-peer",
      url: ALLOWED_URL,
    });
    const res = await setup.app.inject({ method: "GET", url: ALLOWED_URL, headers });
    expect(res.statusCode).toBe(401);
    expect(setup.navidromeRequests).toHaveLength(0);
  });
});

// ── Passthrough ───────────────────────────────────────────────────────────────

describe("proxy — passthrough", () => {
  let setup: TestSetup;

  beforeEach(async () => {
    setup = await buildTestSetup();
  });

  afterEach(async () => {
    await teardown(setup);
  });

  it("forwards exact response bytes and content-type from Navidrome", async () => {
    const res = await signedRequest(setup, "/proxy/rest/getCoverArt?id=al-1&size=300");

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(res.headers["poutine-api-version"]).toBe(String(FEDERATION_API_VERSION));
    expect(Buffer.from(res.rawPayload)).toEqual(FAKE_BYTES);
  });

  it("does not relay Navidrome's set-cookie to the caller", async () => {
    const res = await signedRequest(setup, "/proxy/rest/getCoverArt?id=al-1");

    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("injects Navidrome credentials upstream (u+t+s in query, no /proxy prefix)", async () => {
    await signedRequest(setup, "/proxy/rest/getCoverArt?id=al-1&size=300");

    expect(setup.navidromeRequests).toHaveLength(1);
    const upstream = new URL(setup.navidromeRequests[0].url, "http://nd");
    expect(upstream.pathname).toBe("/rest/getCoverArt");
    expect(upstream.searchParams.get("id")).toBe("al-1");
    expect(upstream.searchParams.get("size")).toBe("300");
    expect(upstream.searchParams.get("u")).toBe("nav-admin");
    expect(upstream.searchParams.get("c")).toBe("poutine-proxy");
    const salt = upstream.searchParams.get("s") ?? "";
    expect(upstream.searchParams.get("t")).toBe(
      crypto.createHash("md5").update("nav-pass" + salt).digest("hex"),
    );
  });

  it("strips caller-supplied Subsonic auth params before injecting its own", async () => {
    await signedRequest(
      setup,
      "/proxy/rest/getCoverArt?id=al-1&u=someone&p=pw&t=tok&s=salt&jwt=abc&c=other",
    );

    expect(setup.navidromeRequests).toHaveLength(1);
    const upstream = new URL(setup.navidromeRequests[0].url, "http://nd");
    expect(upstream.searchParams.getAll("u")).toEqual(["nav-admin"]);
    expect(upstream.searchParams.getAll("c")).toEqual(["poutine-proxy"]);
    expect(upstream.searchParams.has("p")).toBe(false);
    expect(upstream.searchParams.has("jwt")).toBe(false);
    expect(upstream.searchParams.getAll("t")).not.toContain("tok");
    expect(upstream.searchParams.getAll("s")).not.toContain("salt");
  });

  it("forwards only allowlisted request headers to Navidrome", async () => {
    // accept-encoding: if it reached Navidrome it may respond with gzip, and
    // the caller would get compressed bytes it was never told to decompress.
    // authorization / cookie / signing headers: none of Navidrome's business.
    const res = await signedRequest(setup, "/proxy/rest/getCoverArt?id=al-1", {
      headers: {
        range: "bytes=0-1023",
        "if-none-match": '"etag-1"',
        "accept-encoding": "gzip, deflate, br",
        authorization: "Bearer whatever",
        cookie: "access_token=whatever",
      },
    });

    expect(res.statusCode).toBe(200);
    const received = setup.navidromeRequests[0].headers;
    expect(received.range).toBe("bytes=0-1023");
    expect(received["if-none-match"]).toBe('"etag-1"');
    expect(received["accept-encoding"]).toBeUndefined();
    expect(received.authorization).toBeUndefined();
    expect(received.cookie).toBeUndefined();
    expect(received["content-type"]).toBeUndefined();
    expect(received["content-length"]).toBeUndefined();
    expect(received["x-poutine-signature"]).toBeUndefined();
  });
});

// ── Concurrency smoke test ─────────────────────────────────────────────────────

describe("proxy — concurrency smoke test", () => {
  let setup: TestSetup;

  beforeEach(async () => {
    // Each upstream response is held 50ms so concurrent requests actually
    // overlap in flight.
    setup = await buildTestSetup(50);
  });

  afterEach(async () => {
    await teardown(setup);
  });

  it("handles 12 concurrent in-flight requests without blocking", async () => {
    const start = Date.now();

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        signedRequest(setup, `/proxy/rest/getCoverArt?id=al-${i}`),
      ),
    );
    const elapsed = Date.now() - start;

    for (const res of results) {
      expect(res.statusCode).toBe(200);
    }
    expect(setup.navidromeRequests).toHaveLength(12);

    // If requests were serialized (blocking), total time would be 12 × 50ms =
    // 600ms+. With true concurrency they overlap and finish in ~50ms +
    // overhead; the budget is generous for slow CI.
    expect(elapsed).toBeLessThan(1000);
  });
});
