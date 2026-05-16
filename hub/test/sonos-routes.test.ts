import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/server.js";
import { setPassword } from "../src/auth/passwords.js";
import { createAccessToken } from "../src/auth/jwt.js";
import type { FastifyInstance } from "fastify";
import type { Config } from "../src/config.js";
import type { SonosDevice } from "../src/services/sonos-discovery.js";
import type { TrackMetadata } from "../src/services/sonos-control.js";

const testConfig: Partial<Config> = {
  databasePath: ":memory:",
  jwtSecret: "test-secret-key-for-testing-purposes",
  sonosEnabled: true,
  poutineLanUrl: "http://hub.lan:3000",
};

const FAKE_DEVICE: SonosDevice = {
  id: "RINCON_TEST",
  room: "Test Room",
  model: "Sonos Test",
  ip: "192.0.2.10",
  port: 1400,
  lastSeen: new Date(),
};

function seedTrack(app: FastifyInstance) {
  app.db
    .prepare("INSERT INTO unified_artists (id, name, name_normalized) VALUES (?, ?, ?)")
    .run("ua-1", "ABBA", "abba");
  app.db
    .prepare(
      "INSERT INTO unified_release_groups (id, name, name_normalized, artist_id, image_url) VALUES (?, ?, ?, ?, ?)",
    )
    .run("urg-1", "Arrival", "arrival", "ua-1", "http://art/arrival.jpg");
  app.db
    .prepare(
      "INSERT INTO unified_releases (id, release_group_id, name) VALUES (?, ?, ?)",
    )
    .run("ur-1", "urg-1", "Arrival");
  app.db
    .prepare(
      "INSERT INTO unified_tracks (id, title, title_normalized, release_id, artist_id, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("trk-1", "Dancing Queen", "dancing queen", "ur-1", "ua-1", 232000);
}

describe("Sonos play route", () => {
  let app: FastifyInstance;
  let setUriCalls: Array<{ device: SonosDevice; uri: string; meta: TrackMetadata }>;
  let playCalls: SonosDevice[];

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();

    const enc = setPassword("secret", app.passwordKey);
    app.db
      .prepare(
        "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, 1)",
      )
      .run("user-1", "tester", enc);
    seedTrack(app);

    // Stub discovery + control so the route exercises real DB + URL logic
    // without touching the network.
    setUriCalls = [];
    playCalls = [];
    (app as unknown as { sonosDiscovery: { get: (id: string) => SonosDevice | undefined } }).sonosDiscovery = {
      get: (id: string) => (id === FAKE_DEVICE.id ? FAKE_DEVICE : undefined),
    };
    (app as unknown as {
      sonosControl: {
        setAvTransportUri: (d: SonosDevice, u: string, m: TrackMetadata) => Promise<void>;
        play: (d: SonosDevice) => Promise<void>;
        seek: (d: SonosDevice, p: number) => Promise<void>;
      };
    }).sonosControl = {
      setAvTransportUri: async (device, uri, meta) => {
        setUriCalls.push({ device, uri, meta });
      },
      play: async (device) => {
        playCalls.push(device);
      },
      seek: async () => {},
    };
  });

  afterEach(async () => {
    await app.close();
  });

  async function authedPost(url: string, body: unknown) {
    const token = await createAccessToken("user-1", app.config);
    return app.inject({
      method: "POST",
      url,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      payload: body,
    });
  }

  it("looks up track via release → release_group join and casts MP3", async () => {
    const res = await authedPost(`/api/sonos/devices/${FAKE_DEVICE.id}/play`, {
      trackId: "trk-1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(setUriCalls).toHaveLength(1);

    const call = setUriCalls[0]!;
    // Stream URL must force format=mp3 so the byte stream matches the
    // audio/mpeg DIDL mime type (regression: PR #162 mismatch broke FLAC).
    expect(call.uri).toContain("format=mp3");
    expect(call.uri).toContain("/cast/stream/trk-1");
    expect(call.uri).toMatch(/^http:\/\/hub\.lan:3000\//);

    // DIDL metadata must reflect data resolved via the two-hop join
    // (regression: PR #162 used non-existent unified_tracks.rg_id).
    expect(call.meta.title).toBe("Dancing Queen");
    expect(call.meta.artist).toBe("ABBA");
    expect(call.meta.album).toBe("Arrival");
    expect(call.meta.albumArtUri).toBe("http://art/arrival.jpg");
    expect(call.meta.durationSec).toBe(232);
    expect(call.meta.mimeType).toBe("audio/mpeg");

    expect(playCalls).toHaveLength(1);
  });

  it("returns 404 for unknown track id", async () => {
    const res = await authedPost(`/api/sonos/devices/${FAKE_DEVICE.id}/play`, {
      trackId: "does-not-exist",
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for unknown device id", async () => {
    const res = await authedPost(`/api/sonos/devices/UNKNOWN/play`, {
      trackId: "trk-1",
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sonos/devices/${FAKE_DEVICE.id}/play`,
      headers: { "content-type": "application/json" },
      payload: { trackId: "trk-1" },
    });
    expect(res.statusCode).toBe(401);
  });
});
