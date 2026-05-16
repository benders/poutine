/**
 * Shared test helpers for spinning up real Fastify hubs and admitting peers
 * via the full v5 invitation/handshake flow.
 *
 * Used by gossip.test.ts and peer-announce.test.ts. Each hub binds to a
 * random port, uses an in-memory SQLite db, and seeds an admin user named
 * `admin-<id>`.
 */

import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import { buildApp } from "../../src/server.js";
import type { Config } from "../../src/config.js";
import { seedAdminUser } from "./admin-user.js";

export interface Hub {
  app: FastifyInstance;
  port: number;
  url: string;
  keyPath: string;
  token: string;
}

export function tmpPath(prefix: string, suffix = ""): string {
  return path.join(
    os.tmpdir(),
    `poutine-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}`,
  );
}

export async function startHub(id: string, prefix = "hub"): Promise<Hub> {
  const keyPath = tmpPath(prefix, `${id}-key.pem`);
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

/** Run the full /admin/peers/invite + /admin/peers/accept handshake. */
export async function admit(inviter: Hub, invitee: Hub): Promise<void> {
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
