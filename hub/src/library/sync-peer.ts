import type Database from "better-sqlite3";
import type { Peer } from "../federation/peers.js";
import type { createFederationFetcher } from "../federation/sign-request.js";
import type { SyncResult } from "./sync.js";

export type FederationFetcher = ReturnType<typeof createFederationFetcher>;

// ── Federation export types ───────────────────────────────────────────────────

interface ExportArtist {
  id: string;
  name: string;
  musicbrainzId: string | null;
  imageUrl: string | null;
}

interface ExportReleaseGroup {
  id: string;
  name: string;
  artistId: string;
  musicbrainzId: string | null;
  year: number | null;
  genre: string | null;
  coverArtId: string | null; // raw cover art id (no peer prefix)
}

interface ExportRelease {
  id: string;
  releaseGroupId: string;
  name: string;
  musicbrainzId: string | null;
  edition: string | null;
  trackCount: number;
}

interface ExportTrack {
  id: string;
  releaseId: string;
  artistId: string;
  title: string;
  musicbrainzId: string | null;
  trackNumber: number | null;
  discNumber: number | null;
  durationMs: number | null;
  genre: string | null;
  sources: Array<{
    remoteId: string;
    format: string | null;
    bitrate: number | null;
    size: number | null;
  }>;
}

interface ExportPage {
  instanceId: string;
  page: { limit: number; offset: number; total: number };
  artists: ExportArtist[];
  releaseGroups: ExportReleaseGroup[];
  releases: ExportRelease[];
  tracks: ExportTrack[];
}

// ── Sync ──────────────────────────────────────────────────────────────────────

export async function syncPeer(
  db: Database.Database,
  peer: Peer,
  federatedFetch: FederationFetcher,
  asUser: string,
): Promise<SyncResult> {
  const result: SyncResult = {
    instanceId: peer.id,
    artistCount: 0,
    albumCount: 0,
    trackCount: 0,
    errors: [],
  };

  const upsertArtist = db.prepare(`
    INSERT INTO instance_artists (id, instance_id, remote_id, name, musicbrainz_id, album_count, image_url)
    VALUES (?, ?, ?, ?, ?, 0, NULL)
    ON CONFLICT(instance_id, remote_id) DO UPDATE SET
      name = excluded.name,
      musicbrainz_id = excluded.musicbrainz_id
  `);

  const upsertAlbum = db.prepare(`
    INSERT INTO instance_albums (id, instance_id, remote_id, name, artist_id, artist_name, year, genre, musicbrainz_id, release_group_mbid, track_count, duration_ms, cover_art_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
    ON CONFLICT(instance_id, remote_id) DO UPDATE SET
      name = excluded.name,
      artist_id = excluded.artist_id,
      artist_name = excluded.artist_name,
      year = excluded.year,
      genre = excluded.genre,
      musicbrainz_id = excluded.musicbrainz_id,
      release_group_mbid = excluded.release_group_mbid,
      track_count = excluded.track_count,
      cover_art_id = excluded.cover_art_id
  `);

  const upsertTrack = db.prepare(`
    INSERT INTO instance_tracks (id, instance_id, remote_id, album_id, title, artist_name, track_number, disc_number, duration_ms, bitrate, format, size, musicbrainz_id, year, genre)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(instance_id, remote_id) DO UPDATE SET
      album_id = excluded.album_id,
      title = excluded.title,
      artist_name = excluded.artist_name,
      track_number = excluded.track_number,
      disc_number = excluded.disc_number,
      duration_ms = excluded.duration_ms,
      bitrate = excluded.bitrate,
      format = excluded.format,
      size = excluded.size,
      musicbrainz_id = excluded.musicbrainz_id,
      genre = excluded.genre
  `);

  const limit = 500;
  let offset = 0;

  while (true) {
    let page: ExportPage;
    try {
      const response = await federatedFetch(
        peer,
        `/federation/library/export?limit=${limit}&offset=${offset}`,
        { asUser },
      );
      if (!response.ok) {
        result.errors.push(
          `HTTP ${response.status} from peer ${peer.id} at offset ${offset}`,
        );
        break;
      }
      page = (await response.json()) as ExportPage;
    } catch (err) {
      result.errors.push(`Failed to fetch from peer ${peer.id}: ${String(err)}`);
      break;
    }

    // Build lookup maps for this page
    const artistNameMap = new Map<string, string>(
      page.artists.map((a) => [a.id, a.name]),
    );
    const releaseToRgMap = new Map<string, string>(
      page.releases.map((r) => [r.id, r.releaseGroupId]),
    );

    // Upsert artists
    for (const artist of page.artists) {
      upsertArtist.run(
        `${peer.id}:${artist.id}`,
        peer.id,
        artist.id,
        artist.name,
        artist.musicbrainzId ?? null,
      );
      result.artistCount++;
    }

    // Upsert release groups as instance_albums
    for (const rg of page.releaseGroups) {
      const artistName = artistNameMap.get(rg.artistId) ?? "";
      const trackCount = page.tracks.filter(
        (t) => releaseToRgMap.get(t.releaseId) === rg.id,
      ).length;

      upsertAlbum.run(
        `${peer.id}:${rg.id}`,
        peer.id,
        rg.id,
        rg.name,
        `${peer.id}:${rg.artistId}`,
        artistName,
        rg.year ?? null,
        rg.genre ?? null,
        rg.musicbrainzId ?? null,
        rg.musicbrainzId ?? null, // use RG mbid as release_group_mbid too
        trackCount,
        rg.coverArtId ?? null, // raw cover art id, merge.ts will encode as peer.id:coverArtId
      );
      result.albumCount++;
    }

    // Upsert tracks
    for (const track of page.tracks) {
      const rgId = releaseToRgMap.get(track.releaseId);
      if (!rgId) continue; // skip if release-to-RG mapping not available

      const source = track.sources[0]; // take the best source (first = highest bitrate from export)
      const artistName = artistNameMap.get(track.artistId) ?? "";

      upsertTrack.run(
        `${peer.id}:${track.id}`,
        peer.id,
        track.id, // peer's unified track ID, used as remote_id for federation /stream/:trackId
        `${peer.id}:${rgId}`,
        track.title,
        artistName,
        track.trackNumber ?? null,
        track.discNumber ?? null,
        track.durationMs ?? null,
        source?.bitrate ?? null,
        source?.format ?? null,
        source?.size ?? null,
        track.musicbrainzId ?? null,
        track.genre ?? null,
      );
      result.trackCount++;
    }

    // Stop paging when we've received fewer tracks than the limit
    if (page.tracks.length < limit) break;
    offset += limit;
  }

  return result;
}
