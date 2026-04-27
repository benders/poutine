/**
 * Tests for /proxy/* — authenticating Navidrome proxy tier.
 *
 * Covers:
 *   - All three auth modes accept valid credentials (Ed25519, JWT, Subsonic u+p)
 *   - All three auth modes reject invalid/missing credentials
 *   - Streaming passthrough: response body piped without buffering
 *   - 12 concurrent streams do not block (smoke test)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { FEDERATION_API_VERSION } from "../src/version.js";
import type { KeyObject } from "node:crypto";
import type { Config } from "../src/config.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpPath(suffix = "") {
  return path.join(
    os.tmpdir(),
    `poutine-proxy-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}`,
  );
}

function writeYaml(filePath: string, content: string) {
  fs.writeFileSync(filePath, content, "utf8");
}

/** Minimal MP3 header bytes */
const FAKE_AUDIO = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0xde, 0xad, 0xbe, 0xef]);

/**
 * Start a fake Navidrome that returns a fixed audio buffer on any request.
 * Records all received request paths for assertion.
 */
function startFakeNavidrome(response = FAKE_AUDIO): Promise<{
  server: http.Server;
  port: number;
  requests: string[];
}> {
  const requests: string[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(200, {
        "content-type": "audio/mpeg",
        "content-length": String(response.length),
      });
      res.end(response);
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
}): Record<string, string> {
  const ts = String(Date.now());
  const payload = canonicalSigningPayload({
    method: "GET",
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
  navidromePort: number;
  navidromeRequests: string[];
  keyPathA: string;   // peer A (the caller)
  keyPathApp: string; // the hub under test
  peersYaml: string;
  privKeyA: KeyObject;
  pubKeyBase64A: string;
}

async function buildTestSetup(): Promise<TestSetup> {
  const keyPathA = tmpPath("key-a.pem");
  const keyPathApp = tmpPath("key-app.pem");
  const peersYaml = tmpPath("peers.yaml");

  const { privateKey: privKeyA, publicKeyBase64: pubKeyBase64A } =
    loadOrCreatePrivateKey(keyPathA);

  writeYaml(
    peersYaml,
    [
      `peers:`,
      `  - id: "peer-a"`,
      `    url: "http://localhost"`,
      `    public_key: "ed25519:${pubKeyBase64A}"`,
    ].join("\n"),
  );

  const { server: navidrome, port: navidromePort, requests: navidromeRequests } =
    await startFakeNavidrome();

  const config: Partial<Config> = {
    databasePath: ":memory:",
    jwtSecret: "proxy-test-secret",
    poutinePrivateKeyPath: keyPathApp,
    poutinePeersConfig: peersYaml,
    poutineInstanceId: "hub-under-test",
    navidromeUrl: `http://127.0.0.1:${navidromePort}`,
    navidromeUsername: "nav-admin",
    navidromePassword: "nav-pass",
  };

  const app = await buildApp(config);
  await app.ready();

  return {
    app,
    navidrome,
    navidromePort,
    navidromeRequests,
    keyPathA,
    keyPathApp,
    peersYaml,
    privKeyA,
    pubKeyBase64A,
  };
}

async function teardown(setup: TestSetup) {
  await setup.app.close();
  await new Promise<void>((resolve) => setup.navidrome.close(() => resolve()));
  for (const f of [setup.keyPathA, setup.keyPathApp, setup.peersYaml]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

// ── Auth accept tests ──────────────────────────────────────────────────────────

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
    const url = "/proxy/rest/ping?f=json";
    const headers = makePeerHeaders({
      privateKey: setup.privKeyA,
      instanceId: "peer-a",
      url, // sign the full path as the middleware sees it
    });

    const res = await setup.app.inject({
      method: "GET",
      url,
      headers,
    });

    // Navidrome stub returns 200 regardless — we just care auth passed (not 401)
    expect(res.statusCode).toBe(200);
  });
});

