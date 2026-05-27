import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildApp } from "../src/server.js";
import { createAccessToken } from "../src/auth/jwt.js";
import type { FastifyInstance } from "fastify";
import type { Config } from "../src/config.js";
import type { SonosDevice } from "../src/services/sonos-discovery.js";
import {
  SONOS_VOLUME_CAP,
  type TrackMetadata,
} from "../src/services/sonos-control.js";

const testConfig: Partial<Config> = {
  databasePath: ":memory:",
  jwtSecret: "test-secret-key-for-testing-purposes",
  sonosEnabled: true,
  initialLanUrl: "http://hub.lan:3000",
  // #220: Sonos cast planner reads track metadata via Hub Subsonic over
  // `app.inject()` using the owner's u+p. Wire the test owner to the
  // same credentials the tests seed below.
  poutineOwnerUsername: "tester",
  poutineOwnerPassword: "secret",
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

function seedTrackSource(
  app: FastifyInstance,
  format: string | null,
  id = "ts-fmt",
  audio: { samplingRate?: number; bitDepth?: number; channelCount?: number } = {},
) {
  app.db
    .prepare(
      `INSERT OR IGNORE INTO instances (id, name, url, encrypted_credentials, owner_id)
       VALUES ('local', 'Local', 'http://local', '', 'user-1')`,
    )
    .run();
  app.db
    .prepare(
      `INSERT OR IGNORE INTO instance_tracks (id, instance_id, remote_id, album_id, title, artist_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("local:fmt-track", "local", "fmt-track", "local:alb-1", "Dancing Queen", "ABBA");
  app.db
    .prepare(
      `INSERT INTO track_sources (id, unified_track_id, instance_id, instance_track_id, format, sampling_rate, bit_depth, channel_count, preferred)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      id,
      "trk-1",
      "local",
      "local:fmt-track",
      format,
      audio.samplingRate ?? null,
      audio.bitDepth ?? null,
      audio.channelCount ?? null,
    );
}

function seedSubsonicMapping(app: FastifyInstance, remoteId: string) {
  // The SPA passes Subsonic remote_ids, not unified UUIDs. Seed the
  // instances → instance_tracks → track_sources chain so the play route
  // can resolve the Subsonic id back to the unified track.
  app.db
    .prepare(
      `INSERT OR IGNORE INTO instances (id, name, url, encrypted_credentials, owner_id)
       VALUES ('local', 'Local', 'http://local', '', 'user-1')`,
    )
    .run();
  // instance_albums.album_id is a soft reference (no FK enforcement),
  // so we can skip seeding instance_albums entirely for this test.
  app.db
    .prepare(
      `INSERT INTO instance_tracks (id, instance_id, remote_id, album_id, title, artist_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(`local:${remoteId}`, "local", remoteId, "local:alb-1", "Dancing Queen", "ABBA");
  app.db
    .prepare(
      `INSERT INTO track_sources (id, unified_track_id, instance_id, instance_track_id, preferred)
       VALUES (?, ?, ?, ?, 1)`,
    )
    .run("ts-1", "trk-1", "local", `local:${remoteId}`);
}

describe("Sonos play route", () => {
  let app: FastifyInstance;
  let setUriCalls: Array<{ device: SonosDevice; uri: string; meta: TrackMetadata }>;
  let setNextUriCalls: Array<{ device: SonosDevice; uri: string; meta: TrackMetadata | null }>;
  let playCalls: SonosDevice[];
  let seekCalls: Array<{ device: SonosDevice; position: number }>;
  let setVolumeCalls: Array<{ device: SonosDevice; level: number }>;
  let currentVolume = 30;
  let userId: string;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();

    // #220: seedOwner (run by buildApp because testConfig sets
    // POUTINE_OWNER_*) inserts the `tester` user with an auto-generated
    // id and the correct AES-encrypted password. We capture that id here
    // for JWT minting instead of inserting our own (FK-fragile) row.
    const row = app.db
      .prepare("SELECT id FROM users WHERE username = ?")
      .get("tester") as { id: string } | undefined;
    if (!row) throw new Error("test owner user 'tester' not seeded by buildApp");
    userId = row.id;
    seedTrack(app);

    // Stub discovery + control so the route exercises real DB + URL logic
    // without touching the network.
    setUriCalls = [];
    setNextUriCalls = [];
    playCalls = [];
    seekCalls = [];
    setVolumeCalls = [];
    currentVolume = 30;
    (app as unknown as { sonosDiscovery: { get: (id: string) => SonosDevice | undefined } }).sonosDiscovery = {
      get: (id: string) => (id === FAKE_DEVICE.id ? FAKE_DEVICE : undefined),
    };
    (app as unknown as {
      sonosControl: {
        setAvTransportUri: (d: SonosDevice, u: string, m: TrackMetadata) => Promise<void>;
        setNextAvTransportUri: (
          d: SonosDevice,
          u: string,
          m: TrackMetadata | null,
        ) => Promise<void>;
        play: (d: SonosDevice) => Promise<void>;
        seek: (d: SonosDevice, p: number) => Promise<void>;
        getVolume: (d: SonosDevice) => Promise<number>;
        setVolume: (d: SonosDevice, l: number) => Promise<void>;
        getState: (d: SonosDevice) => Promise<{ state: string; position: number; duration: number; trackUri: string }>;
      };
    }).sonosControl = {
      setAvTransportUri: async (device, uri, meta) => {
        setUriCalls.push({ device, uri, meta });
      },
      setNextAvTransportUri: async (device, uri, meta) => {
        setNextUriCalls.push({ device, uri, meta });
      },
      play: async (device) => {
        playCalls.push(device);
      },
      seek: async (device, position) => {
        seekCalls.push({ device, position });
      },
      getVolume: async () => currentVolume,
      setVolume: async (device, level) => {
        setVolumeCalls.push({ device, level });
      },
      getState: async () => ({ state: "STOPPED", position: 0, duration: 0, trackUri: "" }),
    };
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  // Override the discovery stub with a device that advertises the given
  // Sonos sink MIMEs. Used by every cast test that needs a non-empty
  // `supportedMimes` (otherwise chooseSonosCastFormat falls back to MP3).
  function stubDeviceWithMimes(mimes: string[]) {
    (app as unknown as {
      sonosDiscovery: { get: (id: string) => SonosDevice | undefined };
    }).sonosDiscovery = {
      get: (id) =>
        id === FAKE_DEVICE.id
          ? { ...FAKE_DEVICE, supportedMimes: new Set(mimes) }
          : undefined,
    };
  }

  // #199: override discovery with a specific model + sink MIMEs. Used by the
  // hi-res capability gate tests to drive different Sonos lines (S2 / S1).
  function stubDeviceModel(model: string, mimes: string[]) {
    (app as unknown as {
      sonosDiscovery: { get: (id: string) => SonosDevice | undefined };
    }).sonosDiscovery = {
      get: (id) =>
        id === FAKE_DEVICE.id
          ? { ...FAKE_DEVICE, model, supportedMimes: new Set(mimes) }
          : undefined,
    };
  }

  async function authedPost(url: string, body: unknown) {
    const token = await createAccessToken(userId, app.config);
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
    expect(res.json()).toEqual({ ok: true, transcoded: true });
    expect(setUriCalls).toHaveLength(1);

    const call = setUriCalls[0]!;
    // Stream URL must force format=mp3 so the byte stream matches the
    // audio/mpeg DIDL mime type (regression: PR #162 mismatch broke FLAC).
    expect(call.uri).toContain("format=mp3");
    // #218: stream URL targets Hub's Subsonic endpoint with cast-token auth.
    expect(call.uri).toContain("/rest/stream.view?");
    expect(call.uri).toContain("id=ttrk-1");
    expect(call.uri).toContain("castToken=");
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

  it("resolves t-prefixed Subsonic song id from the SPA", async () => {
    // The SPA stores SubsonicSong.id as returned by /rest/getAlbum, which
    // is `encodeId("t", unified_tracks.id)` — a "t" followed by the UUID.
    // This is the actual production path that PR #162 originally missed.
    const res = await authedPost(`/api/sonos/devices/${FAKE_DEVICE.id}/play`, {
      trackId: "ttrk-1",
    });
    expect(res.statusCode).toBe(200);
    expect(setUriCalls).toHaveLength(1);
    const call = setUriCalls[0]!;
    expect(call.uri).toContain("/rest/stream.view?id=ttrk-1");
    expect(call.uri).toContain("castToken=");
    expect(call.meta.trackId).toBe("trk-1");
    expect(call.meta.title).toBe("Dancing Queen");
  });

  it("returns 404 for a bare Navidrome remote_id (#220 dropped the fallback)", async () => {
    // Pre-#220 the play route also accepted bare Navidrome remote_ids by
    // joining instance_tracks → track_sources in-process. That fallback
    // was always dead defensive code — the SPA has only ever sent the
    // Subsonic `t<uuid>` form — and is removed now that Player code can
    // no longer touch app.db.
    const subsonicId = "7jwQomahCwKbSjrAxtelmw";
    seedSubsonicMapping(app, subsonicId);

    const res = await authedPost(`/api/sonos/devices/${FAKE_DEVICE.id}/play`, {
      trackId: subsonicId,
    });
    expect(res.statusCode).toBe(404);
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

  it("clamps device volume to the cap on cast start when above the cap", async () => {
    currentVolume = 80;
    const res = await authedPost(`/api/sonos/devices/${FAKE_DEVICE.id}/play`, {
      trackId: "trk-1",
    });
    expect(res.statusCode).toBe(200);
    expect(setVolumeCalls).toHaveLength(1);
    expect(setVolumeCalls[0]!.level).toBe(SONOS_VOLUME_CAP);
    expect(playCalls).toHaveLength(1);
  });

  it("leaves device volume alone on cast start when at or below the cap", async () => {
    currentVolume = 20;
    const res = await authedPost(`/api/sonos/devices/${FAKE_DEVICE.id}/play`, {
      trackId: "trk-1",
    });
    expect(res.statusCode).toBe(200);
    expect(setVolumeCalls).toHaveLength(0);
  });

  it("/state response includes volumeCap", async () => {
    const token = await createAccessToken(userId, app.config);
    const res = await app.inject({
      method: "GET",
      url: `/api/sonos/devices/${FAKE_DEVICE.id}/state`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ volume: 30, volumeCap: SONOS_VOLUME_CAP });
  });

  it("POST /volume accepts values above the cap (service-layer clamps)", async () => {
    const res = await authedPost(`/api/sonos/devices/${FAKE_DEVICE.id}/volume`, {
      level: 80,
    });
    expect(res.statusCode).toBe(200);
    // Route forwards the raw value; setVolume itself does the cap clamp.
    expect(setVolumeCalls).toHaveLength(1);
    expect(setVolumeCalls[0]!.level).toBe(80);
  });

  it("POST /volume forwards the live cap from settings to setVolume (#208)", async () => {
    // Operator just dropped the cap from the admin UI. A refactor that
    // silently stopped passing the cap argument would let above-cap
    // requests reach the device. Lock the wiring with a dedicated stub.
    app.sonosSettings.setVolumeCap(35);
    const capArgs: number[] = [];
    (app.sonosControl as unknown as {
      setVolume: (d: SonosDevice, l: number, c?: number) => Promise<void>;
    }).setVolume = async (_d, _l, c) => {
      capArgs.push(c as number);
    };
    const res = await authedPost(`/api/sonos/devices/${FAKE_DEVICE.id}/volume`, {
      level: 80,
    });
    expect(res.statusCode).toBe(200);
    expect(capArgs).toEqual([35]);
  });

  it("POST /volume still rejects out-of-protocol values (>100)", async () => {
    const res = await authedPost(`/api/sonos/devices/${FAKE_DEVICE.id}/volume`, {
      level: 150,
    });
    expect(res.statusCode).toBe(400);
  });

  it("passes FLAC through verbatim when the device sinks accept audio/flac (#180)", async () => {
    seedTrackSource(app, "flac", "ts-fmt", {
      samplingRate: 44100,
      bitDepth: 16,
      channelCount: 2,
    });
    stubDeviceWithMimes(["audio/mpeg", "audio/flac", "audio/mp4"]);
    const res = await authedPost(`/api/sonos/devices/${FAKE_DEVICE.id}/play`, {
      trackId: "trk-1",
    });
    expect(res.statusCode).toBe(200);
    const call = setUriCalls[0]!;
    expect(call.uri).not.toContain("format=mp3");
    expect(call.meta.mimeType).toBe("audio/flac");
  });

  // #199: hi-res capability gate. Sonos firmware silently STOPs FLAC that
  // exceeds the line's ceiling (S2: 24/48/2-ch, S1: 16/48/2-ch). Even when
  // protocolInfo accepts audio/flac, the cast must force MP3 transcode.
  it("transcodes 24/96 FLAC to MP3 on an S2 Sonos (over sample-rate ceiling, #199)", async () => {
    seedTrackSource(app, "flac", "ts-fmt", {
      samplingRate: 96000,
      bitDepth: 24,
      channelCount: 2,
    });
    stubDeviceModel("Sonos Era 100", ["audio/mpeg", "audio/flac", "audio/mp4"]);
    const res = await authedPost(`/api/sonos/devices/${FAKE_DEVICE.id}/play`, {
      trackId: "trk-1",
    });
    expect(res.statusCode).toBe(200);
    const call = setUriCalls[0]!;
    expect(call.uri).toContain("format=mp3");
    expect(call.meta.mimeType).toBe("audio/mpeg");
  });

  it("transcodes 24/48 FLAC to MP3 on an S1 Sonos (over bit-depth ceiling, #199)", async () => {
    seedTrackSource(app, "flac", "ts-fmt", {
      samplingRate: 48000,
      bitDepth: 24,
      channelCount: 2,
    });
    stubDeviceModel("Sonos PLAY:1", ["audio/mpeg", "audio/flac"]);
    const res = await authedPost(`/api/sonos/devices/${FAKE_DEVICE.id}/play`, {
      trackId: "trk-1",
    });
    expect(res.statusCode).toBe(200);
    const call = setUriCalls[0]!;
    expect(call.uri).toContain("format=mp3");
    expect(call.meta.mimeType).toBe("audio/mpeg");
  });

  it("passes 16/44.1 FLAC through on an S2 Sonos — gate doesn't over-trigger (#199)", async () => {
    seedTrackSource(app, "flac", "ts-fmt", {
      samplingRate: 44100,
      bitDepth: 16,
      channelCount: 2,
    });
    stubDeviceModel("Sonos Era 100", ["audio/mpeg", "audio/flac", "audio/mp4"]);
    const res = await authedPost(`/api/sonos/devices/${FAKE_DEVICE.id}/play`, {
      trackId: "trk-1",
    });
    expect(res.statusCode).toBe(200);
    const call = setUriCalls[0]!;
    expect(call.uri).not.toContain("format=mp3");
    expect(call.meta.mimeType).toBe("audio/flac");
  });

  it("transcodes multi-channel FLAC to MP3 on every Sonos line (#199)", async () => {
    seedTrackSource(app, "flac", "ts-fmt", {
      samplingRate: 48000,
      bitDepth: 16,
      channelCount: 6,
    });
    stubDeviceModel("Sonos Era 100", ["audio/mpeg", "audio/flac", "audio/mp4"]);
    const res = await authedPost(`/api/sonos/devices/${FAKE_DEVICE.id}/play`, {
      trackId: "trk-1",
    });
    expect(res.statusCode).toBe(200);
    const call = setUriCalls[0]!;
    expect(call.uri).toContain("format=mp3");
    expect(call.meta.mimeType).toBe("audio/mpeg");
  });

  it("transcodes OGG sources to MP3 (no native Sonos support)", async () => {
    seedTrackSource(app, "ogg");
    stubDeviceWithMimes(["audio/mpeg", "audio/flac"]);
    const res = await authedPost(`/api/sonos/devices/${FAKE_DEVICE.id}/play`, {
      trackId: "trk-1",
    });
    expect(res.statusCode).toBe(200);
    const call = setUriCalls[0]!;
    expect(call.uri).toContain("format=mp3");
    expect(call.meta.mimeType).toBe("audio/mpeg");
  });

  it("transcodes FLAC when the device's capability probe hasn't completed", async () => {
    seedTrackSource(app, "flac");
    // FAKE_DEVICE has no supportedMimes — simulates the brief window
    // before discovery has called GetProtocolInfo. Safe default: MP3.
    const res = await authedPost(`/api/sonos/devices/${FAKE_DEVICE.id}/play`, {
      trackId: "trk-1",
    });
    expect(res.statusCode).toBe(200);
    const call = setUriCalls[0]!;
    expect(call.uri).toContain("format=mp3");
    expect(call.meta.mimeType).toBe("audio/mpeg");
  });

  it("passes MP3 sources through without re-transcoding", async () => {
    // bitDepth=0 is Navidrome's signal for lossy formats; sample rate is
    // still required for the #199 fail-safe gate to allow pass-through.
    seedTrackSource(app, "mp3", "ts-fmt", {
      samplingRate: 44100,
      bitDepth: 0,
      channelCount: 2,
    });
    stubDeviceWithMimes(["audio/mpeg", "audio/flac"]);
    const res = await authedPost(`/api/sonos/devices/${FAKE_DEVICE.id}/play`, {
      trackId: "trk-1",
    });
    expect(res.statusCode).toBe(200);
    const call = setUriCalls[0]!;
    expect(call.uri).not.toContain("format=mp3");
    expect(call.meta.mimeType).toBe("audio/mpeg");
  });

  it("pass-through resume seeks via SOAP after Play, not via timeOffset (#204)", async () => {
    // Local→Sonos mid-track switch on a pass-through source: Subsonic
    // ignores `timeOffset` on raw streams, so the position has to be
    // applied with a SOAP Seek once the device has loaded the URI.
    seedTrackSource(app, "mp3", "ts-fmt", {
      samplingRate: 44100,
      bitDepth: 0,
      channelCount: 2,
    });
    stubDeviceWithMimes(["audio/mpeg", "audio/flac"]);
    const res = await authedPost(`/api/sonos/devices/${FAKE_DEVICE.id}/play`, {
      trackId: "trk-1",
      position: 42,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, transcoded: false });
    const call = setUriCalls[0]!;
    expect(call.uri).not.toContain("timeOffset");
    expect(seekCalls).toEqual([
      { device: expect.anything(), position: 42 },
    ]);
  });

  it("transcoded resume keeps timeOffset and skips SOAP Seek (#182/#204)", async () => {
    // OGG → MP3 transcode path: stream is Range-less, so the start
    // offset must ride the cast URL, not a post-load Seek.
    seedTrackSource(app, "ogg");
    stubDeviceWithMimes(["audio/mpeg", "audio/flac"]);
    const res = await authedPost(`/api/sonos/devices/${FAKE_DEVICE.id}/play`, {
      trackId: "trk-1",
      position: 42,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, transcoded: true });
    const call = setUriCalls[0]!;
    expect(call.uri).toContain("timeOffset=42");
    expect(seekCalls).toHaveLength(0);
  });

  it("forces MP3 when audio metadata is missing — fail-safe default (#199)", async () => {
    // Pre-#199 track_sources rows and peer tracks not yet re-synced have
    // null sampling_rate / bit_depth / channel_count. Without all three we
    // can't prove the source fits the line's ceiling, so transcode rather
    // than risk a silent STOPPED on a hi-res track.
    seedTrackSource(app, "flac");
    stubDeviceWithMimes(["audio/mpeg", "audio/flac"]);
    const res = await authedPost(`/api/sonos/devices/${FAKE_DEVICE.id}/play`, {
      trackId: "trk-1",
    });
    expect(res.statusCode).toBe(200);
    const call = setUriCalls[0]!;
    expect(call.uri).toContain("format=mp3");
    expect(call.meta.mimeType).toBe("audio/mpeg");
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

  it("returns 503 (not 401) for unauthenticated requests when Sonos is disabled (#208)", async () => {
    // The disabled-Sonos preHandler is registered before requireAuth so
    // unauthenticated probes see the "not available" signal rather than
    // an auth challenge. Pin the hook ordering with a test.
    app.sonosSettings.setEnabled(false);
    const res = await app.inject({
      method: "GET",
      url: `/api/sonos/devices`,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "Sonos is disabled" });
  });

  describe("POST /next — gapless pre-load (#202)", () => {
    it("pre-loads the next track via SetNextAVTransportURI without issuing Play", async () => {
      const res = await authedPost(
        `/api/sonos/devices/${FAKE_DEVICE.id}/next`,
        { trackId: "trk-1", ttlSec: 600 },
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(setNextUriCalls).toHaveLength(1);
      expect(setNextUriCalls[0]!.uri).toContain("/rest/stream.view?id=ttrk-1");
      expect(setNextUriCalls[0]!.uri).toContain("castToken=");
      expect(setNextUriCalls[0]!.meta?.title).toBe("Dancing Queen");
      // Must NOT touch transport state or play — only pre-buffer.
      expect(setUriCalls).toHaveLength(0);
      expect(playCalls).toHaveLength(0);
    });

    it("clears the slot when trackId is null", async () => {
      const res = await authedPost(
        `/api/sonos/devices/${FAKE_DEVICE.id}/next`,
        { trackId: null },
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, cleared: true });
      expect(setNextUriCalls).toHaveLength(1);
      expect(setNextUriCalls[0]!.uri).toBe("");
      expect(setNextUriCalls[0]!.meta).toBeNull();
    });

    it("returns 404 for unknown track", async () => {
      const res = await authedPost(
        `/api/sonos/devices/${FAKE_DEVICE.id}/next`,
        { trackId: "no-such-track" },
      );
      expect(res.statusCode).toBe(404);
      expect(setNextUriCalls).toHaveLength(0);
    });

    it("returns 404 for unknown device", async () => {
      const res = await authedPost(`/api/sonos/devices/UNKNOWN/next`, {
        trackId: "trk-1",
      });
      expect(res.statusCode).toBe(404);
    });

    it("rejects unauthenticated requests", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/sonos/devices/${FAKE_DEVICE.id}/next`,
        headers: { "content-type": "application/json" },
        payload: { trackId: "trk-1" },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
