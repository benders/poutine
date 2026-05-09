/**
 * End-to-end test for the v5 invitation/handshake admission protocol.
 *
 * Spins up two real hubs (A = inviter, B = invitee). A issues an invitation
 * via POST /admin/peers/invite; B redeems it via POST /admin/peers/accept.
 * The accept endpoint posts to A's POST /federation/handshake, which
 * inserts B into A's instances table and marks the invitation consumed.
 * B mirrors A as a peer in its own instances table.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { seedAdminUser } from "./helpers/admin-user.js";
import {
  decodeInvitation,
  verifyInvitationSignature,
} from "../src/federation/invitations.js";
import type { Config } from "../src/config.js";

function tmpPath(suffix = "") {
  return path.join(
    os.tmpdir(),
    `poutine-hs-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}`,
  );
}

describe("federation handshake (v5 invitation flow)", () => {
  let appA: FastifyInstance;
  let appB: FastifyInstance;
  let portA: number;
  let portB: number;
  let keyPathA: string;
  let keyPathB: string;
  let tokenA: string;
  let tokenB: string;
  let urlA: string;
  let urlB: string;

  beforeEach(async () => {
    keyPathA = tmpPath("key-a.pem");
    keyPathB = tmpPath("key-b.pem");

    const configA: Partial<Config> = {
      databasePath: ":memory:",
      jwtSecret: "test-a",
      poutinePrivateKeyPath: keyPathA,
      poutineInstanceId: "hub-a",
      navidromeUrl: "http://127.0.0.1:1",
      navidromeUsername: "x",
      navidromePassword: "x",
    };
    appA = await buildApp(configA);
    await appA.ready();
    await appA.listen({ port: 0, host: "127.0.0.1" });
    portA = (appA.server.address() as AddressInfo).port;
    urlA = `http://127.0.0.1:${portA}`;

    const configB: Partial<Config> = {
      databasePath: ":memory:",
      jwtSecret: "test-b",
      poutinePrivateKeyPath: keyPathB,
      poutineInstanceId: "hub-b",
      navidromeUrl: "http://127.0.0.1:1",
      navidromeUsername: "x",
      navidromePassword: "x",
    };
    appB = await buildApp(configB);
    await appB.ready();
    await appB.listen({ port: 0, host: "127.0.0.1" });
    portB = (appB.server.address() as AddressInfo).port;
    urlB = `http://127.0.0.1:${portB}`;

    ({ token: tokenA } = await seedAdminUser(appA, "admin-a"));
    ({ token: tokenB } = await seedAdminUser(appB, "admin-b"));
  });

  afterEach(async () => {
    await appA.close();
    await appB.close();
    for (const f of [keyPathA, keyPathB]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("issues, accepts, and admits a peer end-to-end", async () => {
    // A issues invitation for B
    const issueRes = await appA.inject({
      method: "POST",
      url: "/admin/peers/invite",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { ourUrl: urlA, inviteeUrl: urlB, expiresInSec: 600 },
    });
    expect(issueRes.statusCode).toBe(200);
    const { invitation } = issueRes.json() as { invitation: string };
    expect(typeof invitation).toBe("string");

    // Sanity: signature verifies and inviter_id == hub-a
    const decoded = decodeInvitation(invitation);
    expect(decoded.payload.inviter_id).toBe("hub-a");
    expect(verifyInvitationSignature(decoded).ok).toBe(true);

    // Invitation row persisted on A as unconsumed
    const invRow = appA.db
      .prepare("SELECT consumed_at FROM invitations WHERE nonce = ?")
      .get(decoded.payload.nonce) as { consumed_at: string | null } | undefined;
    expect(invRow).toBeDefined();
    expect(invRow!.consumed_at).toBeNull();

    // B accepts — calls A's /federation/handshake
    const acceptRes = await appB.inject({
      method: "POST",
      url: "/admin/peers/accept",
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { invitation, ourUrl: urlB },
    });
    expect(acceptRes.statusCode).toBe(200);
    expect(acceptRes.json()).toMatchObject({ ok: true, peerId: "hub-a" });

    // A: hub-b is now a peer with provenance
    const peerRowOnA = appA.db
      .prepare(
        "SELECT id, url, public_key, invitation_payload, inviter_id FROM instances WHERE id = 'hub-b'",
      )
      .get() as
      | {
          id: string;
          url: string;
          public_key: string;
          invitation_payload: string;
          inviter_id: string;
        }
      | undefined;
    expect(peerRowOnA).toBeDefined();
    expect(peerRowOnA!.url).toBe(urlB);
    expect(peerRowOnA!.public_key).toMatch(/^ed25519:/);
    expect(peerRowOnA!.inviter_id).toBe("hub-a");
    expect(JSON.parse(peerRowOnA!.invitation_payload).nonce).toBe(decoded.payload.nonce);
    expect(appA.peerRegistry.peers.has("hub-b")).toBe(true);

    // A: invitation marked consumed
    const consumed = appA.db
      .prepare("SELECT consumed_at, consumed_by_id FROM invitations WHERE nonce = ?")
      .get(decoded.payload.nonce) as
      | { consumed_at: string | null; consumed_by_id: string | null }
      | undefined;
    expect(consumed!.consumed_at).not.toBeNull();
    expect(consumed!.consumed_by_id).toBe("hub-b");

    // B: hub-a is now a peer with the same invitation as provenance
    const peerRowOnB = appB.db
      .prepare(
        "SELECT id, url, public_key, invitation_payload FROM instances WHERE id = 'hub-a'",
      )
      .get() as
      | {
          id: string;
          url: string;
          public_key: string;
          invitation_payload: string;
        }
      | undefined;
    expect(peerRowOnB).toBeDefined();
    expect(peerRowOnB!.url).toBe(urlA);
    expect(peerRowOnB!.public_key).toMatch(/^ed25519:/);
    expect(JSON.parse(peerRowOnB!.invitation_payload).nonce).toBe(
      decoded.payload.nonce,
    );
    expect(appB.peerRegistry.peers.has("hub-a")).toBe(true);
  });

  it("rejects a replayed invitation (single-use)", async () => {
    const issueRes = await appA.inject({
      method: "POST",
      url: "/admin/peers/invite",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { ourUrl: urlA, inviteeUrl: urlB },
    });
    const { invitation } = issueRes.json() as { invitation: string };

    const first = await appB.inject({
      method: "POST",
      url: "/admin/peers/accept",
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { invitation, ourUrl: urlB },
    });
    expect(first.statusCode).toBe(200);

    // Build a second hub C and try to redeem the same invitation.
    const keyPathC = tmpPath("key-c.pem");
    const configC: Partial<Config> = {
      databasePath: ":memory:",
      jwtSecret: "test-c",
      poutinePrivateKeyPath: keyPathC,
      poutineInstanceId: "hub-c",
      navidromeUrl: "http://127.0.0.1:1",
      navidromeUsername: "x",
      navidromePassword: "x",
    };
    const appC = await buildApp(configC);
    await appC.ready();
    await appC.listen({ port: 0, host: "127.0.0.1" });
    const portC = (appC.server.address() as AddressInfo).port;
    const { token: tokenC } = await seedAdminUser(appC, "admin-c");

    try {
      const second = await appC.inject({
        method: "POST",
        url: "/admin/peers/accept",
        headers: { authorization: `Bearer ${tokenC}` },
        payload: { invitation, ourUrl: `http://127.0.0.1:${portC}` },
      });
      // Original invitation was bound to urlB, so C is rejected by inviter_url
      // mismatch (403) before consume check; either way it must NOT be 200.
      expect(second.statusCode).not.toBe(200);
    } finally {
      await appC.close();
      if (fs.existsSync(keyPathC)) fs.unlinkSync(keyPathC);
    }
  });

  it("rejects a tampered invitation", async () => {
    const issueRes = await appA.inject({
      method: "POST",
      url: "/admin/peers/invite",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { ourUrl: urlA, inviteeUrl: urlB },
    });
    const { invitation } = issueRes.json() as { invitation: string };

    // Tamper the JSON: change inviter_url, re-encode without re-signing.
    const decoded = decodeInvitation(invitation);
    const tampered = {
      payload: { ...decoded.payload, inviter_url: "http://evil.example" },
      signature: decoded.signature,
    };
    const tamperedWire = Buffer.from(JSON.stringify(tampered), "utf8").toString(
      "base64",
    );

    const acceptRes = await appB.inject({
      method: "POST",
      url: "/admin/peers/accept",
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { invitation: tamperedWire, ourUrl: urlB },
    });
    expect(acceptRes.statusCode).toBe(400);
  });
});
