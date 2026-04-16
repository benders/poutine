import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { SubsonicClient } from "../adapters/subsonic.js";
import type { SubsonicAlbum, SubsonicSong } from "../adapters/subsonic.js";
import type { PeerRegistry } from "../federation/peers.js";
import { syncLocal } from "./sync-local.js";
import { syncPeer } from "./sync-peer.js";
import type { FederationFetcher } from "./sync-peer.js";
import type { SyncLogger } from "./sync-instance.js";
import { mergeLibraries } from "./merge.js";
import { seedSyntheticInstances } from "./seed-instances.js";
import { SyncOperationService } from "../services/sync-operations.js";
import type { SyncOperationType } from "../services/sync-operations.js";

/** Minimal instance descriptor used by syncInstance. */
export interface Instance {
  id: string;
  name: string;
  url: string;
  adapterType: string;
  ownerId: string;
  status: string;
  lastSeen: string | null;
  lastSyncedAt: string | null;
  trackCount: number;
  serverVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyncResult {
  instanceId: string;
  artistCount: number;
  albumCount: number;
  trackCount: number;
  errors: string[];
}

/**
 * Simple semaphore for concurrency limiting.
 */
class Semaphore {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * Sync a single instance's library into the instance_* tables.
 */
export async function syncInstance(
  db: Database.Database,
  instance: Instance,
  client: SubsonicClient,
  config: { concurrency: number } = { concurrency: 3 },
): Promise<SyncResult> {
  const result: SyncResult = {
    instanceId: instance.id,
    artistCount: 0,
    albumCount: 0,
    trackCount: 0,
    errors: [],
  };

  const startMs = Date.now();
  const sem = new Semaphore(config.concurrency);

  // Prepared statements for upserts
  const upsertArtist = db.prepare(`
    INSERT INTO instance_artists (id, instance_id, remote_id, name, musicbrainz_id, album_count, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(instance_id, remote_id) DO UPDATE SET
      name = excluded.name,
      musicbrainz_id = excluded.musicbrainz_id,
      album_count = excluded.album_count,
      image_url = excluded.image_url
  `);

  const upsertAlbum = db.prepare(`
    INSERT INTO instance_albums (id, instance_id, remote_id, name, artist_id, artist_name, year, genre, musicbrainz_id, release_group_mbid, track_count, duration_ms, cover_art_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(instance_id, remote_id) DO UPDATE SET
      name = excluded.name,
      artist_id = excluded.artist_id,
      artist_name = excluded.artist_name,
      year = excluded.year,
      genre = excluded.genre,
      musicbrainz_id = excluded.musicbrainz_id,
      release_group_mbid = excluded.release_group_mbid,
      track_count = excluded.track_count,
      duration_ms = excluded.duration_ms,
      cover_art_id = excluded.cover_art_id,
      created_at = excluded.created_at
  `);

  const upsertTrack = db.prepare(`
    INSERT INTO instance_tracks (id, instance_id, remote_id, album_id, title, artist_name, track_number, disc_number, duration_ms, bitrate, format, size, musicbrainz_id, year, genre)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      year = excluded.year,
      genre = excluded.genre
  `);

  // Step 1: Fetch all artists
  let artistIndexes;
  try {
    artistIndexes = await client.getArtists();
  } catch (err) {
    result.errors.push(`Failed to fetch artists: ${err}`);
    return result;
  }

  // Flatten artist indexes
  const allArtists = artistIndexes.flatMap((idx) => idx.artist ?? []);

  // Step 2: For each artist, fetch albums
  interface ArtistAlbumPair {
    artistId: string;
    artistRemoteId: string;
    album: SubsonicAlbum;
  }
  const albumsToFetch: ArtistAlbumPair[] = [];

  await Promise.all(
    allArtists.map((artist) =>
      sem.run(async () => {
        try {
          const artistDetail = await client.getArtist(artist.id);
          const artistCompositeId = `${instance.id}:${artist.id}`;

          upsertArtist.run(
            artistCompositeId,
            instance.id,
            artist.id,
            artistDetail.name ?? artist.name,
            artistDetail.musicBrainzId ?? artist.musicBrainzId ?? null,
            artistDetail.albumCount ?? artist.albumCount ?? 0,
            artistDetail.coverArt ?? artist.coverArt ?? null,
          );
          result.artistCount++;

          if (artistDetail.album) {
            for (const album of artistDetail.album) {
              albumsToFetch.push({
                artistId: artistCompositeId,
                artistRemoteId: artist.id,
                album,
              });
            }
          }
        } catch (err) {
          result.errors.push(`Failed to fetch artist ${artist.id}: ${err}`);
        }
      }),
    ),
  );

  // Step 3: For each album, fetch full details with tracks
  await Promise.all(
    albumsToFetch.map(({ artistId, album }) =>
      sem.run(async () => {
        try {
          const albumDetail = await client.getAlbum(album.id);
          const albumCompositeId = `${instance.id}:${album.id}`;
          const durationMs = albumDetail.duration
            ? albumDetail.duration * 1000
            : null;

          upsertAlbum.run(
            albumCompositeId,
            instance.id,
            album.id,
            albumDetail.name ?? album.name,
            artistId,
            albumDetail.artist ?? album.artist ?? "",
            albumDetail.year ?? album.year ?? null,
            albumDetail.genre ?? album.genre ?? null,
            albumDetail.musicBrainzId ?? album.musicBrainzId ?? null,
            // Release Group MBID - Navidrome doesn't always expose this separately
            // but some do via extended tags. We'll use the album's MBID context.
            (albumDetail as unknown as Record<string, unknown>).releaseGroupMbid as string ?? null,
            albumDetail.songCount ?? album.songCount ?? 0,
            durationMs,
            albumDetail.coverArt ?? album.coverArt ?? null,
            albumDetail.created ?? album.created ?? null,
          );
          result.albumCount++;

          // Process tracks
          const songs: SubsonicSong[] = albumDetail.song ?? [];
          for (const song of songs) {
            const trackCompositeId = `${instance.id}:${song.id}`;
            const trackDurationMs = song.duration
              ? song.duration * 1000
              : null;

            upsertTrack.run(
              trackCompositeId,
              instance.id,
              song.id,
              albumCompositeId,
              song.title,
              song.artist ?? "",
              song.track ?? null,
              song.discNumber ?? 1,
              trackDurationMs,
              song.bitRate ?? null,
              song.suffix ?? null,
              song.size ?? null,
              song.musicBrainzId ?? null,
              song.year ?? null,
              song.genre ?? null,
            );
            result.trackCount++;
          }
        } catch (err) {
          result.errors.push(`Failed to fetch album ${album.id}: ${err}`);
        }
      }),
    ),
  );

  // Update instance sync timestamp, track count, and mark online
  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
  const syncMessage = result.errors.length === 0
    ? `Synced ${result.artistCount} artists, ${result.albumCount} albums, ${result.trackCount} tracks in ${elapsedSec} seconds`
    : result.errors.join("; ");
  db.prepare(
    "UPDATE instances SET status = 'online', last_seen = datetime('now'), last_synced_at = datetime('now'), last_sync_ok = 1, last_sync_message = ?, track_count = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(syncMessage, result.trackCount, instance.id);

  return result;
}

/**
 * Sync the local Navidrome and all known peers, then merge.
 * This is the main entry point for Phase 4+ sync.
 */
export async function syncAll(
  db: Database.Database,
  config: Config,
  peerRegistry: PeerRegistry,
  federatedFetch: FederationFetcher,
  ownerUsername: string,
  syncOpService?: SyncOperationService,
  operationType: SyncOperationType = "manual",
): Promise<{ local: SyncResult; peers: SyncResult[] }> {
  const operationId = syncOpService?.start(operationType, "local") || null;
  let localResult: SyncResult;
  
  // Ensure synthetic instance rows exist (idempotent)
  seedSyntheticInstances(db, config, peerRegistry);

  try {
    localResult = await syncLocal(db, config);
  } catch (err) {
    if (operationId) {
      syncOpService!.fail(operationId, [`Local sync failed: ${String(err)}`]);
    }
    throw err;
  }

  const peers: SyncResult[] = [];
  for (const peer of peerRegistry.peers.values()) {
<<<<<<< HEAD
    let peerOperationId: string | null = null;
    if (syncOpService) {
      peerOperationId = syncOpService.start(operationType, "peer", peer.id);
    }
    
    try {
      const peerResult = await syncPeer(db, peer, federatedFetch, ownerUsername, { log });
      peers.push(peerResult);
      if (peerOperationId && syncOpService) {
        syncOpService.complete(peerOperationId, 0, 0, peerResult.trackCount, peerResult.errors);
      }
    } catch (err) {
      log?.error(`syncAll: peer ${peer.id} threw — ${String(err)}`);
      const syncMessage = `Peer sync failed: ${String(err)}`;
      db.prepare(
        "UPDATE instances SET status = 'offline', last_sync_ok = 0, last_sync_message = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(syncMessage, peer.id);
      peers.push({
        instanceId: peer.id,
        artistCount: 0,
        albumCount: 0,
        trackCount: 0,
        errors: [syncMessage],
      });
      if (peerOperationId && syncOpService) {
        syncOpService.fail(peerOperationId, [`Peer sync failed: ${String(err)}`]);
      }
    }
  }

  mergeLibraries(db);

  if (operationId && syncOpService) {
    syncOpService.complete(operationId, localResult.artistCount, localResult.albumCount, localResult.trackCount, localResult.errors);
  }

  return { local: localResult, peers };
}

