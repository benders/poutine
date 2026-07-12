/**
 * Tests for the admin routes.
 *
 * Auth (`/login`, `/me`) is served at `/admin/*` per the historical mount
 * (#226 keeps the legacy prefix for the refresh-cookie path). Hub-owned
 * endpoints (users, peers, sync, instance, cache) are reached at
 * `/api/admin/hub/*`. Player-owned settings are tested in `sonos-settings.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { setPassword } from "../src/auth/passwords.js";
import type { Config } from "../src/config.js";

const testConfig: Partial<Config> = {
  databasePath: ":memory:",
  jwtSecret: "test-secret-key-for-admin-tests",
};

function seedAdmin(
  app: FastifyInstance,
  username = "owner",
  password = "adminpass",
): string {
  const enc = setPassword(password, app.passwordKey);
  app.db
    .prepare(
      "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, 1)",
    )
    .run("admin-1", username, enc);
  return password;
}

async function loginAs(
  app: FastifyInstance,
  username: string,
  password: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/admin/login",
    payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  return body.accessToken as string;
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

// ── Login ─────────────────────────────────────────────────────────────────────

describe("admin — login", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    seedAdmin(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it("correct credentials → 200 with user info, accessToken, and subsonic creds", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/login",
      payload: { username: "owner", password: "adminpass" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.username).toBe("owner");
    expect(body.user.isAdmin).toBe(true);
    expect(typeof body.accessToken).toBe("string");
    expect(body.accessToken.length).toBeGreaterThan(0);
    // SPA needs the plaintext password to compute u+t+s for /rest/* (#106)
    expect(body.subsonicCredentials).toEqual({
      username: "owner",
      password: "adminpass",
    });
  });

  it("wrong password → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/login",
      payload: { username: "owner", password: "wrongpass" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("unknown username → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/login",
      payload: { username: "nobody", password: "adminpass" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("missing body fields → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/login",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("non-admin user → 200 with isAdmin=false (#232)", async () => {
    const enc = setPassword("guestpass1", app.passwordKey);
    app.db
      .prepare(
        "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, 0)",
      )
      .run("guest-1", "guest", enc);

    const res = await app.inject({
      method: "POST",
      url: "/admin/login",
      payload: { username: "guest", password: "guestpass1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ username: "guest", isAdmin: false });
  });

  it("unauthenticated request to protected endpoint → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/hub/users" });
    expect(res.statusCode).toBe(401);
  });
});

// ── /admin/me ─────────────────────────────────────────────────────────────────

describe("admin — me", () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    seedAdmin(app);
    token = await loginAs(app, "owner", "adminpass");
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /admin/me → returns current user info", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/me",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.username).toBe("owner");
    expect(body.isAdmin).toBe(true);
  });
});

// ── /api/admin/hub/users ──────────────────────────────────────────────────────────────

describe("admin — users CRUD", () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    seedAdmin(app);
    token = await loginAs(app, "owner", "adminpass");
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /api/admin/hub/users → lists users (excluding __system__)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/hub/users",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const users = res.json() as Array<{ username: string }>;
    expect(Array.isArray(users)).toBe(true);
    expect(users.some((u) => u.username === "owner")).toBe(true);
    expect(users.some((u) => u.username === "__system__")).toBe(false);
  });

  it("POST /api/admin/hub/users → creates a guest user and returns 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/hub/users",
      headers: authHeader(token),
      payload: { username: "newguest", password: "guestpass1" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.username).toBe("newguest");
    expect(body.isAdmin).toBe(false);
    expect(typeof body.id).toBe("string");
  });

  it("POST /api/admin/hub/users with duplicate username → 409", async () => {
    await app.inject({
      method: "POST",
      url: "/api/admin/hub/users",
      headers: authHeader(token),
      payload: { username: "dupe", password: "password1" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/hub/users",
      headers: authHeader(token),
      payload: { username: "dupe", password: "password2" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("POST /api/admin/hub/users with short password → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/hub/users",
      headers: authHeader(token),
      payload: { username: "shortpw", password: "abc" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE /api/admin/hub/users/:id → removes the user and returns 204", async () => {
    // Create a user to delete
    const create = await app.inject({
      method: "POST",
      url: "/api/admin/hub/users",
      headers: authHeader(token),
      payload: { username: "todelete", password: "deletepass" },
    });
    const { id } = create.json() as { id: string };

    const del = await app.inject({
      method: "DELETE",
      url: `/api/admin/hub/users/${id}`,
      headers: authHeader(token),
    });
    expect(del.statusCode).toBe(204);

    // Verify it's gone
    const list = await app.inject({
      method: "GET",
      url: "/api/admin/hub/users",
      headers: authHeader(token),
    });
    const users = list.json() as Array<{ username: string }>;
    expect(users.some((u) => u.username === "todelete")).toBe(false);
  });

  it("DELETE /api/admin/hub/users/:id for unknown id → 404", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/admin/hub/users/nonexistent-id",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE own account → 400", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/admin/hub/users/admin-1",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── /api/admin/hub/peers ──────────────────────────────────────────────────────────────

describe("admin — peers", () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    seedAdmin(app);
    token = await loginAs(app, "owner", "adminpass");
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /api/admin/hub/peers → returns an array (empty when no peers configured)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/hub/peers",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});

// ── /api/admin/hub/peers/data ─────────────────────────────────────────────────────────

describe("admin — delete peer data", () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    seedAdmin(app);
    token = await loginAs(app, "owner", "adminpass");

    // Seed a fake peer instance and some peer data
    app.db.prepare(
      `INSERT OR IGNORE INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status, last_synced_at, track_count)
       VALUES ('peer-1', 'Peer One', 'http://peer1.example.com', 'subsonic', '', 'admin-1', 'online', datetime('now'), 5)`,
    ).run();
    app.db.prepare(
      `INSERT OR IGNORE INTO instance_artists (id, instance_id, remote_id, name)
       VALUES ('peer-1:artist-1', 'peer-1', 'artist-1', 'Test Artist')`,
    ).run();
    app.db.prepare(
      `INSERT OR IGNORE INTO instance_albums (id, instance_id, remote_id, name, artist_id, artist_name, track_count, duration_ms)
       VALUES ('peer-1:album-1', 'peer-1', 'album-1', 'Test Album', 'peer-1:artist-1', 'Test Artist', 1, 60000)`,
    ).run();
    app.db.prepare(
      `INSERT OR IGNORE INTO instance_tracks (id, instance_id, remote_id, album_id, title, artist_name, duration_ms, track_number, disc_number, bitrate, format, size)
       VALUES ('peer-1:track-1', 'peer-1', 'track-1', 'peer-1:album-1', 'Test Track', 'Test Artist', 60000, 1, 1, 128, 'mp3', 1000000)`,
    ).run();
  });

  afterEach(async () => {
    await app.close();
  });

  it("DELETE /api/admin/hub/peers/data → returns 200 with { deleted: true }", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/admin/hub/peers/data",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });
  });

  it("DELETE /api/admin/hub/peers/data → clears peer instance data and resets sync state", async () => {
    await app.inject({
      method: "DELETE",
      url: "/api/admin/hub/peers/data",
      headers: authHeader(token),
    });

    const artists = app.db
      .prepare("SELECT * FROM instance_artists WHERE instance_id != 'local'")
      .all();
    expect(artists).toHaveLength(0);

    const albums = app.db
      .prepare("SELECT * FROM instance_albums WHERE instance_id != 'local'")
      .all();
    expect(albums).toHaveLength(0);

    const tracks = app.db
      .prepare("SELECT * FROM instance_tracks WHERE instance_id != 'local'")
      .all();
    expect(tracks).toHaveLength(0);

    const peer = app.db
      .prepare("SELECT * FROM instances WHERE id = 'peer-1'")
      .get() as { last_synced_at: string | null; track_count: number; status: string };
    expect(peer.last_synced_at).toBeNull();
    expect(peer.track_count).toBe(0);
    expect(peer.status).toBe("offline");
  });

  it("DELETE /api/admin/hub/peers/data → 401 without auth", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/admin/hub/peers/data" });
    expect(res.statusCode).toBe(401);
  });
});

// ── /api/admin/hub/peers/:id lifecycle (issue #244, Phase 2) ─────────────────────────

describe("admin — peer lifecycle", () => {
  let app: FastifyInstance;
  let token: string;

  function seedPeer(id: string, lifecycle = "active") {
    app.db
      .prepare(
        `INSERT OR IGNORE INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status, public_key, lifecycle)
         VALUES (?, ?, ?, 'subsonic', '', 'admin-1', 'online', 'ed25519:${Buffer.alloc(32, 7).toString("base64")}', ?)`,
      )
      .run(id, id, `http://${id}.example.com`, lifecycle);
    app.peerRegistry.reload();
  }

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    seedAdmin(app);
    token = await loginAs(app, "owner", "adminpass");
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /peers/:id/disable → sets lifecycle=disabled and reloads the registry", async () => {
    seedPeer("peer-a");
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/hub/peers/peer-a/disable",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "peer-a", lifecycle: "disabled" });
    expect(app.peerRegistry.peers.get("peer-a")?.lifecycle).toBe("disabled");
  });

  it("disable → enable round trip returns to active and reloads the registry", async () => {
    seedPeer("peer-b");
    await app.inject({
      method: "POST",
      url: "/api/admin/hub/peers/peer-b/disable",
      headers: authHeader(token),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/hub/peers/peer-b/enable",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "peer-b", lifecycle: "active" });
    expect(app.peerRegistry.peers.get("peer-b")?.lifecycle).toBe("active");
  });

  it("POST /peers/:id/disable for unknown id → 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/hub/peers/nonexistent/disable",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /peers/local/disable → rejected (400)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/hub/peers/local/disable",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
  });

  it("tombstoned peer cannot be disabled", async () => {
    seedPeer("peer-c", "tombstoned");
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/hub/peers/peer-c/disable",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(409);
  });

  it("tombstoned peer cannot be enabled", async () => {
    seedPeer("peer-d", "tombstoned");
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/hub/peers/peer-d/enable",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(409);
  });

  it("unauthenticated request → 401", async () => {
    seedPeer("peer-e");
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/hub/peers/peer-e/disable",
    });
    expect(res.statusCode).toBe(401);
  });

  it("authenticated non-admin user → 403", async () => {
    seedPeer("peer-e2");
    const enc = setPassword("userpass", app.passwordKey);
    app.db
      .prepare(
        "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, 0)",
      )
      .run("user-1", "regular", enc);
    const userToken = await loginAs(app, "regular", "userpass");
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/hub/peers/peer-e2/disable",
      headers: authHeader(userToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it("DELETE /peers/:id → tombstones the peer and writes a verifiable signed tombstone", async () => {
    seedPeer("peer-f");
    const res = await app.inject({
      method: "DELETE",
      url: "/api/admin/hub/peers/peer-f",
      headers: authHeader(token),
      payload: { reason: "spamming gossip" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ id: "peer-f", lifecycle: "tombstoned" });
    expect(body.tombstone.reason).toBe("spamming gossip");
    expect(app.peerRegistry.peers.get("peer-f")?.lifecycle).toBe("tombstoned");

    const row = app.db
      .prepare("SELECT * FROM peer_tombstones WHERE instance_id = 'peer-f'")
      .get() as {
      instance_id: string;
      removed_by: string;
      reason: string | null;
      created_at: string;
      signature: string;
    };
    expect(row).toBeTruthy();
    const { verifyTombstone } = await import("../src/federation/tombstones.js");
    const { createPublicKey } = await import("node:crypto");
    expect(
      verifyTombstone(
        {
          instanceId: row.instance_id,
          removedBy: row.removed_by,
          reason: row.reason,
          createdAt: row.created_at,
          signature: row.signature,
        },
        createPublicKey(app.privateKey),
      ),
    ).toBe(true);
  });

  it("DELETE /peers/:id is idempotent — deleting an already-tombstoned peer doesn't error or duplicate the row", async () => {
    seedPeer("peer-g");
    const first = await app.inject({
      method: "DELETE",
      url: "/api/admin/hub/peers/peer-g",
      headers: authHeader(token),
    });
    expect(first.statusCode).toBe(200);
    const firstCreatedAt = first.json().tombstone.createdAt;

    const second = await app.inject({
      method: "DELETE",
      url: "/api/admin/hub/peers/peer-g",
      headers: authHeader(token),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().tombstone.createdAt).toBe(firstCreatedAt);

    const count = app.db
      .prepare("SELECT COUNT(*) AS n FROM peer_tombstones WHERE instance_id = 'peer-g'")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("DELETE /peers/:id for unknown id → 404", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/admin/hub/peers/nonexistent",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /peers/local → rejected (400)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/admin/hub/peers/local",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── /api/admin/hub/sync ───────────────────────────────────────────────────────────────

describe("admin — sync", () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    seedAdmin(app);
    token = await loginAs(app, "owner", "adminpass");
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /api/admin/hub/sync → returns 200 with local + peers result shape", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/hub/sync",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // syncAll always returns this shape even when Navidrome is unreachable
    expect(body).toHaveProperty("local");
    expect(body).toHaveProperty("peers");
    expect(Array.isArray(body.peers)).toBe(true);
    expect(body.local).toHaveProperty("errors");
  });
});

// ── /api/admin/hub/instance ───────────────────────────────────────────────────────────

/** Wrap a value in a Subsonic JSON envelope. */
function subsonicEnvelope(payload: Record<string, unknown>) {
  return JSON.stringify({
    "subsonic-response": { status: "ok", version: "1.16.1", ...payload },
  });
}

