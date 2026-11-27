/**
 * Outbound peer requests never follow redirects (#317).
 *
 * A "redirector" answers every request with a 302 to a loopback "canary"
 * listener. Each peer-facing call site is pointed at the redirector; the
 * canary must never see a request. Also covers the `checkPeerUrlSafe` guard
 * on `inviter_url` in POST /api/admin/hub/peers/accept.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { ESLint } from "eslint";
import { peerFetch } from "../src/federation/peer-fetch.js";
import { createFederationFetcher } from "../src/federation/sign-request.js";
import { loadOrCreatePrivateKey } from "../src/federation/signing.js";
import { signInviteeProof, decodeInvitation } from "../src/federation/invitations.js";
import { AutoSyncService } from "../src/services/auto-sync.js";
import type { Peer } from "../src/federation/peers.js";
import { startHub, admit, tmpPath, type Hub } from "./helpers/hub-setup.js";

interface Listener {
  server: http.Server;
  url: string;
  hits: string[];
}

async function listen(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return server;
}

function urlOf(server: http.Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startCanary(): Promise<Listener> {
  const hits: string[] = [];
  const server = await listen((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ apiVersion: 99, appVersion: "canary" }));
  });
  return { server, url: urlOf(server), hits };
}

/** Answers everything with a 302 into the canary, preserving the path. */
async function startRedirector(canaryUrl: string): Promise<Listener> {
  const hits: string[] = [];
  const server = await listen((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(302, { location: `${canaryUrl}${req.url ?? "/"}` });
    res.end();
  });
  return { server, url: urlOf(server), hits };
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((r) => server.close(() => r()));
}

let canary: Listener;
let redirector: Listener;

beforeAll(async () => {
  canary = await startCanary();
  redirector = await startRedirector(canary.url);
});

afterAll(async () => {
  await close(redirector.server);
  await close(canary.server);
});

beforeEach(() => {
  canary.hits.length = 0;
  redirector.hits.length = 0;
});

describe("peerFetch (#317)", () => {
  it("rejects a 3xx instead of following it", async () => {
    await expect(peerFetch(`${redirector.url}/api/health`)).rejects.toThrow();
    expect(redirector.hits).toEqual(["GET /api/health"]);
    expect(canary.hits).toEqual([]);
  });

  it("ignores a caller-supplied redirect mode", async () => {
    const init = { redirect: "follow" } as unknown as Parameters<typeof peerFetch>[1];
    await expect(peerFetch(`${redirector.url}/x`, init)).rejects.toThrow();
    expect(canary.hits).toEqual([]);
  });

  it("passes non-redirect responses through", async () => {
    const res = await peerFetch(`${canary.url}/api/health`);
    expect(res.status).toBe(200);
    expect(canary.hits).toEqual(["GET /api/health"]);
  });
});

describe("createFederationFetcher (#317)", () => {
  it("does not follow a peer's redirect (signed headers never reach the target)", async () => {
    const keyPath = tmpPath("redir", "key.pem");
    try {
      const { privateKey } = loadOrCreatePrivateKey(keyPath);
      const fetcher = createFederationFetcher({ privateKey, instanceId: "hub-x" });
      const peer = { id: "evil", url: redirector.url } as Peer;
      await expect(
        fetcher(peer, "/federation/stream/abc", { asUser: "u" }),
      ).rejects.toThrow();
      expect(redirector.hits).toEqual(["GET /federation/stream/abc"]);
      expect(canary.hits).toEqual([]);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    }
  });
});

