import { sendSubsonicOk, encodeId, decodeId } from "../subsonic-response.js";
import { sqliteToIso } from "../../util/time.js";
import type { ArtistRow, ReleaseGroupRow, TrackRow, SubsonicRouteContext } from "./types.js";
import { buildAlbum, buildSong, annotatePlays, annotateStarred } from "./builders.js";

type StarKind = "track" | "album" | "artist";

export function registerAnnotations(ctx: SubsonicRouteContext): void {
  const { app, queries, route } = ctx;

  // ── star / unstar / getStarred / getStarred2 (#104) ─────────────────────────
  //
  // Per-user favorites, stored in the `user_stars` table on this hub. Targets
  // are unified_*.id UUIDs; orphans (target gone after a sync) are dropped at
  // read time via JOIN. Stars are local to the hub the user logs into and are
  // not federated.

  const starInsertStmt = queries.starInsert;
  const starDeleteStmt = queries.starDelete;
  const starredArtistsStmt = queries.starredArtists;
  const starredAlbumsStmt = queries.starredAlbums;
  const starredSongsStmt = queries.starredSongs;
  const starInsertTx = app.db.transaction(
    (userId: string, rows: Array<{ kind: StarKind; raw: string }>) => {
      for (const r of rows) starInsertStmt.run(userId, r.kind, r.raw);
    },
  );
  const starDeleteTx = app.db.transaction(
    (userId: string, rows: Array<{ kind: StarKind; raw: string }>) => {
      for (const r of rows) starDeleteStmt.run(userId, r.kind, r.raw);
    },
  );

  function asArray(v: unknown): string[] {
    if (v == null) return [];
    return Array.isArray(v) ? (v as string[]) : [String(v)];
  }

  // Raw IDs are produced by `generateDeterministicId` (UUID v4 shape, all
  // lowercase hex). Anchoring the classifier on this shape rejects malformed
  // input (e.g. `id=tomato`) instead of silently inserting `omato` as a
  // track target. Bare-UUID forms (no prefix) on `albumId`/`artistId` are
  // also accepted, matching how some Subsonic clients send them.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  function classifyStarId(encoded: string): { kind: StarKind; raw: string } | null {
    // Order matters: "ar"/"al" both start with "a"; "t" is a one-char prefix.
    let kind: StarKind | null = null;
    let raw = "";
    if (encoded.startsWith("al")) {
      kind = "album";
      raw = encoded.slice(2);
    } else if (encoded.startsWith("ar")) {
      kind = "artist";
      raw = encoded.slice(2);
    } else if (encoded.startsWith("t")) {
      kind = "track";
      raw = encoded.slice(1);
    }
    if (!kind || !UUID_RE.test(raw)) return null;
    return { kind, raw };
  }

  function unwrapKindId(encoded: string, prefix: string): string | null {
    // Accept either the prefixed form (`al<uuid>`/`ar<uuid>`) or a bare UUID
    // — the second is what some legacy clients send for `albumId`/`artistId`.
    const raw = encoded.startsWith(prefix) ? encoded.slice(prefix.length) : encoded;
    return UUID_RE.test(raw) ? raw : null;
  }

  function collectStarTargets(
    q: Record<string, string | string[] | undefined>,
  ): Array<{ kind: StarKind; raw: string }> {
    const out: Array<{ kind: StarKind; raw: string }> = [];
    for (const id of asArray(q.id)) {
      const c = classifyStarId(id);
      if (c) out.push(c);
    }
    for (const id of asArray(q.albumId)) {
      const raw = unwrapKindId(id, "al");
      if (raw) out.push({ kind: "album", raw });
    }
    for (const id of asArray(q.artistId)) {
      const raw = unwrapKindId(id, "ar");
      if (raw) out.push({ kind: "artist", raw });
    }
    return out;
  }

  route("/star", async (request, reply) => {
    const q = request.query as Record<string, string | string[] | undefined>;
    const targets = collectStarTargets(q);
    starInsertTx(request.subsonicUser.id, targets);
    sendSubsonicOk(reply, q as Record<string, string>, {});
  });

  route("/unstar", async (request, reply) => {
    const q = request.query as Record<string, string | string[] | undefined>;
    const targets = collectStarTargets(q);
    starDeleteTx(request.subsonicUser.id, targets);
    sendSubsonicOk(reply, q as Record<string, string>, {});
  });

  function buildStarredEnvelope(userId: string) {
    const artists = starredArtistsStmt.all(userId) as Array<
      ArtistRow & { starred_at: string }
    >;
    const albums = starredAlbumsStmt.all(userId) as Array<
      ReleaseGroupRow & { starred_at: string }
    >;
    const songs = starredSongsStmt.all(userId) as Array<
      TrackRow & { starred_at: string }
    >;

    const album = albums.map((a) => ({
      ...buildAlbum(a),
      starred: sqliteToIso(a.starred_at),
    }));
    const song = songs.map((s) => ({
      ...buildSong(s),
      starred: sqliteToIso(s.starred_at),
    }));
    annotatePlays(app.playEvents, userId, "album", "al", album);
    annotatePlays(app.playEvents, userId, "track", "t", song);

    return {
      artist: artists.map((a) => ({
        id: encodeId("ar", a.id),
        name: a.name,
        albumCount: a.albumCount,
        coverArt: a.image_url ?? undefined,
        starred: sqliteToIso(a.starred_at),
      })),
      album,
      song,
    };
  }

  route("/getStarred2", async (request, reply) => {
    const q = request.query as Record<string, string>;
    const env = buildStarredEnvelope(request.subsonicUser.id);
    sendSubsonicOk(reply, q, { starred2: env });
  });

  route("/getStarred", async (request, reply) => {
    const q = request.query as Record<string, string>;
    const env = buildStarredEnvelope(request.subsonicUser.id);
    sendSubsonicOk(reply, q, { starred: env });
  });

  // ── Scrobble (#197) ───────────────────────────────────────────────────────
  // The single play-recording path. Every playback surface reports its own
  // play here: the SPA scrobbles for both local <audio> and Sonos-cast playback
  // (off the actual playback position), and 3rd-party Subsonic apps scrobble
  // too. `StreamTrackingService.finish()` records nothing — there is no
  // server-side play inference — so this endpoint is the only writer of
  // play_events. `submission=true` (the default) records a play; `false` is a
  // "now playing" notification and is not counted. Accepts one or many `id`;
  // unknown / malformed ids are skipped so a batch with one bad id still
  // records the rest (Subsonic leniency). Honors the optional `time` param
  // (epoch ms of when the play occurred) so offline/batching clients can
  // backfill; absent, the play is stamped now.
  //
  // `submission=false` is the now-playing notification (#237): it records
  // nothing durable, but updates the in-memory NowPlayingService entry for
  // this (user, client) so getNowPlaying and the admin Activity page can
  // surface live playback.
  route("/scrobble", async (request, reply) => {
    const q = request.query as Record<string, string | string[] | undefined>;
    // Case-insensitive like Java's Boolean.parseBoolean — py-sonic (and other
    // non-JS clients) send `submission=False` with a capital F.
    const submissionRaw = Array.isArray(q.submission) ? q.submission[0] : q.submission;
    const submission = submissionRaw == null || !/^(false|0)$/i.test(submissionRaw);
    // Subsonic `time` is epoch milliseconds; ignore a non-numeric value.
    const timeRaw = Array.isArray(q.time) ? q.time[0] : q.time;
    const playedAtMs =
      timeRaw != null && timeRaw !== "" && Number.isFinite(Number(timeRaw))
        ? Number(timeRaw)
        : null;

    if (submission) {
      const ids = (Array.isArray(q.id) ? q.id : q.id != null ? [q.id] : []).map(
        String,
      );
      for (const encoded of ids) {
        let trackId: string;
        try {
          trackId = decodeId(encoded, "t");
        } catch {
          continue; // not a track id — skip, don't fail the batch
        }
        // Only record plays of tracks this hub actually knows about; ignore
        // unknown ids so a stale/garbage id can't pollute the history.
        const track = queries.trackExists.get(trackId);
        if (!track) continue;
        // Attribute to the source we'd stream from (preferred source), local or
        // peer. Best-effort: a known track with no source row records as null.
        const src = queries.sourceForScrobble.get(trackId) as
          | { instance_id: string }
          | undefined;
        app.playEvents.record({
          userId: request.subsonicUser.id,
          unifiedTrackId: trackId,
          sourceInstanceId: src?.instance_id ?? null,
          clientName: typeof q.c === "string" ? q.c : null,
          playedAtMs,
        });
      }
    } else {
      // Now-playing ping. Clients send a single id here; a multi-id ping is
      // not meaningful ("now playing" is one track per player), so take the
      // first decodable, known track.
      const ids = (Array.isArray(q.id) ? q.id : q.id != null ? [q.id] : []).map(
        String,
      );
      for (const encoded of ids) {
        let trackId: string;
        try {
          trackId = decodeId(encoded, "t");
        } catch {
          continue;
        }
        const row = queries.trackForSong.get(trackId) as TrackRow | undefined;
        if (!row) continue;
        app.nowPlaying.record({
          userId: request.subsonicUser.id,
          username: request.subsonicUser.username,
          trackId,
          trackTitle: row.title,
          artistName: row.artist_name,
          clientName: typeof q.c === "string" ? q.c : null,
        });
        break;
      }
    }

    sendSubsonicOk(reply, q as Record<string, string>, {});
  });

  // ── getNowPlaying (#237) ──────────────────────────────────────────────────
  // Per-user by design (owner decision on #237): the caller sees only their
  // own active players, not other users' — unlike stock Subsonic, which is a
  // server-wide list. The admin Activity page gets the cross-user view via
  // /api/admin/hub/activity/active instead.
  route("/getNowPlaying", async (request, reply) => {
    const q = request.query as Record<string, string>;
    const userId = request.subsonicUser.id;
    const entries = app.nowPlaying.getForUser(userId);

    const built: Array<Record<string, unknown>> = [];
    for (const e of entries) {
      // Tracks can vanish between ping and read (sync remap) — drop those.
      const row = queries.trackForSong.get(e.trackId) as TrackRow | undefined;
      if (!row) continue;
      built.push({
        ...buildSong(row),
        username: e.username,
        minutesAgo: app.nowPlaying.minutesAgo(e),
        playerId: e.playerId,
        ...(e.clientName ? { playerName: e.clientName } : {}),
      });
    }
    annotateStarred(app.db, userId, "track", "t", built as Array<{ id: string }>);
    annotatePlays(app.playEvents, userId, "track", "t", built as Array<{ id: string }>);

    sendSubsonicOk(reply, q, { nowPlaying: { entry: built } });
  });
}