describe("admin — instance", () => {
  let app: FastifyInstance;
  let token: string;
  let fetchMock: Mock;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    seedAdmin(app);
    token = await loginAs(app, "owner", "adminpass");

    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it("GET /api/admin/hub/instance → returns instanceId, publicKey, and navidrome fields", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        subsonicEnvelope({
          scanStatus: { scanning: false, count: 0, folderCount: 2, lastScan: "2024-06-01T10:00:00Z" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/hub/instance",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.instanceId).toBe("string");
    expect(body.publicKey).toMatch(/^ed25519:/);
    expect(typeof body.appVersion).toBe("string");
    expect(typeof body.apiVersion).toBe("number");
    expect(typeof body.artistCount).toBe("number");
    expect(typeof body.albumCount).toBe("number");
    expect(typeof body.trackCount).toBe("number");
    expect(body.navidrome.reachable).toBe(true);
    expect(body.navidrome.scanning).toBe(false);
    expect(body.navidrome.folderCount).toBe(2);
    expect(body.navidrome.lastScan).toBe("2024-06-01T10:00:00Z");
    expect(typeof body.navidrome.trackCount).toBe("number");
    expect(body.navidrome.status).toBe("online"); // seeded as online by seedSyntheticInstances
  });

  it("GET /api/admin/hub/instance → reachable=false when Navidrome is down", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/hub/instance",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.navidrome.reachable).toBe(false);
    expect(body.navidrome.scanning).toBe(false);
    expect(body.navidrome.lastScan).toBeNull();
    expect(body.navidrome.folderCount).toBeNull();
  });

  it("GET /api/admin/hub/instance → 401 without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/hub/instance" });
    expect(res.statusCode).toBe(401);
  });

  it("POST /api/admin/hub/instance/scan → triggers scan and returns status", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        subsonicEnvelope({
          scanStatus: { scanning: true, count: 0, folderCount: 2, lastScan: "2024-06-01T10:00:00Z" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/hub/instance/scan",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scanning).toBe(true);
    expect(body.folderCount).toBe(2);

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/rest/startScan");
  });

  it("POST /api/admin/hub/instance/scan → 502 when Navidrome is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/hub/instance/scan",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/unreachable/i);
  });

  it("POST /api/admin/hub/instance/scan → 401 without auth", async () => {
    const res = await app.inject({ method: "POST", url: "/api/admin/hub/instance/scan" });
    expect(res.statusCode).toBe(401);
  });
});

// ── /api/admin/hub/cache ──────────────────────────────────────────────────────────────

describe("admin — cache", () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    seedAdmin(app);
    token = await loginAs(app, "owner", "adminpass");
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /api/admin/hub/cache → returns cache stats with expected keys", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/hub/cache",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.artCacheMaxBytes).toBe("number");
    expect(typeof body.artCacheCurrentBytes).toBe("number");
    expect(typeof body.artCacheFileCount).toBe("number");
  });

  it("PUT /api/admin/hub/cache with artCacheMaxBytes → updates and returns new stats", async () => {
    const newMax = 50 * 1024 * 1024; // 50 MB
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/hub/cache",
      headers: authHeader(token),
      payload: { artCacheMaxBytes: newMax },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.artCacheMaxBytes).toBe(newMax);
  });

  it("PUT /api/admin/hub/cache with negative value → 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/hub/cache",
      headers: authHeader(token),
      payload: { artCacheMaxBytes: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE /api/admin/hub/cache → clears cache and returns 204", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/admin/hub/cache",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(204);
  });
});
