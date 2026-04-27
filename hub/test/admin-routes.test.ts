/**
 * Tests for the /admin/* routes.
 *
 * Covers: login, me, users CRUD, peers list, sync trigger, cache stats/control.
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

  it("non-admin user → 403", async () => {
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
    expect(res.statusCode).toBe(403);
  });

  it("unauthenticated request to protected endpoint → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/users" });
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

// ── /admin/users ──────────────────────────────────────────────────────────────

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

  it("GET /admin/users → lists users (excluding __system__)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const users = res.json() as Array<{ username: string }>;
    expect(Array.isArray(users)).toBe(true);
    expect(users.some((u) => u.username === "owner")).toBe(true);
    expect(users.some((u) => u.username === "__system__")).toBe(false);
  });

  it("POST /admin/users → creates a guest user and returns 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeader(token),
      payload: { username: "newguest", password: "guestpass1" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.username).toBe("newguest");
    expect(body.isAdmin).toBe(false);
    expect(typeof body.id).toBe("string");
  });

  it("POST /admin/users with duplicate username → 409", async () => {
    await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeader(token),
      payload: { username: "dupe", password: "password1" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeader(token),
      payload: { username: "dupe", password: "password2" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("POST /admin/users with short password → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeader(token),
      payload: { username: "shortpw", password: "abc" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE /admin/users/:id → removes the user and returns 204", async () => {
    // Create a user to delete
    const create = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeader(token),
      payload: { username: "todelete", password: "deletepass" },
    });
    const { id } = create.json() as { id: string };

    const del = await app.inject({
      method: "DELETE",
      url: `/admin/users/${id}`,
      headers: authHeader(token),
    });
    expect(del.statusCode).toBe(204);

    // Verify it's gone
    const list = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: authHeader(token),
    });
    const users = list.json() as Array<{ username: string }>;
    expect(users.some((u) => u.username === "todelete")).toBe(false);
  });

  it("DELETE /admin/users/:id for unknown id → 404", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/admin/users/nonexistent-id",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE own account → 400", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/admin/users/admin-1",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── /admin/peers ──────────────────────────────────────────────────────────────

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

  it("GET /admin/peers → returns an array (empty when no peers configured)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/peers",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});

// ── /admin/peers/data ─────────────────────────────────────────────────────────

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

  it("DELETE /admin/peers/data → returns 200 with { deleted: true }", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/admin/peers/data",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });
  });

  it("DELETE /admin/peers/data → clears peer instance data and resets sync state", async () => {
    await app.inject({
      method: "DELETE",
      url: "/admin/peers/data",
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

  it("DELETE /admin/peers/data → 401 without auth", async () => {
    const res = await app.inject({ method: "DELETE", url: "/admin/peers/data" });
    expect(res.statusCode).toBe(401);
  });
});

// ── /admin/sync ───────────────────────────────────────────────────────────────

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

  it("POST /admin/sync → returns 200 with local + peers result shape", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/sync",
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

// ── /admin/instance ───────────────────────────────────────────────────────────

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

  it("GET /admin/instance → returns instanceId, publicKey, and navidrome fields", async () => {
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
      url: "/admin/instance",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.instanceId).toBe("string");
    expect(body.publicKey).toMatch(/^ed25519:/);
    expect(body.navidrome.reachable).toBe(true);
    expect(body.navidrome.scanning).toBe(false);
    expect(body.navidrome.folderCount).toBe(2);
    expect(body.navidrome.lastScan).toBe("2024-06-01T10:00:00Z");
    expect(typeof body.navidrome.trackCount).toBe("number");
    expect(body.navidrome.status).toBe("online"); // seeded as online by seedSyntheticInstances
  });

  it("GET /admin/instance → reachable=false when Navidrome is down", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await app.inject({
      method: "GET",
      url: "/admin/instance",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.navidrome.reachable).toBe(false);
    expect(body.navidrome.scanning).toBe(false);
    expect(body.navidrome.lastScan).toBeNull();
    expect(body.navidrome.folderCount).toBeNull();
  });

  it("GET /admin/instance → 401 without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/instance" });
    expect(res.statusCode).toBe(401);
  });

  it("POST /admin/instance/scan → triggers scan and returns status", async () => {
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
      url: "/admin/instance/scan",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scanning).toBe(true);
    expect(body.folderCount).toBe(2);

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/rest/startScan");
  });

  it("POST /admin/instance/scan → 502 when Navidrome is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await app.inject({
      method: "POST",
      url: "/admin/instance/scan",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/unreachable/i);
  });

  it("POST /admin/instance/scan → 401 without auth", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/instance/scan" });
    expect(res.statusCode).toBe(401);
  });
});

// ── /admin/cache ──────────────────────────────────────────────────────────────

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

  it("GET /admin/cache → returns cache stats with expected keys", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/cache",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.artCacheMaxBytes).toBe("number");
    expect(typeof body.artCacheCurrentBytes).toBe("number");
    expect(typeof body.artCacheFileCount).toBe("number");
  });

  it("PUT /admin/cache with artCacheMaxBytes → updates and returns new stats", async () => {
    const newMax = 50 * 1024 * 1024; // 50 MB
    const res = await app.inject({
      method: "PUT",
      url: "/admin/cache",
      headers: authHeader(token),
      payload: { artCacheMaxBytes: newMax },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.artCacheMaxBytes).toBe(newMax);
  });

  it("PUT /admin/cache with negative value → 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/admin/cache",
      headers: authHeader(token),
      payload: { artCacheMaxBytes: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE /admin/cache → clears cache and returns 204", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/admin/cache",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(204);
  });
});
