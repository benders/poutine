/**
 * Tests for the v5 gossip transport.
 *
 * Three-hub topology: A invites B; B invites C. After A syncs B (gossip
 * fires automatically), A discovers C via the signed invitation B carries
 * for C. Negative path: gossip rejects entries with bad/tampered embedded
 * invitation signatures.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { seedAdminUser } from "./helpers/admin-user.js";
import { seedPeer } from "./helpers/seed-peer.js";
import { gossipFromPeer } from "../src/federation/gossip.js";
import {
  createInvitation,
  encodeInvitation,
} from "../src/federation/invitations.js";
import { loadOrCreatePrivateKey } from "../src/federation/signing.js";
import type { Config } from "../src/config.js";

function tmpPath(suffix = "") {
  return path.join(
    os.tmpdir(),
    `poutine-gossip-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}`,
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

describe("federation gossip (v5, #147)", () => {
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

  it("A discovers C through B's gossip after A↔B and B↔C admissions", async () => {
    await admit(hubA, hubB); // A invites B → both hubs know each other
    await admit(hubB, hubC); // B invites C → both hubs know each other

    // Pre-condition: A does not yet know C
    expect(hubA.app.peerRegistry.peers.has("hub-c")).toBe(false);

    // Trigger gossip from A pulling B's peer list
    const bAsPeer = hubA.app.peerRegistry.peers.get("hub-b");
    expect(bAsPeer).toBeDefined();
    const result = await gossipFromPeer(
      hubA.app.db,
      hubA.app.peerRegistry,
      bAsPeer!,
      hubA.app.federatedFetch,
      "admin-a",
    );

    expect(result.added).toContain("hub-c");
    expect(hubA.app.peerRegistry.peers.has("hub-c")).toBe(true);

    // Provenance row must include the original invitation B holds for C
    const row = hubA.app.db
      .prepare(
        "SELECT inviter_id, invitation_payload FROM instances WHERE id = 'hub-c'",
      )
      .get() as { inviter_id: string; invitation_payload: string };
    expect(row.inviter_id).toBe("hub-b");
    expect(JSON.parse(row.invitation_payload).inviter_id).toBe("hub-b");
  });

  it("rejects a gossiped entry with a tampered invitation payload", async () => {
    await admit(hubA, hubB);

    // Fabricate a malicious peer entry: a payload signed by a stranger key,
    // claiming to come from hub-a. Signature won't match hub-a's pubkey.
    const strangerKey = tmpPath("stranger.pem");
    try {
      const { privateKey: strangerPriv, publicKeyBase64: strangerPub } =
        loadOrCreatePrivateKey(strangerKey);
      const fakeInvite = createInvitation({
        privateKey: strangerPriv,
        // CLAIM the inviter is hub-a, but sign with stranger's key.
        // (createInvitation embeds the public_key we pass in; we lie by
        // claiming hub-a's id but provide stranger's pubkey — when receiver
        // verifies against the embedded pubkey the signature checks out, so
        // that path requires the further check that inviter_id is trusted.
        // For this test we pass a CLAIMED inviter_public_key that doesn't
        // match what's signing — the verify will fail.)
        inviterId: "hub-a",
        inviterUrl: hubA.url,
        inviterPublicKey: `ed25519:${strangerPub}`, // mismatch with hub-a's real pub
        inviteeUrl: null,
      });
      // Now hand-craft a payload claiming to be signed by hub-a but using
      // stranger's signature against a payload that says inviter_public_key
      // is hub-a's actual pub. We can't produce that signature without
      // hub-a's private key, so simulate by tampering the encoded entry:
      const tamperedPayload = {
        ...fakeInvite.payload,
        inviter_public_key: hubA.app.publicKeySpec, // claim hub-a's real pub
      };
      const encoded = encodeInvitation({
        payload: tamperedPayload,
        signature: fakeInvite.signature,
      });
      // Can't directly inject a malicious peer row without an admin route,
      // but we can verify the gossip module rejects it: build a synthetic
      // /federation/peers response by inserting a row into B with bad
      // provenance, then have A pull. We bypass /admin/peers/accept.
      const bDb = hubB.app.db;
      const owner = bDb.prepare("SELECT id FROM users LIMIT 1").get() as
        | { id: string }
        | undefined;
      const next = (
        bDb
          .prepare(
            "SELECT COALESCE(MAX(musicfolder_id), 0) + 1 AS next FROM instances",
          )
          .get() as { next: number }
      ).next;
      bDb
        .prepare(
          `INSERT INTO instances
             (id, name, url, adapter_type, encrypted_credentials, owner_id, status, musicfolder_id,
              public_key, invitation_payload, invitation_signature, inviter_id, inviter_url, inviter_public_key)
           VALUES ('evil-peer','evil','http://evil.example','subsonic','',?,'online',?,
                   ?, ?, ?, 'hub-a', ?, ?)`,
        )
        .run(
          owner!.id,
          next,
          `ed25519:${strangerPub}`,
          JSON.stringify(tamperedPayload),
          fakeInvite.signature,
          hubA.url,
          hubA.app.publicKeySpec,
        );
      hubB.app.peerRegistry.reload();

      // Now A pulls B's peer list — should accept hub-a entry (filtered as
      // self-id by gossip) and reject 'evil-peer' due to signature mismatch.
      const bAsPeer = hubA.app.peerRegistry.peers.get("hub-b");
      const result = await gossipFromPeer(
        hubA.app.db,
        hubA.app.peerRegistry,
        bAsPeer!,
        hubA.app.federatedFetch,
        "admin-a",
      );

      expect(result.added).not.toContain("evil-peer");
      expect(result.rejected).toBeGreaterThanOrEqual(1);
      expect(hubA.app.peerRegistry.peers.has("evil-peer")).toBe(false);
    } finally {
      if (fs.existsSync(strangerKey)) fs.unlinkSync(strangerKey);
    }
  });

  it("rejects a gossiped entry whose inviter_id is not a known peer (#156)", async () => {
    // A admits B. B then forges an entry whose inviter is a stranger hub
    // (not local, not in A's registry). The signature would verify against
    // the embedded stranger key, but A must refuse: trust does not extend
    // to inviters A has never admitted.
    await admit(hubA, hubB);

    const strangerKey = tmpPath("stranger.pem");
    try {
      const { privateKey: strangerPriv, publicKeyBase64: strangerPub } =
        loadOrCreatePrivateKey(strangerKey);
      const fakeInvite = createInvitation({
        privateKey: strangerPriv,
        inviterId: "stranger-hub",
        inviterUrl: "http://stranger.example",
        inviterPublicKey: `ed25519:${strangerPub}`,
        inviteeUrl: null,
      });
      // Need encodeInvitation only to silence unused-import if we kept it;
      // here we reference the encoded form to keep parity with other tests.
      void encodeInvitation(fakeInvite);

      const bDb = hubB.app.db;
      const owner = bDb.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
      const next = (
        bDb
          .prepare("SELECT COALESCE(MAX(musicfolder_id), 0) + 1 AS next FROM instances")
          .get() as { next: number }
      ).next;
      bDb
        .prepare(
          `INSERT INTO instances
             (id, name, url, adapter_type, encrypted_credentials, owner_id, status, musicfolder_id,
              public_key, invitation_payload, invitation_signature, inviter_id, inviter_url, inviter_public_key)
           VALUES ('stranger-peer','stranger','http://stranger-peer.example','subsonic','',?,'online',?,
                   ?, ?, ?, 'stranger-hub', 'http://stranger.example', ?)`,
        )
        .run(
          owner.id,
          next,
          `ed25519:${strangerPub}`,
          JSON.stringify(fakeInvite.payload),
          fakeInvite.signature,
          `ed25519:${strangerPub}`,
        );
      hubB.app.peerRegistry.reload();

      const bAsPeer = hubA.app.peerRegistry.peers.get("hub-b");
      const result = await gossipFromPeer(
        hubA.app.db,
        hubA.app.peerRegistry,
        bAsPeer!,
        hubA.app.federatedFetch,
        "admin-a",
      );

      expect(result.added).not.toContain("stranger-peer");
      expect(result.rejected).toBeGreaterThanOrEqual(1);
      expect(hubA.app.peerRegistry.peers.has("stranger-peer")).toBe(false);
    } finally {
      if (fs.existsSync(strangerKey)) fs.unlinkSync(strangerKey);
    }
  });

  it("filters self and the calling peer from /federation/peers", async () => {
    await admit(hubA, hubB);
    await admit(hubB, hubC);

    // Direct fetch of B's /federation/peers from A's perspective
    const bAsPeer = hubA.app.peerRegistry.peers.get("hub-b");
    const res = await hubA.app.federatedFetch(bAsPeer!, "/federation/peers", {
      asUser: "admin-a",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { peers: Array<{ id: string }> };
    const ids = body.peers.map((p) => p.id);
    // B should advertise hub-c; not hub-a (the caller); not 'local'.
    expect(ids).toContain("hub-c");
    expect(ids).not.toContain("hub-a");
    expect(ids).not.toContain("local");
  });

  // Quiet the unused-helper warning when we don't exercise seedPeer here
  void seedPeer;
});
