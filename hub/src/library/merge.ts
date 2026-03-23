import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { normalizeName } from "./normalize.js";

/**
 * Run the full merge pipeline: take all instance_* data and produce unified_* tables.
 * For v1, we clear and rebuild all unified tables each time (simpler than diffing).
 * The entire operation is wrapped in a transaction.
 */
export function mergeLibraries(db: Database.Database): void {
  const transaction = db.transaction(() => {
    // Clear unified tables (order matters due to foreign keys)
    db.exec("DELETE FROM track_sources");
    db.exec("DELETE FROM unified_tracks");
    db.exec("DELETE FROM unified_release_sources");
    db.exec("DELETE FROM unified_releases");
    db.exec("DELETE FROM unified_release_groups");
    db.exec("DELETE FROM unified_artist_sources");
    db.exec("DELETE FROM unified_artists");

    // ── Step 1: Merge Artists ──────────────────────────────────────────────

    const instanceArtists = db
      .prepare("SELECT * FROM instance_artists")
      .all() as Array<Record<string, unknown>>;

    // Group by MBID first, then by normalized name
    const artistByMbid = new Map<string, Array<Record<string, unknown>>>();
    const artistByNorm = new Map<string, Array<Record<string, unknown>>>();

    for (const ia of instanceArtists) {
      const mbid = ia.musicbrainz_id as string | null;
      if (mbid) {
        const group = artistByMbid.get(mbid) ?? [];
        group.push(ia);
        artistByMbid.set(mbid, group);
      } else {
        const norm = normalizeName(ia.name as string);
        const group = artistByNorm.get(norm) ?? [];
        group.push(ia);
        artistByNorm.set(norm, group);
      }
    }

    // Merge MBID-matched artists with normalized name groups if they share a normalized name
    // First, create unified artists from MBID groups
    const insertUnifiedArtist = db.prepare(`
      INSERT INTO unified_artists (id, name, name_normalized, musicbrainz_id, image_url)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertArtistSource = db.prepare(`
      INSERT INTO unified_artist_sources (unified_artist_id, instance_artist_id, instance_id)
      VALUES (?, ?, ?)
    `);

    // Map from instance_artist id -> unified_artist id
    const instanceArtistToUnified = new Map<string, string>();

    for (const [mbid, group] of artistByMbid) {
      const id = crypto.randomUUID();
      const representative = group[0];
      const name = representative.name as string;
      const nameNormalized = normalizeName(name);

      insertUnifiedArtist.run(
        id,
        name,
        nameNormalized,
        mbid,
        representative.image_url as string | null,
      );

      for (const ia of group) {
        insertArtistSource.run(id, ia.id as string, ia.instance_id as string);
        instanceArtistToUnified.set(ia.id as string, id);
      }

      // Also absorb any non-MBID artists with same normalized name
      const normGroup = artistByNorm.get(nameNormalized);
      if (normGroup) {
        for (const ia of normGroup) {
          insertArtistSource.run(id, ia.id as string, ia.instance_id as string);
          instanceArtistToUnified.set(ia.id as string, id);
        }
        artistByNorm.delete(nameNormalized);
      }
    }

    // Create unified artists for remaining name-only groups
    for (const [norm, group] of artistByNorm) {
      const id = crypto.randomUUID();
      const representative = group[0];

      insertUnifiedArtist.run(
        id,
        representative.name as string,
        norm,
        null,
        representative.image_url as string | null,
      );

      for (const ia of group) {
        insertArtistSource.run(id, ia.id as string, ia.instance_id as string);
        instanceArtistToUnified.set(ia.id as string, id);
      }
    }

    // ── Step 2: Merge Release Groups ────────────────────────────────────────

    const instanceAlbums = db
      .prepare("SELECT * FROM instance_albums")
      .all() as Array<Record<string, unknown>>;

    const insertReleaseGroup = db.prepare(`
      INSERT INTO unified_release_groups (id, name, name_normalized, artist_id, musicbrainz_id, year, genre, image_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Group by release_group_mbid, else by (unified_artist_id + normalized album name)
    const rgByMbid = new Map<string, Array<Record<string, unknown>>>();
    const rgByKey = new Map<string, Array<Record<string, unknown>>>();

    for (const ia of instanceAlbums) {
      const rgMbid = ia.release_group_mbid as string | null;
      if (rgMbid) {
        const group = rgByMbid.get(rgMbid) ?? [];
        group.push(ia);
        rgByMbid.set(rgMbid, group);
      } else {
        const unifiedArtistId = instanceArtistToUnified.get(ia.artist_id as string) ?? "unknown";
        const normName = normalizeName(ia.name as string);
        const key = `${unifiedArtistId}::${normName}`;
        const group = rgByKey.get(key) ?? [];
        group.push(ia);
        rgByKey.set(key, group);
      }
    }

    // Map from instance_album id -> release_group_id
    const instanceAlbumToReleaseGroup = new Map<string, string>();
    // Map from instance_album -> unified_artist_id
    const instanceAlbumToArtist = new Map<string, string>();

    for (const [mbid, group] of rgByMbid) {
      const id = crypto.randomUUID();
      const representative = group[0];
      const name = representative.name as string;
      const unifiedArtistId = instanceArtistToUnified.get(representative.artist_id as string) ?? "unknown";

      // Encode cover art ID as instanceId:coverArtId for the /api/art/:id endpoint
      const coverArtId = representative.cover_art_id as string | null;
      const encodedArt = coverArtId
        ? `${representative.instance_id as string}:${coverArtId}`
        : null;

      insertReleaseGroup.run(
        id,
        name,
        normalizeName(name),
        unifiedArtistId,
        mbid,
        representative.year as number | null,
        representative.genre as string | null,
        encodedArt,
      );

      for (const ia of group) {
        instanceAlbumToReleaseGroup.set(ia.id as string, id);
        instanceAlbumToArtist.set(ia.id as string, instanceArtistToUnified.get(ia.artist_id as string) ?? unifiedArtistId);
      }

      // Also absorb non-MBID albums with same artist+name key
      const normName = normalizeName(name);
      const keyToCheck = `${unifiedArtistId}::${normName}`;
      const normGroup = rgByKey.get(keyToCheck);
      if (normGroup) {
        for (const ia of normGroup) {
          instanceAlbumToReleaseGroup.set(ia.id as string, id);
          instanceAlbumToArtist.set(ia.id as string, instanceArtistToUnified.get(ia.artist_id as string) ?? unifiedArtistId);
        }
        rgByKey.delete(keyToCheck);
      }
    }

    for (const [, group] of rgByKey) {
      const id = crypto.randomUUID();
      const representative = group[0];
      const name = representative.name as string;
      const unifiedArtistId = instanceArtistToUnified.get(representative.artist_id as string) ?? "unknown";

      const coverArtId2 = representative.cover_art_id as string | null;
      const encodedArt2 = coverArtId2
        ? `${representative.instance_id as string}:${coverArtId2}`
        : null;

      insertReleaseGroup.run(
        id,
        name,
        normalizeName(name),
        unifiedArtistId,
        null,
        representative.year as number | null,
        representative.genre as string | null,
        encodedArt2,
      );

      for (const ia of group) {
        instanceAlbumToReleaseGroup.set(ia.id as string, id);
        instanceAlbumToArtist.set(ia.id as string, instanceArtistToUnified.get(ia.artist_id as string) ?? unifiedArtistId);
      }
    }

    // ── Step 3: Merge Releases ──────────────────────────────────────────────

    const insertRelease = db.prepare(`
      INSERT INTO unified_releases (id, release_group_id, name, musicbrainz_id, edition, track_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertReleaseSource = db.prepare(`
      INSERT INTO unified_release_sources (unified_release_id, instance_album_id, instance_id)
      VALUES (?, ?, ?)
    `);

    // Within each release group, group albums by release MBID, else by track_count
    // Map from instance_album id -> unified_release id
    const instanceAlbumToRelease = new Map<string, string>();

    // Group instance_albums by release_group
    const albumsByRG = new Map<string, Array<Record<string, unknown>>>();
    for (const ia of instanceAlbums) {
      const rgId = instanceAlbumToReleaseGroup.get(ia.id as string);
      if (!rgId) continue;
      const group = albumsByRG.get(rgId) ?? [];
      group.push(ia);
      albumsByRG.set(rgId, group);
    }

    for (const [rgId, albums] of albumsByRG) {
      // Group by release MBID first
      const byMbid = new Map<string, Array<Record<string, unknown>>>();
      const byTrackCount = new Map<number, Array<Record<string, unknown>>>();

      for (const album of albums) {
        const mbid = album.musicbrainz_id as string | null;
        if (mbid) {
          const group = byMbid.get(mbid) ?? [];
          group.push(album);
          byMbid.set(mbid, group);
        } else {
          const tc = (album.track_count as number) ?? 0;
          const group = byTrackCount.get(tc) ?? [];
          group.push(album);
          byTrackCount.set(tc, group);
        }
      }

      for (const [mbid, group] of byMbid) {
        const id = crypto.randomUUID();
        const rep = group[0];
        insertRelease.run(
          id,
          rgId,
          rep.name as string,
          mbid,
          null,
          rep.track_count as number ?? 0,
        );
        for (const album of group) {
          insertReleaseSource.run(id, album.id as string, album.instance_id as string);
          instanceAlbumToRelease.set(album.id as string, id);
        }

        // Absorb non-MBID albums with same track count
        const tc = (rep.track_count as number) ?? 0;
        const tcGroup = byTrackCount.get(tc);
        if (tcGroup) {
          for (const album of tcGroup) {
            insertReleaseSource.run(id, album.id as string, album.instance_id as string);
            instanceAlbumToRelease.set(album.id as string, id);
          }
          byTrackCount.delete(tc);
        }
      }

      for (const [, group] of byTrackCount) {
        const id = crypto.randomUUID();
        const rep = group[0];
        insertRelease.run(
          id,
          rgId,
          rep.name as string,
          null,
          null,
          rep.track_count as number ?? 0,
        );
        for (const album of group) {
          insertReleaseSource.run(id, album.id as string, album.instance_id as string);
          instanceAlbumToRelease.set(album.id as string, id);
        }
      }
    }

    // ── Step 4: Merge Tracks ────────────────────────────────────────────────

    const instanceTracks = db
      .prepare("SELECT * FROM instance_tracks")
      .all() as Array<Record<string, unknown>>;

    const insertTrack = db.prepare(`
      INSERT INTO unified_tracks (id, title, title_normalized, release_id, artist_id, musicbrainz_id, track_number, disc_number, duration_ms, genre)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTrackSource = db.prepare(`
      INSERT INTO track_sources (id, unified_track_id, instance_id, instance_track_id, remote_id, format, bitrate, size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Group tracks by release
    const tracksByRelease = new Map<string, Array<Record<string, unknown>>>();
    for (const it of instanceTracks) {
      const releaseId = instanceAlbumToRelease.get(it.album_id as string);
      if (!releaseId) continue;
      const group = tracksByRelease.get(releaseId) ?? [];
      group.push(it);
      tracksByRelease.set(releaseId, group);
    }

    for (const [releaseId, tracks] of tracksByRelease) {
      // Group by recording MBID first, then by fuzzy match
      const byMbid = new Map<string, Array<Record<string, unknown>>>();
      const remaining: Array<Record<string, unknown>> = [];

      for (const track of tracks) {
        const mbid = track.musicbrainz_id as string | null;
        if (mbid) {
          const group = byMbid.get(mbid) ?? [];
          group.push(track);
          byMbid.set(mbid, group);
        } else {
          remaining.push(track);
        }
      }

      // Create unified tracks from MBID groups
      const createdTracks: Array<{
        unifiedId: string;
        titleNorm: string;
        trackNumber: number | null;
        durationMs: number | null;
      }> = [];

      for (const [mbid, group] of byMbid) {
        const id = crypto.randomUUID();
        const rep = group[0];
        const artistId = instanceAlbumToArtist.get(rep.album_id as string) ?? "unknown";
        const titleNorm = normalizeName(rep.title as string);

        insertTrack.run(
          id,
          rep.title as string,
          titleNorm,
          releaseId,
          artistId,
          mbid,
          rep.track_number as number | null,
          rep.disc_number as number | null,
          rep.duration_ms as number | null,
          rep.genre as string | null,
        );

        for (const track of group) {
          insertTrackSource.run(
            crypto.randomUUID(),
            id,
            track.instance_id as string,
            track.id as string,
            track.remote_id as string,
            track.format as string | null,
            track.bitrate as number | null,
            track.size as number | null,
          );
        }

        createdTracks.push({
          unifiedId: id,
          titleNorm,
          trackNumber: rep.track_number as number | null,
          durationMs: rep.duration_ms as number | null,
        });
      }

      // Match remaining tracks by fuzzy criteria
      for (const track of remaining) {
        const titleNorm = normalizeName(track.title as string);
        const trackNumber = track.track_number as number | null;
        const durationMs = track.duration_ms as number | null;

        // Try to find a matching already-created unified track
        let matched = false;
        for (const existing of createdTracks) {
          if (
            existing.titleNorm === titleNorm &&
            existing.trackNumber === trackNumber &&
            durationWithinTolerance(existing.durationMs, durationMs, 3000)
          ) {
            // Add as additional source
            insertTrackSource.run(
              crypto.randomUUID(),
              existing.unifiedId,
              track.instance_id as string,
              track.id as string,
              track.remote_id as string,
              track.format as string | null,
              track.bitrate as number | null,
              track.size as number | null,
            );
            matched = true;
            break;
          }
        }

        if (!matched) {
          // Create a new unified track
          const id = crypto.randomUUID();
          const artistId = instanceAlbumToArtist.get(track.album_id as string) ?? "unknown";

          insertTrack.run(
            id,
            track.title as string,
            titleNorm,
            releaseId,
            artistId,
            null,
            trackNumber,
            track.disc_number as number | null,
            durationMs,
            track.genre as string | null,
          );

          insertTrackSource.run(
            crypto.randomUUID(),
            id,
            track.instance_id as string,
            track.id as string,
            track.remote_id as string,
            track.format as string | null,
            track.bitrate as number | null,
            track.size as number | null,
          );

          createdTracks.push({
            unifiedId: id,
            titleNorm,
            trackNumber,
            durationMs,
          });
        }
      }
    }
  });

  transaction();
}

function durationWithinTolerance(
  a: number | null,
  b: number | null,
  toleranceMs: number,
): boolean {
  if (a === null || b === null) return a === null && b === null;
  return Math.abs(a - b) <= toleranceMs;
}
