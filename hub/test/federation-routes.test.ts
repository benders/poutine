import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type { KeyObject } from "node:crypto";
import { buildApp } from "../src/server.js";
import {
  loadOrCreatePrivateKey,
  canonicalSigningPayload,
  signRequest,
} from "../src/federation/signing.js";
import type { Config } from "../src/config.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpPath(suffix = "") {
  return path.join(os.tmpdir(), `poutine-fed-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}`);
}

function writeYaml(filePath: string, content: string) {
  fs.writeFileSync(filePath, content, "utf8");
}

/**
 * Construct the signed headers for a GET request to a /federation/* endpoint.
 */
function makeSignedHeaders(opts: {
  privateKey: KeyObject;
  instanceId: string;
  userAssertion: string;
  url: string;
  timestampOverride?: number;
}) {
  const ts = String(opts.timestampOverride ?? Date.now());
  const payload = canonicalSigningPayload({
    method: "GET",
    path: opts.url,
    bodyHash: "-",
    timestamp: ts,
    instanceId: opts.instanceId,
    userAssertion: opts.userAssertion,
  });
  const sig = signRequest(opts.privateKey, payload);
  return {
    "x-poutine-instance": opts.instanceId,
    "x-poutine-user": opts.userAssertion,
    "x-poutine-timestamp": ts,
    "x-poutine-signature": sig,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("federation routes — auth middleware", () => {
  let app: FastifyInstance;
  let privKeyA: KeyObject;
  let pubKeyBase64A: string;
  let keyPathA: string;
  let keyPathB: string;
  let peersYamlB: string;

  beforeEach(async () => {
    // Generate instance A's keypair
    keyPathA = tmpPath("key-a.pem");
    keyPathB = tmpPath("key-b.pem");
    peersYamlB = tmpPath("peers-b.yaml");

    const keyA = loadOrCreatePrivateKey(keyPathA);
    privKeyA = keyA.privateKey;
    pubKeyBase64A = keyA.publicKeyBase64;

    // Build a peers.yaml for the app under test (B) that trusts A
    writeYaml(
      peersYamlB,
      [
        `instance_id: "poutine-b"`,
        `peers:`,
        `  - id: "poutine-a"`,
        `    url: "http://localhost"`,
        `    public_key: "ed25519:${pubKeyBase64A}"`,
      ].join("\n"),
    );

    const testConfig: Partial<Config> = {
      databasePath: ":memory:",
      jwtSecret: "test-secret",
      encryptionKey: "test-encryption-key",
      poutinePrivateKeyPath: keyPathB,
      poutinePeersConfig: peersYamlB,
      poutineInstanceId: "poutine-b",
    };

    app = await buildApp(testConfig);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    for (const f of [keyPathA, keyPathB, peersYamlB]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("signed request → 200 with export JSON", async () => {
    const url = "/federation/library/export";
    const headers = makeSignedHeaders({
      privateKey: privKeyA,
      instanceId: "poutine-a",
      userAssertion: "alice",
      url,
    });

    const res = await app.inject({ method: "GET", url, headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("instanceId");
    expect(body).toHaveProperty("tracks");
    expect(body).toHaveProperty("artists");
    expect(body).toHaveProperty("releases");
    expect(body).toHaveProperty("releaseGroups");
    expect(body).toHaveProperty("page");
  });

  it("missing signature header → 401", async () => {
    const url = "/federation/library/export";
    const headers = makeSignedHeaders({
      privateKey: privKeyA,
      instanceId: "poutine-a",
      userAssertion: "alice",
      url,
    });

    // Remove the signature header
    const { "x-poutine-signature": _removed, ...headersWithoutSig } = headers;

    const res = await app.inject({ method: "GET", url, headers: headersWithoutSig });
    expect(res.statusCode).toBe(401);
  });

  it("stale timestamp (10 minutes ago) → 401", async () => {
    const url = "/federation/library/export";
    const headers = makeSignedHeaders({
      privateKey: privKeyA,
      instanceId: "poutine-a",
      userAssertion: "alice",
      url,
      timestampOverride: Date.now() - 10 * 60 * 1000,
    });

    const res = await app.inject({ method: "GET", url, headers });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toMatch(/timestamp/i);
  });

  it("unknown peer instance → 401", async () => {
    const url = "/federation/library/export";
    const headers = makeSignedHeaders({
      privateKey: privKeyA,
      instanceId: "poutine-unknown", // not in registry
      userAssertion: "alice",
      url,
    });

    const res = await app.inject({ method: "GET", url, headers });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toMatch(/unknown peer/i);
  });

  it("wrong public key (A signs but B registered a different key) → 401", async () => {
    // Generate a third keypair that is NOT registered in B's peers.yaml
    const wrongKeyPath = tmpPath("wrong-key.pem");
    try {
      const { privateKey: wrongKey } = loadOrCreatePrivateKey(wrongKeyPath);

      const url = "/federation/library/export";
      const headers = makeSignedHeaders({
        privateKey: wrongKey, // sign with unregistered key
        instanceId: "poutine-a", // but claim to be A
        userAssertion: "alice",
        url,
      });

      const res = await app.inject({ method: "GET", url, headers });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error).toMatch(/signature/i);
    } finally {
      if (fs.existsSync(wrongKeyPath)) fs.unlinkSync(wrongKeyPath);
    }
  });
});
