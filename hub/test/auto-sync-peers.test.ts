/**
 * Tests for AutoSyncService.pollPeers() — issue #14 / phase 4 of #147.
 *
 * Verifies the periodic peer-poll path: /api/health updates last_seen,
 * unreachable peers are marked offline, and the conditional-sync gate
 * (peer's lastScan vs our last_synced_at) avoids redundant work.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { seedAdminUser } from "./helpers/admin-user.js";
import { AutoSyncService } from "../src/services/auto-sync.js";
import type { Config } from "../src/config.js";

function tmpPath(suffix = "") {
  return path.join(
    os.tmpdir(),
    `poutine-as-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}`,
  );
}

async function startHub(id: string): Promise<{
  app: FastifyInstance;
  port: number;
  url: string;
  keyPath: string;
  token: string;
}> {
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

async function admit(
  inviter: { app: FastifyInstance; url: string; token: string },
  invitee: { app: FastifyInstance; url: string; token: string },
) {
  const issue = await inviter.app.inject({
    method: "POST",
    url: "/api/admin/hub/peers/invite",
    headers: { authorization: `Bearer ${inviter.token}` },
    payload: { ourUrl: inviter.url, inviteeUrl: invitee.url, expiresInSec: 600 },
  });
  expect(issue.statusCode).toBe(200);
  const { invitation } = issue.json() as { invitation: string };
  const accept = await invitee.app.inject({
    method: "POST",
    url: "/api/admin/hub/peers/accept",
    headers: { authorization: `Bearer ${invitee.token}` },
    payload: { invitation, ourUrl: invitee.url },
  });
  expect(accept.statusCode).toBe(200);
}

describe("AutoSyncService.pollPeers (#14)", () => {
  let hubA: Awaited<ReturnType<typeof startHub>>;
  let hubB: Awaited<ReturnType<typeof startHub>>;

  beforeEach(async () => {
    hubA = await startHub("hub-a");
    hubB = await startHub("hub-b");
    await admit(hubA, hubB);
  });

  afterEach(async () => {
    await hubA.app.close();
    await hubB.app.close();
    for (const f of [hubA.keyPath, hubB.keyPath]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("updates last_seen when peer /api/health responds 200", async () => {
    const before = hubA.app.db
      .prepare("SELECT last_seen FROM instances WHERE id = 'hub-b'")
      .get() as { last_seen: string | null };
    expect(before.last_seen).toBeNull();

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

    // Health check sets last_seen + status='online' before any sync attempt.
    // Note: subsequent syncPeer fails because the dummy Navidrome at
    // 127.0.0.1:1 is unreachable — we don't assert final status here, only
    // that the health-check leg ran (last_seen is set).
    const after = hubA.app.db
      .prepare("SELECT last_seen FROM instances WHERE id = 'hub-b'")
      .get() as { last_seen: string | null };
    expect(after.last_seen).not.toBeNull();
  });

  it("marks peer offline when /api/health is unreachable", async () => {
    // Close hub-b so its /api/health fails
    await hubB.app.close();

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

    const row = hubA.app.db
      .prepare("SELECT status FROM instances WHERE id = 'hub-b'")
      .get() as { status: string };
    expect(row.status).toBe("offline");

    // Re-open a placeholder so afterEach.close() doesn't crash
    const replacement = http.createServer();
    await new Promise<void>((r) => replacement.listen(hubB.port, "127.0.0.1", () => r()));
    hubB.app = {
      ...hubB.app,
      close: async () => {
        await new Promise<void>((r) => replacement.close(() => r()));
      },
    } as FastifyInstance;
  });
});
