import { sendSubsonicOk, encodeId } from "../subsonic-response.js";
import { normalizeName } from "../../library/normalize.js";
import type { ArtistRow, ReleaseGroupRow, TrackRow, SubsonicRouteContext } from "./types.js";
import { buildSong, annotateStarred, annotatePlays, buildAlbum } from "./builders.js";

export function registerSearch(ctx: SubsonicRouteContext): void {
  const { app, queries, route } = ctx;

  // ── search3 ─────────────────────────────────────────────────────────────────

  route("/search3", async (request, reply) => {
    const q = request.query as Record<string, string>;
    const query = q.query ?? "";
    const artistCount = parseInt(q.artistCount ?? "20", 10);
    const albumCount = parseInt(q.albumCount ?? "20", 10);
    const songCount = parseInt(q.songCount ?? "20", 10);
    const artistOffset = parseInt(q.artistOffset ?? "0", 10);
    const albumOffset = parseInt(q.albumOffset ?? "0", 10);
    const songOffset = parseInt(q.songOffset ?? "0", 10);
    const like = `%${normalizeName(query)}%`;

    // ID lookup: allow pasting an internal ID (optionally prefixed ar/al/t)
    // or a MusicBrainz ID into the search box. Strip known prefixes so the
    // bare UUID matches id/musicbrainz_id columns directly.
    const trimmed = query.trim();
    const artistIdCandidate = trimmed.startsWith("ar") ? trimmed.slice(2) : trimmed;
    const albumIdCandidate = trimmed.startsWith("al") ? trimmed.slice(2) : trimmed;
    const songIdCandidate = trimmed.startsWith("t") ? trimmed.slice(1) : trimmed;

    const artists = queries.searchArtists.all(
      like,
      trimmed,
      artistIdCandidate,
      trimmed,
      artistIdCandidate,
      trimmed,
      artistCount,
      artistOffset,
    ) as ArtistRow[];

    const albums = queries.searchAlbums.all(
      like,
      trimmed,
      albumIdCandidate,
      trimmed,
      albumIdCandidate,
      trimmed,
      albumCount,
      albumOffset,
    ) as ReleaseGroupRow[];

    const songs = queries.searchSongs.all(
      like,
      trimmed,
      songIdCandidate,
      trimmed,
      songIdCandidate,
      trimmed,
      songCount,
      songOffset,
    ) as TrackRow[];

    const builtArtists = artists.map((a) => ({
      id: encodeId("ar", a.id),
      name: a.name,
      albumCount: a.albumCount,
      coverArt: a.image_url ?? undefined,
    }));
    const builtAlbums = albums.map(buildAlbum);
    const builtSongs = songs.map(buildSong);
    annotateStarred(app.db, request.subsonicUser?.id, "artist", "ar", builtArtists);
    annotateStarred(app.db, request.subsonicUser?.id, "album", "al", builtAlbums);
    annotateStarred(app.db, request.subsonicUser?.id, "track", "t", builtSongs);
    annotatePlays(app.playEvents, request.subsonicUser?.id, "album", "al", builtAlbums);
    annotatePlays(app.playEvents, request.subsonicUser?.id, "track", "t", builtSongs);
    sendSubsonicOk(reply, q, {
      searchResult3: {
        artist: builtArtists,
        album: builtAlbums,
        song: builtSongs,
      },
    });
  });
}