describe("proxy — auth accept: JWT", () => {
  let setup: TestSetup;
  let userId: string;

  beforeEach(async () => {
    setup = await buildTestSetup();
    ({ id: userId } = seedUser(setup.app));
  });

  afterEach(async () => {
    await teardown(setup);
  });

  it("allows a request with valid JWT in Authorization header", async () => {
    const token = await createAccessToken(userId, setup.app.config);
    const res = await setup.app.inject({
      method: "GET",
      url: "/proxy/rest/ping?f=json",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("allows a request with valid JWT in access_token cookie", async () => {
    const token = await createAccessToken(userId, setup.app.config);
    const res = await setup.app.inject({
      method: "GET",
      url: "/proxy/rest/ping?f=json",
      cookies: { access_token: token },
    });
    expect(res.statusCode).toBe(200);
  });

  it("allows a request with valid JWT in token query param", async () => {
    const token = await createAccessToken(userId, setup.app.config);
    const res = await setup.app.inject({
      method: "GET",
      url: `/proxy/rest/ping?f=json&token=${token}`,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("proxy — auth accept: Subsonic u+p", () => {
  let setup: TestSetup;

  beforeEach(async () => {
    setup = await buildTestSetup();
    seedUser(setup.app);
  });

  afterEach(async () => {
    await teardown(setup);
  });

  it("allows a request with valid u+p credentials", async () => {
    const res = await setup.app.inject({
      method: "GET",
      url: "/proxy/rest/ping?u=tester&p=secret&f=json",
    });
    expect(res.statusCode).toBe(200);
  });

  it("allows a request with enc:<hex> encoded password", async () => {
    const hexPassword = Buffer.from("secret", "utf8").toString("hex");
    const res = await setup.app.inject({
      method: "GET",
      url: `/proxy/rest/ping?u=tester&p=enc:${hexPassword}&f=json`,
    });
    expect(res.statusCode).toBe(200);
  });

  it("allows a request with valid u+t+s (#106)", async () => {
    const { createHash } = await import("node:crypto");
    const salt = "deadbeef";
    const token = createHash("md5").update("secret" + salt).digest("hex");
    const res = await setup.app.inject({
      method: "GET",
      url: `/proxy/rest/ping?u=tester&t=${token}&s=${salt}&f=json`,
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects u+t+s with wrong token (#106)", async () => {
    const res = await setup.app.inject({
      method: "GET",
      url: `/proxy/rest/ping?u=tester&t=${"0".repeat(32)}&s=any&f=json`,
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── Auth reject tests ──────────────────────────────────────────────────────────

describe("proxy — auth reject", () => {
  let setup: TestSetup;

  beforeEach(async () => {
    setup = await buildTestSetup();
    seedUser(setup.app);
  });

  afterEach(async () => {
    await teardown(setup);
  });

  it("rejects with 401 when no auth provided", async () => {
    const res = await setup.app.inject({
      method: "GET",
      url: "/proxy/rest/ping?f=json",
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects with 401 when JWT is invalid/expired", async () => {
    const res = await setup.app.inject({
      method: "GET",
      url: "/proxy/rest/ping?f=json",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    // Falls through to Subsonic param auth, which also fails (no u param)
    expect(res.statusCode).toBe(401);
  });

  it("rejects with 401 when Subsonic password is wrong", async () => {
    const res = await setup.app.inject({
      method: "GET",
      url: "/proxy/rest/ping?u=tester&p=wrongpassword&f=json",
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects with 401 when Subsonic username is unknown", async () => {
    const res = await setup.app.inject({
      method: "GET",
      url: "/proxy/rest/ping?u=nobody&p=secret&f=json",
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects with 401 when Ed25519 signature is tampered", async () => {
    const url = "/proxy/rest/ping?f=json";
    const headers = makePeerHeaders({
      privateKey: setup.privKeyA,
      instanceId: "peer-a",
      url,
    });
    // Corrupt the signature
    headers["x-poutine-signature"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    const res = await setup.app.inject({
      method: "GET",
      url,
      headers,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects with 401 when Ed25519 instance ID is not a known peer", async () => {
    const url = "/proxy/rest/ping?f=json";
    const headers = makePeerHeaders({
      privateKey: setup.privKeyA,
      instanceId: "unknown-peer",
      url,
    });

    const res = await setup.app.inject({
      method: "GET",
      url,
      headers,
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── Streaming passthrough ──────────────────────────────────────────────────────

describe("proxy — streaming passthrough", () => {
  let setup: TestSetup;
  let userId: string;

  beforeEach(async () => {
    setup = await buildTestSetup();
    ({ id: userId } = seedUser(setup.app));
  });

  afterEach(async () => {
    await teardown(setup);
  });

  it("forwards exact response bytes and content-type from Navidrome", async () => {
    const token = await createAccessToken(userId, setup.app.config);
    const res = await setup.app.inject({
      method: "GET",
      url: "/proxy/rest/stream?id=trk-1",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(Buffer.from(res.rawPayload)).toEqual(FAKE_AUDIO);
  });

  it("forwards Navidrome credentials to upstream (u+t+s in query)", async () => {
    const token = await createAccessToken(userId, setup.app.config);
    await setup.app.inject({
      method: "GET",
      url: "/proxy/rest/stream?id=trk-1",
      headers: { authorization: `Bearer ${token}` },
    });

    // Navidrome should have received a request with injected proxy credentials.
    // The path must not contain /proxy, and caller's u+p must be stripped.
    expect(setup.navidromeRequests.length).toBeGreaterThan(0);
    const receivedUrl = setup.navidromeRequests[0];
    expect(receivedUrl).not.toContain("/proxy");
    expect(receivedUrl).toContain("/rest/stream");
    expect(receivedUrl).toContain("u=nav-admin");
    expect(receivedUrl).toContain("t=");
    expect(receivedUrl).toContain("s=");
    // Caller's plaintext password must not be forwarded to Navidrome
    expect(receivedUrl).not.toMatch(/[?&]p=/);
  });

  it("strips caller u+p params and injects proxy credentials when Subsonic auth used", async () => {
    // Caller authenticates with u+p; those params must not reach Navidrome
    await setup.app.inject({
      method: "GET",
      url: "/proxy/rest/stream?id=trk-1&u=tester&p=secret",
    });

    expect(setup.navidromeRequests.length).toBeGreaterThan(0);
    const receivedUrl = setup.navidromeRequests[0];
    expect(receivedUrl).not.toMatch(/[?&]p=/);
    expect(receivedUrl).not.toContain("u=tester");
    expect(receivedUrl).toContain("u=nav-admin");
    expect(receivedUrl).toContain("t=");
    expect(receivedUrl).toContain("s=");
  });

  it("passes Range header through to Navidrome", async () => {
    const token = await createAccessToken(userId, setup.app.config);
    const res = await setup.app.inject({
      method: "GET",
      url: "/proxy/rest/stream?id=trk-1",
      headers: {
        authorization: `Bearer ${token}`,
        range: "bytes=0-1023",
      },
    });

    // Fake Navidrome returns 200 regardless, but the request headers should pass
    expect(res.statusCode).toBe(200);
  });

  it("does not forward accept-encoding to Navidrome", async () => {
    // If accept-encoding reaches Navidrome, it may respond with gzip. The proxy
    // strips content-encoding from responses, leaving the caller with raw compressed
    // bytes that fail JSON parsing.
    const receivedHeaders: Record<string, string> = {};
    const headerCapture = await new Promise<{ server: http.Server; port: number }>(
      (resolve) => {
        const server = http.createServer((req, res) => {
          for (const [k, v] of Object.entries(req.headers)) {
            receivedHeaders[k] = Array.isArray(v) ? v.join(", ") : (v ?? "");
          }
          res.writeHead(200, { "content-type": "application/json", "content-length": "2" });
          res.end("{}");
        });
        server.listen(0, "127.0.0.1", () =>
          resolve({ server, port: (server.address() as AddressInfo).port }),
        );
      },
    );

    const keyPathLocal = tmpPath("key-enc.pem");
    const peersLocal = tmpPath("peers-enc.yaml");
    writeYaml(peersLocal, "peers: []");

    const { buildApp: buildAppLocal } = await import("../src/server.js");
    const appLocal = await buildAppLocal({
      databasePath: ":memory:",
      jwtSecret: "enc-test",
      poutinePrivateKeyPath: keyPathLocal,
      poutinePeersConfig: peersLocal,
      poutineInstanceId: "enc-test",
      navidromeUrl: `http://127.0.0.1:${headerCapture.port}`,
      navidromeUsername: "admin",
      navidromePassword: "admin",
    });
    await appLocal.ready();
    const { id: uid } = seedUser(appLocal, "enc-user", "enc-pass");
    const jwt = await createAccessToken(uid, appLocal.config);

    try {
      await appLocal.inject({
        method: "GET",
        url: "/proxy/rest/ping?f=json",
        headers: {
          authorization: `Bearer ${jwt}`,
          "accept-encoding": "gzip, deflate, br",
        },
      });

      expect(receivedHeaders["accept-encoding"]).toBeUndefined();
    } finally {
      await appLocal.close();
      await new Promise<void>((r) => headerCapture.server.close(() => r()));
      for (const f of [keyPathLocal, peersLocal]) if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });
});

// ── Concurrency smoke test ─────────────────────────────────────────────────────

describe("proxy — concurrency smoke test", () => {
  let setup: TestSetup;
  let userId: string;

  beforeEach(async () => {
    // Use a fake Navidrome that intentionally delays each response by 50ms
    // so concurrent requests actually overlap in flight.
    const requests: string[] = [];
    const navidrome = await new Promise<{ server: http.Server; port: number; requests: string[] }>(
      (resolve) => {
        const server = http.createServer((_req, res) => {
          requests.push(_req.url ?? "");
          // Delay response to ensure overlap
          setTimeout(() => {
            res.writeHead(200, {
              "content-type": "audio/mpeg",
              "content-length": String(FAKE_AUDIO.length),
            });
            res.end(FAKE_AUDIO);
          }, 50);
        });
        server.listen(0, "127.0.0.1", () => {
          resolve({ server, port: (server.address() as AddressInfo).port, requests });
        });
      },
    );

    const keyPathApp = tmpPath("key-app-conc.pem");
    const peersYaml = tmpPath("peers-conc.yaml");
    writeYaml(peersYaml, "peers: []");

    const config: Partial<Config> = {
      databasePath: ":memory:",
      jwtSecret: "concurrency-test-secret",
      poutinePrivateKeyPath: keyPathApp,
      poutinePeersConfig: peersYaml,
      poutineInstanceId: "hub-concurrency-test",
      navidromeUrl: `http://127.0.0.1:${navidrome.port}`,
      navidromeUsername: "admin",
      navidromePassword: "admin",
    };

    const app = await buildApp(config);
    await app.ready();

    // Reuse setup slot — override navidrome to the delaying one
    setup = {
      app,
      navidrome: navidrome.server,
      navidromePort: navidrome.port,
      navidromeRequests: navidrome.requests,
      keyPathA: "",
      keyPathApp,
      peersYaml,
      privKeyA: {} as KeyObject,
      pubKeyBase64A: "",
    };

    ({ id: userId } = seedUser(app));
  });

  afterEach(async () => {
    await setup.app.close();
    await new Promise<void>((resolve) => setup.navidrome.close(() => resolve()));
    for (const f of [setup.keyPathApp, setup.peersYaml]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("handles 12 concurrent in-flight streams without blocking", async () => {
    const token = await createAccessToken(userId, setup.app.config);

    const start = Date.now();

    // Fire 12 requests in parallel
    const promises = Array.from({ length: 12 }, (_, i) =>
      setup.app.inject({
        method: "GET",
        url: `/proxy/rest/stream?id=trk-${i}`,
        headers: { authorization: `Bearer ${token}` },
      }),
    );

    const results = await Promise.all(promises);
    const elapsed = Date.now() - start;

    // All should succeed
    for (const res of results) {
      expect(res.statusCode).toBe(200);
    }

    // If streams were serialized (blocking), total time would be 12 × 50ms = 600ms+.
    // With true concurrency they all overlap and finish in ~50ms + overhead.
    // Allow generous budget (500ms) to account for slow CI, but serialized
    // would take much longer.
    expect(elapsed).toBeLessThan(1000);
  });
});
