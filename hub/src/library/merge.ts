import type Database from "better-sqlite3";
import { normalizeName } from "./normalize.js";
import {
  generateArtistId,
  generateReleaseGroupId,
  generateReleaseId,
  generateTrackId,
  generateTrackSourceId,
} from "./id-generator.js";

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
      const representative = group[0];
      const name = representative.name as string;
      const nameNormalized = normalizeName(name);
      const id = generateArtistId(nameNormalized, mbid);

      const artistCoverArtId = representative.image_url as string | null;
      // Check if this is a Last.fm URL or a cover art ID
      // Last.fm URLs start with https://
      let encodedArtistArt: string | null = null;
      if (artistCoverArtId) {
        if (artistCoverArtId.startsWith("https://")) {
          // It's a Last.fm URL, store directly
          encodedArtistArt = artistCoverArtId;
        } else {
          // It's a cover art ID, encode it
          encodedArtistArt = `${representative.instance_id as string}:${artistCoverArtId}`;
        }
      }

      try {
        insertUnifiedArtist.run(
          id,
          name,
          nameNormalized,
          mbid,
          encodedArtistArt,
        );
      } catch (err) {
        const existing = db
          .prepare("SELECT id, name, name_normalized, musicbrainz_id FROM unified_artists WHERE id = ?")
          .get(id);
        console.error("[merge] insertUnifiedArtist (mbid path) failed", {
          id, name, nameNormalized, mbid,
          groupSize: group.length,
          sourceInstanceIds: group.map(g => g.instance_id),
          sourceInstanceArtistIds: group.map(g => g.id),
          existingRow: existing,
        });
        throw err;
      }

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
      const representative = group[0];
      const id = generateArtistId(norm, null);

      const artistCoverArtId2 = representative.image_url as string | null;
      let encodedArtistArt2: string | null = null;
      if (artistCoverArtId2) {
        if (artistCoverArtId2.startsWith("https://")) {
          // It's a Last.fm URL, store directly
          encodedArtistArt2 = artistCoverArtId2;
        } else {
          // It's a cover art ID, encode it
          encodedArtistArt2 = `${representative.instance_id as string}:${artistCoverArtId2}`;
        }
      }

      try {
        insertUnifiedArtist.run(
          id,
          representative.name as string,
          norm,
          null,
          encodedArtistArt2,
        );
      } catch (err) {
        const existing = db
          .prepare("SELECT id, name, name_normalized, musicbrainz_id FROM unified_artists WHERE id = ?")
          .get(id);
        console.error("[merge] insertUnifiedArtist (name path) failed", {
          id, name: representative.name, norm,
          groupSize: group.length,
          sourceInstanceIds: group.map(g => g.instance_id),
          sourceInstanceArtistIds: group.map(g => g.id),
          existingRow: existing,
        });
        throw err;
      }

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
      const representative = group[0];
      const name = representative.name as string;
      const nameNormalized = normalizeName(name);
      const unifiedArtistId = instanceArtistToUnified.get(representative.artist_id as string) ?? "unknown";
      const id = generateReleaseGroupId(nameNormalized, unifiedArtistId, mbid);

      // Encode cover art ID as instanceId:coverArtId for the /api/art/:id endpoint
      const coverArtId = representative.cover_art_id as string | null;
      const encodedArt = coverArtId
        ? `${representative.instance_id as string}:${coverArtId}`
        : null;

      try {
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
      } catch (err) {
        const existing = db
          .prepare("SELECT id, name, artist_id, musicbrainz_id FROM unified_release_groups WHERE id = ?")
          .get(id);
        console.error("[merge] insertReleaseGroup (mbid path) failed", {
          id, name, nameNormalized, unifiedArtistId, mbid,
          groupSize: group.length,
          sourceInstanceIds: group.map(g => g.instance_id),
          sourceInstanceAlbumIds: group.map(g => g.id),
          sourceInstanceArtistIds: group.map(g => g.artist_id),
          existingRow: existing,
        });
        throw err;
      }

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
      const representative = group[0];
      const name = representative.name as string;
      const nameNormalized = normalizeName(name);
      const unifiedArtistId = instanceArtistToUnified.get(representative.artist_id as string) ?? "unknown";
      const id = generateReleaseGroupId(nameNormalized, unifiedArtistId, null);

      const coverArtId2 = representative.cover_art_id as string | null;
      const encodedArt2 = coverArtId2
        ? `${representative.instance_id as string}:${coverArtId2}`
        : null;

      try {
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
      } catch (err) {
        const existing = db
          .prepare("SELECT id, name, artist_id, musicbrainz_id FROM unified_release_groups WHERE id = ?")
          .get(id);
        console.error("[merge] insertReleaseGroup (name path) failed", {
          id, name, nameNormalized, unifiedArtistId,
          groupSize: group.length,
          sourceInstanceIds: group.map(g => g.instance_id),
          sourceInstanceAlbumIds: group.map(g => g.id),
          sourceInstanceArtistIds: group.map(g => g.artist_id),
          existingRow: existing,
        });
        throw err;
      }

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
        const rep = group[0];
        const nameNormalized = normalizeName(rep.name as string);
        const id = generateReleaseId(nameNormalized, rgId, mbid);
        try {
          insertRelease.run(
            id,
            rgId,
            rep.name as string,
            mbid,
            null,
            rep.track_count as number ?? 0,
          );
        } catch (err) {
          const existing = db
            .prepare("SELECT id, name, release_group_id, musicbrainz_id, track_count FROM unified_releases WHERE id = ?")
            .get(id);
          console.error("[merge] insertRelease (mbid path) failed", {
            id, rgId, name: rep.name, nameNormalized, mbid,
            trackCount: rep.track_count,
            groupSize: group.length,
            sourceInstanceIds: group.map(a => a.instance_id),
            sourceInstanceAlbumIds: group.map(a => a.id),
            sourceMbids: group.map(a => a.musicbrainz_id),
            sourceTrackCounts: group.map(a => a.track_count),
            existingRow: existing,
          });
          throw err;
        }
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
        const rep = group[0];
        const nameNormalized = normalizeName(rep.name as string);
        const id = generateReleaseId(nameNormalized, rgId, null, rep.track_count as number ?? 0);
        try {
          insertRelease.run(
            id,
            rgId,
            rep.name as string,
            null,
            null,
            rep.track_count as number ?? 0,
          );
        } catch (err) {
          const existing = db
            .prepare("SELECT id, name, release_group_id, musicbrainz_id, track_count FROM unified_releases WHERE id = ?")
            .get(id);
          console.error("[merge] insertRelease (name path) failed", {
            id, rgId, name: rep.name, nameNormalized,
            trackCount: rep.track_count,
            groupSize: group.length,
            sourceInstanceIds: group.map(a => a.instance_id),
            sourceInstanceAlbumIds: group.map(a => a.id),
            sourceTrackCounts: group.map(a => a.track_count),
            existingRow: existing,
          });
          throw err;
        }
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
      INSERT INTO track_sources (id, unified_track_id, instance_id, instance_track_id, format, bitrate, size)
      VALUES (?, ?, ?, ?, ?, ?, ?)
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
        const rep = group[0];
        const artistId = instanceAlbumToArtist.get(rep.album_id as string) ?? "unknown";
        const titleNorm = normalizeName(rep.title as string);
        const durationMs = rep.duration_ms as number | null;
        const id = generateTrackId(
          titleNorm,
          artistId,
          releaseId,
          mbid,
          rep.track_number as number | null,
          rep.disc_number as number | null,
          durationMs,
        );

        try {
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
        } catch (err) {
          const existing = db
            .prepare("SELECT id, title, release_id, artist_id, musicbrainz_id, track_number, disc_number, duration_ms FROM unified_tracks WHERE id = ?")
            .get(id);
          const existingSources = db
            .prepare("SELECT instance_id, instance_track_id FROM track_sources WHERE unified_track_id = ?")
            .all(id);
          console.error("[merge] insertTrack (mbid path) failed", {
            id, releaseId, artistId, title: rep.title, titleNorm, mbid,
            trackNumber: rep.track_number, discNumber: rep.disc_number,
            durationMs: rep.duration_ms,
            groupSize: group.length,
            sourceInstanceIds: group.map(t => t.instance_id),
            sourceInstanceTrackIds: group.map(t => t.id),
            existingRow: existing,
            existingSources,
          });
          throw err;
        }

        for (const track of group) {
          const tsId = generateTrackSourceId(id, track.instance_id as string, track.id as string);
          try {
            insertTrackSource.run(
              tsId,
              id,
              track.instance_id as string,
              track.id as string,
              track.format as string | null,
              track.bitrate as number | null,
              track.size as number | null,
            );
          } catch (err) {
            const existing = db
              .prepare("SELECT id, unified_track_id, instance_id, instance_track_id, format, bitrate FROM track_sources WHERE id = ?")
              .get(tsId);
            console.error("[merge] insertTrackSource (mbid path) failed", {
              id: tsId,
              unifiedTrackId: id,
              instanceId: track.instance_id,
              instanceTrackId: track.id,
              instanceAlbumId: track.album_id,
              releaseId, mbid, title: track.title, titleNorm,
              durationMs: track.duration_ms,
              groupSize: group.length,
              groupInstanceTrackIds: group.map(t => t.id),
              existingRow: existing,
            });
            throw err;
          }
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
            const tsId = generateTrackSourceId(existing.unifiedId, track.instance_id as string, track.id as string);
            try {
              insertTrackSource.run(
                tsId,
                existing.unifiedId,
                track.instance_id as string,
                track.id as string,
                track.format as string | null,
                track.bitrate as number | null,
                track.size as number | null,
              );
            } catch (err) {
              const prior = db
                .prepare("SELECT id, unified_track_id, instance_id, instance_track_id, format, bitrate FROM track_sources WHERE id = ?")
                .get(tsId);
              console.error("[merge] insertTrackSource (fuzzy match path) failed", {
                id: tsId,
                unifiedTrackId: existing.unifiedId,
                instanceId: track.instance_id,
                instanceTrackId: track.id,
                instanceAlbumId: track.album_id,
                releaseId, title: track.title, titleNorm,
                trackNumber, durationMs,
                existingRow: prior,
              });
              throw err;
            }
            matched = true;
            break;
          }
        }

        if (!matched) {
          // Create a new unified track
          const artistId = instanceAlbumToArtist.get(track.album_id as string) ?? "unknown";
          const durationMs = track.duration_ms as number | null;
          const id = generateTrackId(
            titleNorm,
            artistId,
            releaseId,
            null,
            trackNumber,
            track.disc_number as number | null,
            durationMs,
          );

          try {
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
          } catch (err) {
            const existing = db
              .prepare("SELECT id, title, release_id, artist_id, musicbrainz_id, track_number, disc_number, duration_ms FROM unified_tracks WHERE id = ?")
              .get(id);
            const existingSources = db
              .prepare("SELECT instance_id, instance_track_id FROM track_sources WHERE unified_track_id = ?")
              .all(id);
            console.error("[merge] insertTrack (name path) failed", {
              id, releaseId, artistId,
              title: track.title, titleNorm,
              trackNumber, discNumber: track.disc_number, durationMs,
              instanceId: track.instance_id,
              instanceTrackId: track.id,
              instanceAlbumId: track.album_id,
              existingRow: existing,
              existingSources,
            });
            throw err;
          }

          const tsId = generateTrackSourceId(id, track.instance_id as string, track.id as string);
          try {
            insertTrackSource.run(
              tsId,
              id,
              track.instance_id as string,
              track.id as string,
              track.format as string | null,
              track.bitrate as number | null,
              track.size as number | null,
            );
          } catch (err) {
            const prior = db
              .prepare("SELECT id, unified_track_id, instance_id, instance_track_id, format, bitrate FROM track_sources WHERE id = ?")
              .get(tsId);
            console.error("[merge] insertTrackSource (name path, new track) failed", {
              id: tsId,
              unifiedTrackId: id,
              instanceId: track.instance_id,
              instanceTrackId: track.id,
              instanceAlbumId: track.album_id,
              releaseId, title: track.title, titleNorm,
              trackNumber, durationMs,
              existingRow: prior,
            });
            throw err;
          }

          createdTracks.push({
            unifiedId: id,
            titleNorm,
            trackNumber,
            durationMs,
          });
        }
      }
    }

    // ── Step 5: Mark preferred source per unified track ────────────────────
    //
    // Selection rule (runs here, not at stream time):
    //   1. Higher-quality format wins (FLAC > WAV > ALAC > Opus > AAC > MP3 > Ogg).
    //   2. Tie → higher bitrate.
    //   3. Tie → local instance.
    //   4. Tie → lowest id (stable).
    db.exec(`
      UPDATE track_sources SET preferred = 0;
      UPDATE track_sources SET preferred = 1 WHERE id IN (
        SELECT id FROM (
          SELECT ts.id,
            ROW_NUMBER() OVER (
              PARTITION BY ts.unified_track_id
              ORDER BY
                CASE LOWER(COALESCE(ts.format, ''))
                  WHEN 'flac' THEN 100
                  WHEN 'wav'  THEN 90
                  WHEN 'alac' THEN 85
                  WHEN 'opus' THEN 70
                  WHEN 'aac'  THEN 60
                  WHEN 'mp3'  THEN 50
                  WHEN 'ogg'  THEN 45
                  ELSE 30
                END DESC,
                COALESCE(ts.bitrate, 0) DESC,
                CASE WHEN ts.instance_id = 'local' THEN 1 ELSE 0 END DESC,
                ts.id ASC
            ) AS rn
          FROM track_sources ts
        ) WHERE rn = 1
      );
    `);
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