describe("peer-facing routes do not follow redirects (#317)", () => {
  let hubA: Hub;
  let hubB: Hub;

  beforeEach(async () => {
    hubA = await startHub("hub-a", "redir");
    hubB = await startHub("hub-b", "redir");
    await admit(hubB, hubA); // A accepts B's invitation; both know each other.
    canary.hits.length = 0;
    redirector.hits.length = 0;
  });

  afterEach(async () => {
    await hubA.app.close();
    await hubB.app.close();
    for (const f of [hubA.keyPath, hubB.keyPath]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  /** Point A's row for hub-b at the redirector. */
  function redirectPeerB(): void {
    hubA.app.db
      .prepare("UPDATE instances SET url = ? WHERE id = 'hub-b'")
      .run(redirector.url);
    hubA.app.peerRegistry.reload();
  }

  it("admin peer health (GET /api/admin/hub/peers)", async () => {
    redirectPeerB();
    const res = await hubA.app.inject({
      method: "GET",
      url: "/api/admin/hub/peers",
      headers: { authorization: `Bearer ${hubA.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(redirector.hits).toContain("GET /api/health");
    expect(canary.hits).toEqual([]);
  });

  it("auto-sync peer health check", async () => {
    redirectPeerB();
    const svc = new AutoSyncService(
      hubA.app.db,
      hubA.app.config,
      { info: () => {}, error: () => {} },
      undefined,
      null,
      null,
      {
        peerRegistry: hubA.app.peerRegistry,
        federatedFetch: hubA.app.federatedFetch,
        asUser: "auto-test",
      },
    );
    await svc.pollPeers();
    expect(redirector.hits).toContain("GET /api/health");
    expect(canary.hits).toEqual([]);
    const row = hubA.app.db
      .prepare("SELECT status FROM instances WHERE id = 'hub-b'")
      .get() as { status: string };
    expect(row.status).toBe("offline");
  });

  it("peer cover art (/rest/getCoverArt) returns a generic 502", async () => {
    redirectPeerB();
    const res = await hubA.app.inject({
      method: "GET",
      url: "/rest/getCoverArt?u=admin-hub-a&p=password-irrelevant&v=1.16.1&c=test&id=hub-b:al-1",
    });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain(canary.url);
    expect(redirector.hits.some((h) => h.startsWith("GET /proxy/rest/getCoverArt"))).toBe(true);
    expect(canary.hits).toEqual([]);
  });

  it("peer stream via the federated fetcher", async () => {
    redirectPeerB();
    const peer = hubA.app.peerRegistry.peers.get("hub-b")!;
    await expect(
      hubA.app.federatedFetch(peer, "/federation/stream/t1", { asUser: "admin-hub-a" }),
    ).rejects.toThrow();
    expect(redirector.hits).toEqual(["GET /federation/stream/t1"]);
    expect(canary.hits).toEqual([]);
  });

  it("handshake reachability check on the invitee URL", async () => {
    const issue = await hubB.app.inject({
      method: "POST",
      url: "/api/admin/hub/peers/invite",
      headers: { authorization: `Bearer ${hubB.token}` },
      payload: { ourUrl: hubB.url, expiresInSec: 600 },
    });
    expect(issue.statusCode).toBe(200);
    const { invitation } = issue.json() as { invitation: string };
    const nonce = decodeInvitation(invitation).payload.nonce;

    const keyPath = tmpPath("redir", "invitee-key.pem");
    try {
      const { privateKey, publicKeyBase64 } = loadOrCreatePrivateKey(keyPath);
      const res = await fetch(`${hubB.url}/federation/handshake`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          invitation,
          invitee: {
            id: "hub-evil",
            url: redirector.url,
            public_key: `ed25519:${publicKeyBase64}`,
            proof_signature: signInviteeProof(privateKey, nonce),
          },
        }),
      });
      expect(res.status).toBe(502);
      expect(redirector.hits).toEqual(["GET /api/health"]);
      expect(canary.hits).toEqual([]);
      const row = hubB.app.db
        .prepare("SELECT id FROM instances WHERE id = 'hub-evil'")
        .get();
      expect(row).toBeUndefined();
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    }
  });

  it("accept's POST to inviter_url/federation/handshake", async () => {
    const issue = await hubB.app.inject({
      method: "POST",
      url: "/api/admin/hub/peers/invite",
      headers: { authorization: `Bearer ${hubB.token}` },
      // hub-b signs an invitation naming the redirector as its URL.
      payload: { ourUrl: redirector.url, expiresInSec: 600 },
    });
    expect(issue.statusCode).toBe(200);
    const { invitation } = issue.json() as { invitation: string };
    hubA.app.db.prepare("DELETE FROM instances WHERE id = 'hub-b'").run();
    hubA.app.peerRegistry.reload();

    const res = await hubA.app.inject({
      method: "POST",
      url: "/api/admin/hub/peers/accept",
      headers: { authorization: `Bearer ${hubA.token}` },
      payload: { invitation, ourUrl: hubA.url },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "Inviter unreachable" });
    expect(redirector.hits).toEqual(["POST /federation/handshake"]);
    expect(canary.hits).toEqual([]);
    const row = hubA.app.db.prepare("SELECT id FROM instances WHERE id = 'hub-b'").get();
    expect(row).toBeUndefined();
  });
});

describe("accept runs checkPeerUrlSafe on inviter_url (#317)", () => {
  let hubA: Hub;
  let hubB: Hub;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    hubA = await startHub("hub-a", "redir-safe");
    hubB = await startHub("hub-b", "redir-safe");
  });

  afterEach(async () => {
    process.env = { ...savedEnv };
    await hubA.app.close();
    await hubB.app.close();
    for (const f of [hubA.keyPath, hubB.keyPath]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("refuses a private inviter_url before contacting it or touching state", async () => {
    const issue = await hubB.app.inject({
      method: "POST",
      url: "/api/admin/hub/peers/invite",
      headers: { authorization: `Bearer ${hubB.token}` },
      payload: { ourUrl: canary.url, expiresInSec: 600 },
    });
    expect(issue.statusCode).toBe(200);
    const { invitation } = issue.json() as { invitation: string };

    // Production default: private addresses are refused.
    process.env.NODE_ENV = "production";
    delete process.env.POUTINE_ALLOW_PRIVATE_PEER_URLS;

    const res = await hubA.app.inject({
      method: "POST",
      url: "/api/admin/hub/peers/accept",
      headers: { authorization: `Bearer ${hubA.token}` },
      payload: { invitation, ourUrl: hubA.url },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Inviter URL not permitted" });
    expect(canary.hits).toEqual([]);
    const row = hubA.app.db.prepare("SELECT id FROM instances WHERE id = 'hub-b'").get();
    expect(row).toBeUndefined();
  });
});

describe("lint: peer-facing files may not use the global fetch (#317)", () => {
  const cwd = resolve(__dirname, "..");

  async function lint(filename: string, source: string) {
    const eslint = new ESLint({ cwd, overrideConfigFile: resolve(cwd, "eslint.config.js") });
    const [result] = await eslint.lintText(source, { filePath: resolve(cwd, filename) });
    return result.messages.filter((m) => m.ruleId === "no-restricted-globals");
  }

  it.each([
    "src/routes/admin.ts",
    "src/routes/federation.ts",
    "src/services/auto-sync.ts",
    "src/federation/gossip.ts",
    "src/library/sync-peer.ts",
  ])("flags fetch() in %s", async (file) => {
    const msgs = await lint(file, `export const f = () => fetch("http://x");\n`);
    expect(msgs).toHaveLength(1);
  });

  it("allows fetch() in peer-fetch.ts and in non-peer files", async () => {
    const src = `export const f = () => fetch("http://x");\n`;
    expect(await lint("src/federation/peer-fetch.ts", src)).toHaveLength(0);
    expect(await lint("src/services/lastfm.ts", src)).toHaveLength(0);
  });
});
