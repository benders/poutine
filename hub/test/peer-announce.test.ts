/**
 * Tests for the v6 immediate-discovery push (issue #163).
 *
 * Topology: A↔B already paired. A admits C via handshake. We expect A to
 * fan out POST /federation/peers/announce to B so B knows C without waiting
 * for the next gossip cycle.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { seedAdminUser } from "./helpers/admin-user.js";
import { ingestGossipEntry } from "../src/federation/gossip.js";
import type { GossipPeerEntry } from "../src/federation/gossip.js";
import type { Config } from "../src/config.js";

function tmpPath(suffix = "") {
  return path.join(
    os.tmpdir(),
    `poutine-announce-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}`,
  );
}

interface Hub {
  app: FastifyInstance;
  port: number;
  url: string;
  keyPath: string;
  token: string;
}

async function startHub(id: string): Promise<Hub> {
  const keyPath = tmpPath(`${id}-key.pem`);
  const config: Partial<Config> = {
    databasePath: ":memory:",
    jwtSecret: `test-${id}`,
    poutinePrivateKeyPath: keyPath,
    poutineInstanceId: id,
    poutineOwnerUsername: `admin-${id}`,
    navidromeUrl: "http://127.0.0.1:1",
    navidromeUsername: "x",
    navidromePassword: "x",
  };
  const app = await buildApp(config);
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const { token } = await seedAdminUser(app, `admin-${id}`);
  return { app, port, url, keyPath, token };
}

async function admit(inviter: Hub, invitee: Hub) {
  const issue = await inviter.app.inject({
    method: "POST",
    url: "/admin/peers/invite",
    headers: { authorization: `Bearer ${inviter.token}` },
    payload: { ourUrl: inviter.url, inviteeUrl: invitee.url, expiresInSec: 600 },
  });
  expect(issue.statusCode).toBe(200);
  const { invitation } = issue.json() as { invitation: string };
  const accept = await invitee.app.inject({
    method: "POST",
    url: "/admin/peers/accept",
    headers: { authorization: `Bearer ${invitee.token}` },
    payload: { invitation, ourUrl: invitee.url },
  });
  expect(accept.statusCode).toBe(200);
}

// Wait until pred() is truthy or `timeoutMs` elapses.
async function waitFor(pred: () => boolean, timeoutMs = 2000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error("waitFor timed out");
}

function gossipEntryFor(hub: Hub, peerId: string): GossipPeerEntry {
  const row = hub.app.db
    .prepare(
      `SELECT id, url, public_key, invitation_payload, invitation_signature,
              inviter_id, inviter_url, inviter_public_key
       FROM instances WHERE id = ?`,
    )
    .get(peerId) as {
    id: string;
    url: string;
    public_key: string;
    invitation_payload: string;
    invitation_signature: string;
    inviter_id: string;
    inviter_url: string;
    inviter_public_key: string;
  };
  return {
    id: row.id,
    url: row.url,
    public_key: row.public_key,
    invitation_payload: JSON.parse(row.invitation_payload),
    invitation_signature: row.invitation_signature,
    inviter_id: row.inviter_id,
    inviter_url: row.inviter_url,
    inviter_public_key: row.inviter_public_key,
  };
}

describe("peer announce (v6, #163)", () => {
  let hubA: Hub;
  let hubB: Hub;
  let hubC: Hub;

  beforeEach(async () => {
    hubA = await startHub("hub-a");
    hubB = await startHub("hub-b");
    hubC = await startHub("hub-c");
  });

  afterEach(async () => {
    await hubA.app.close();
    await hubB.app.close();
    await hubC.app.close();
    for (const f of [hubA.keyPath, hubB.keyPath, hubC.keyPath]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("fan-out: B learns about C immediately after A admits C", async () => {
    await admit(hubA, hubB); // A↔B
    expect(hubB.app.peerRegistry.peers.has("hub-c")).toBe(false);

    await admit(hubA, hubC); // A admits C → A should announce to B

    await waitFor(() => hubB.app.peerRegistry.peers.has("hub-c"));
    const row = hubB.app.db
      .prepare("SELECT inviter_id FROM instances WHERE id = 'hub-c'")
      .get() as { inviter_id: string } | undefined;
    expect(row?.inviter_id).toBe("hub-a");
  });

  it("POST /federation/peers/announce inserts a valid entry from a known peer", async () => {
    await admit(hubA, hubB); // A↔B
    await admit(hubA, hubC); // A↔C — needed to obtain a real signed entry
    // Let the handshake's detached fan-out finish before we wipe B's row,
    // otherwise a stale announce in flight could re-insert C between our
    // DELETE and our manual announce.
    await waitFor(() => hubB.app.peerRegistry.peers.has("hub-c"));

    hubB.app.db.prepare("DELETE FROM instances WHERE id = 'hub-c'").run();
    hubB.app.peerRegistry.reload();
    expect(hubB.app.peerRegistry.peers.has("hub-c")).toBe(false);

    const entry = gossipEntryFor(hubA, "hub-c");
    const bAsPeer = hubA.app.peerRegistry.peers.get("hub-b")!;
    const body = Buffer.from(JSON.stringify({ peer: entry }), "utf-8");
    const res = await hubA.app.federatedFetch(bAsPeer, "/federation/peers/announce", {
      method: "POST",
      body,
      asUser: "admin-hub-a",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; added: boolean };
    expect(json).toEqual({ ok: true, added: true });
    expect(hubB.app.peerRegistry.peers.has("hub-c")).toBe(true);
  });

  it("announce of an already-known peer returns added:false", async () => {
    await admit(hubA, hubB);
    await admit(hubA, hubC);
    await waitFor(() => hubB.app.peerRegistry.peers.has("hub-c"));

    const entry = gossipEntryFor(hubA, "hub-c");
    const bAsPeer = hubA.app.peerRegistry.peers.get("hub-b")!;
    const body = Buffer.from(JSON.stringify({ peer: entry }), "utf-8");
    const res = await hubA.app.federatedFetch(bAsPeer, "/federation/peers/announce", {
      method: "POST",
      body,
      asUser: "admin-hub-a",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, added: false });
  });

  it("announce with mismatched inviter fields is rejected", async () => {
    await admit(hubA, hubB);
    await admit(hubA, hubC);
    await waitFor(() => hubB.app.peerRegistry.peers.has("hub-c"));
    hubB.app.db.prepare("DELETE FROM instances WHERE id = 'hub-c'").run();
    hubB.app.peerRegistry.reload();

    const entry = gossipEntryFor(hubA, "hub-c");
    // Tamper the top-level inviter_url so it diverges from the embedded payload.
    entry.inviter_url = "http://evil.example";

    const bAsPeer = hubA.app.peerRegistry.peers.get("hub-b")!;
    const body = Buffer.from(JSON.stringify({ peer: entry }), "utf-8");
    const res = await hubA.app.federatedFetch(bAsPeer, "/federation/peers/announce", {
      method: "POST",
      body,
      asUser: "admin-hub-a",
    });
    expect(res.status).toBe(400);
    expect(hubB.app.peerRegistry.peers.has("hub-c")).toBe(false);
  });

  it("announce without peer-auth headers returns 401", async () => {
    await admit(hubA, hubB);
    const res = await fetch(`${hubB.url}/federation/peers/announce`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from("{}", "utf-8"),
    });
    expect(res.status).toBe(401);
  });

  it("ingestGossipEntry helper: alreadyKnown short-circuits", () => {
    // Sanity coverage for the helper used by both gossip and announce paths.
    // No DB state needed beyond what the hub provides.
    const owner = hubA.app.db.prepare("SELECT id FROM users LIMIT 1").get() as {
      id: string;
    };
    const knownIds = new Set(["local", "hub-a", "hub-z"]);
    const result = ingestGossipEntry(
      hubA.app.db,
      hubA.app.peerRegistry,
      { id: "hub-z" } as Partial<GossipPeerEntry>,
      { sourceLabel: "test", ownerId: owner.id, knownIds },
    );
    expect(result).toBe("alreadyKnown");
  });
});
