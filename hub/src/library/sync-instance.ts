/**
 * sync-instance.ts
 *
 * Reads a Navidrome library through a /proxy/* endpoint and upserts data into
 * instance_* tables. Used for both local and remote Navidrome instances.
 *
 * For local: pass a plain fetch (no signing needed — hub internal).
 * For peer:  pass a signed fetch created via createFederationFetcher so every
 *            request carries the Ed25519 x-poutine-* headers.
 */

import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { USER_AGENT } from "../version.js";
import type { SyncResult } from "./sync.js";
import type { LastFmClient } from "../services/lastfm.js";

// ── Subsonic JSON envelope types (minimal) ────────────────────────────────────

interface SubsonicEnvelope {
  "subsonic-response": {
    status: "ok" | "failed";
    error?: { code: number; message: string };
    [key: string]: unknown;
  };
}

interface NavidromeArtist {
  id: string;
  name: string;
  albumCount?: number;
  coverArt?: string;
  musicBrainzId?: string;
}

interface NavidromeArtistDetail extends NavidromeArtist {
  album?: NavidromeAlbum[];
}

interface NavidromeAlbum {
  id: string;
  name: string;
  artist?: string;
  artistId?: string;
  coverArt?: string;
  songCount?: number;
  duration?: number;
  year?: number;
  genre?: string;
  musicBrainzId?: string;
  created?: string;
  song?: NavidromeSong[];
}

interface NavidromeSong {
  id: string;
  title: string;
  artist?: string;
  track?: number;
  discNumber?: number;
  duration?: number;
  bitRate?: number;
  suffix?: string;
  size?: number;
  musicBrainzId?: string;
  year?: number;
  genre?: string;
}

// ── Simple semaphore ──────────────────────────────────────────────────────────

class Semaphore {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) { this.running++; return; }
    return new Promise<void>((resolve) => {
      this.queue.push(() => { this.running++; resolve(); });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await fn(); } finally { this.release(); }
  }
}

// ── ProxyFetch — a fetch wrapper with optional header injection ───────────────

export type ProxyFetch = (
  path: string,
  opts?: { signal?: AbortSignal },
) => Promise<Response>;

/**
 * Create a ProxyFetch that talks to a plain endpoint (no signing).
 * Used for local Navidrome reads via the local /proxy/*.
 *
 * Injects Subsonic t+s credentials so the proxy can forward them to Navidrome.
 */
export function createLocalProxyFetch(opts: {
  proxyBaseUrl: string;      // e.g. "http://127.0.0.1:3000/proxy"
  navidromeUsername: string; // Navidrome admin username
  navidromePassword: string; // Navidrome admin password
}): ProxyFetch {
  const { proxyBaseUrl, navidromeUsername, navidromePassword } = opts;
  const base = proxyBaseUrl.replace(/\/+$/, "");

  return async (path: string, fetchOpts?: { signal?: AbortSignal }) => {
    // Local sync hits Navidrome directly with Subsonic t+s creds (proxyBaseUrl
    // is the Navidrome URL). Bypasses /proxy/* to avoid the Argon2id u+p round-
    // trip for an internal call.
    const salt = crypto.randomBytes(8).toString("hex");
    const token = crypto.createHash("md5").update(navidromePassword + salt).digest("hex");

    const url = new URL(base + path);
    url.searchParams.set("u", navidromeUsername);
    url.searchParams.set("t", token);
    url.searchParams.set("s", salt);
    url.searchParams.set("v", "1.16.1");
    url.searchParams.set("c", "poutine-sync");
    url.searchParams.set("f", "json");

    return fetch(url.toString(), {
      headers: { "user-agent": USER_AGENT },
      signal: fetchOpts?.signal,
    });
  };
}

/**
 * Create a ProxyFetch that signs each request with the hub's Ed25519 key.
 * Used for remote peer reads via the peer's /proxy/*.
 *
 * The signing path must include "/proxy" prefix (as seen by the peer's Fastify).
 */
export function createPeerProxyFetch(opts: {
  proxyBaseUrl: string;  // e.g. "https://peer.example.com/proxy" — no trailing slash
  signedFetch: (path: string) => Promise<Response>; // delegates to sign-request.ts
}): ProxyFetch {
  const { signedFetch } = opts;
  return async (path: string, _fetchOpts?: { signal?: AbortSignal }) => {
    // path is e.g. "/rest/getArtists?f=json&..."
    // The canonical signing path must include /proxy prefix.
    return signedFetch(`/proxy${path}`);
  };
}

// ── Core reader ───────────────────────────────────────────────────────────────

export type SyncLogger = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

const noopLogger: SyncLogger = { info: () => {}, error: () => {} };

/**
 * Read a Navidrome library through a proxy endpoint and upsert into instance_*
 * tables. Works for both local and remote instances.
 *
 * @param db         Hub SQLite database
 * @param instanceId Row key in `instances` table (e.g. "local" or peer id)
 * @param proxyFetch Pre-configured fetch function (local or signed peer)
 * @param config     Concurrency limit, optional logger, and optional Last.fm client
 */
export async function readNavidromeViaProxy(
  db: Database.Database,
  instanceId: string,
  proxyFetch: ProxyFetch,
  config: { concurrency?: number; log?: SyncLogger; lastFmClient?: LastFmClient | null } = {},
): Promise<SyncResult> {
  const concurrency = config.concurrency ?? 3;
  const log = config.log ?? noopLogger;
  const sem = new Semaphore(concurrency);
  const startMs = Date.now();

  const result: SyncResult = {
    instanceId,
    artistCount: 0,
    albumCount: 0,
    trackCount: 0,
    errors: [],
  };

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function proxyJson(path: string): Promise<Record<string, unknown>> {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${path}${sep}f=json&v=1.16.1&c=poutine-sync`;
    const res = await proxyFetch(url);
    const contentLength = res.headers.get("content-length");
    const sizeLabel = contentLength ? `${contentLength}B` : "?B";
    if (!res.ok) {
      log.error(`[${instanceId}] GET ${path} → HTTP ${res.status} (${sizeLabel})`);
      throw new Error(`HTTP ${res.status} from proxy path ${path}`);
    }
    const bodyText = await res.text();
    log.info(`[${instanceId}] GET ${path} → HTTP ${res.status} (${bodyText.length}B)`);
    const body = JSON.parse(bodyText) as SubsonicEnvelope;
    const env = body["subsonic-response"];
    if (!env) throw new Error("Missing subsonic-response envelope");
    if (env.status === "failed") {
      throw new Error(`Subsonic error ${env.error?.code}: ${env.error?.message}`);
    }
    return env as unknown as Record<string, unknown>;
  }

  // ── Prepared statements ────────────────────────────────────────────────────

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

  // Track seen IDs for stale-data cleanup
  const seenArtistRemoteIds = new Set<string>();
  const seenAlbumRemoteIds = new Set<string>();
  const seenTrackRemoteIds = new Set<string>();

  log.info(`[${instanceId}] sync started`);

  // ── Step 1: Fetch artists ──────────────────────────────────────────────────

  let artistIndexes: Array<{ artist?: NavidromeArtist[] }>;
  try {
    const data = await proxyJson("/rest/getArtists");
    const artistsObj = data.artists as { index?: Array<{ artist?: NavidromeArtist[] }> } | undefined;
    artistIndexes = artistsObj?.index ?? [];
  } catch (err) {
    result.errors.push(`Failed to fetch artists for ${instanceId}: ${String(err)}`);
    db.prepare(
      "UPDATE instances SET status = 'offline', last_sync_ok = 0, last_sync_message = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(result.errors.join("; "), instanceId);
    return result;
  }

  const allArtists = artistIndexes.flatMap((idx) => idx.artist ?? []);
  log.info(`[${instanceId}] found ${allArtists.length} artists — fetching details`);

  // ── Step 2: Fetch artist details + album list ──────────────────────────────

  interface ArtistAlbumPair {
    artistCompositeId: string;
    album: NavidromeAlbum;
  }
  const albumsToFetch: ArtistAlbumPair[] = [];

  await Promise.all(
    allArtists.map((artist) =>
      sem.run(async () => {
        try {
          const data = await proxyJson(`/rest/getArtist?id=${encodeURIComponent(artist.id)}`);
          const detail = data.artist as NavidromeArtistDetail;
          const artistCompositeId = `${instanceId}:${artist.id}`;

          // Get image from Navidrome first
          let artistImageUrl: string | null = detail.coverArt ?? artist.coverArt ?? null;

          // If no image and Last.fm is enabled, try to fetch from Last.fm
          if (!artistImageUrl && config.lastFmClient?.isEnabled()) {
            try {
              const lastFmInfo = await config.lastFmClient.getArtistInfo(
                detail.name ?? artist.name,
                detail.musicBrainzId ?? artist.musicBrainzId ?? undefined
              );
              if (lastFmInfo) {
                const bestImage = config.lastFmClient.getBestImage(lastFmInfo);
                if (bestImage) {
                  artistImageUrl = bestImage;
                }
              }
            } catch {
              // Last.fm fetch failed, keep existing image URL (or null)
            }
          }

          upsertArtist.run(
            artistCompositeId,
            instanceId,
            artist.id,
            detail.name ?? artist.name,
            detail.musicBrainzId ?? artist.musicBrainzId ?? null,
            detail.albumCount ?? artist.albumCount ?? 0,
            artistImageUrl,
          );
          seenArtistRemoteIds.add(artist.id);
          result.artistCount++;

          for (const album of detail.album ?? []) {
            albumsToFetch.push({ artistCompositeId, album });
          }
        } catch (err) {
          result.errors.push(`Failed to fetch artist ${artist.id}: ${String(err)}`);
        }
      }),
    ),
  );

  log.info(`[${instanceId}] fetched ${result.artistCount} artists — fetching ${albumsToFetch.length} albums`);

  // ── Step 3: Fetch album details + tracks ───────────────────────────────────

  await Promise.all(
    albumsToFetch.map(({ artistCompositeId, album }) =>
      sem.run(async () => {
        try {
          const data = await proxyJson(`/rest/getAlbum?id=${encodeURIComponent(album.id)}`);
          const detail = data.album as NavidromeAlbum;
          const albumCompositeId = `${instanceId}:${album.id}`;
          const durationMs = detail.duration ? detail.duration * 1000 : null;

          upsertAlbum.run(
            albumCompositeId,
            instanceId,
            album.id,
            detail.name ?? album.name,
            artistCompositeId,
            detail.artist ?? album.artist ?? "",
            detail.year ?? album.year ?? null,
            detail.genre ?? album.genre ?? null,
            detail.musicBrainzId ?? album.musicBrainzId ?? null,
            (detail as unknown as Record<string, unknown>).releaseGroupMbid as string ?? null,
            detail.songCount ?? album.songCount ?? 0,
            durationMs,
            detail.coverArt ?? album.coverArt ?? null,
            detail.created ?? album.created ?? null,
          );
          seenAlbumRemoteIds.add(album.id);
          result.albumCount++;

          for (const song of detail.song ?? []) {
            const trackCompositeId = `${instanceId}:${song.id}`;
            const trackDurationMs = song.duration ? song.duration * 1000 : null;

            upsertTrack.run(
              trackCompositeId,
              instanceId,
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
            seenTrackRemoteIds.add(song.id);
            result.trackCount++;
          }
        } catch (err) {
          result.errors.push(`Failed to fetch album ${album.id}: ${String(err)}`);
        }
      }),
    ),
  );

  // ── Update instance row ────────────────────────────────────────────────────

  if (result.errors.length === 0) {
    _deleteStale(db, instanceId, seenTrackRemoteIds, seenAlbumRemoteIds, seenArtistRemoteIds);

    const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
    const syncMessage = `Synced ${result.artistCount} artists, ${result.albumCount} albums, ${result.trackCount} tracks in ${elapsedSec} seconds`;

    db.prepare(
      "UPDATE instances SET status = 'online', last_seen = datetime('now'), last_synced_at = datetime('now'), last_sync_ok = 1, last_sync_message = ?, track_count = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(syncMessage, result.trackCount, instanceId);

    log.info(`[${instanceId}] sync complete: ${result.artistCount} artists, ${result.albumCount} albums, ${result.trackCount} tracks`);
  } else {
    const syncMessage = result.errors.join("; ");

    db.prepare(
      "UPDATE instances SET status = 'offline', last_sync_ok = 0, last_sync_message = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(syncMessage, instanceId);

    log.error(`[${instanceId}] sync finished with ${result.errors.length} error(s): ${result.errors.join("; ")}`);
  }

  return result;
}

// ── Stale-data cleanup (reused from sync-peer.ts pattern) ────────────────────

function _deleteStale(
  db: Database.Database,
  instanceId: string,
  seenTracks: Set<string>,
  seenAlbums: Set<string>,
  seenArtists: Set<string>,
): void {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS _poutine_seen_tracks  (remote_id TEXT PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS _poutine_seen_albums  (remote_id TEXT PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS _poutine_seen_artists (remote_id TEXT PRIMARY KEY);
  `);

  db.transaction(() => {
    db.prepare("DELETE FROM _poutine_seen_tracks").run();
    db.prepare("DELETE FROM _poutine_seen_albums").run();
    db.prepare("DELETE FROM _poutine_seen_artists").run();

    const insTrack  = db.prepare("INSERT OR IGNORE INTO _poutine_seen_tracks  VALUES (?)");
    const insAlbum  = db.prepare("INSERT OR IGNORE INTO _poutine_seen_albums  VALUES (?)");
    const insArtist = db.prepare("INSERT OR IGNORE INTO _poutine_seen_artists VALUES (?)");

    for (const id of seenTracks)  insTrack.run(id);
    for (const id of seenAlbums)  insAlbum.run(id);
    for (const id of seenArtists) insArtist.run(id);

    db.prepare(
      "DELETE FROM instance_tracks  WHERE instance_id = ? AND remote_id NOT IN (SELECT remote_id FROM _poutine_seen_tracks)",
    ).run(instanceId);
    db.prepare(
      "DELETE FROM instance_albums  WHERE instance_id = ? AND remote_id NOT IN (SELECT remote_id FROM _poutine_seen_albums)",
    ).run(instanceId);
    db.prepare(
      "DELETE FROM instance_artists WHERE instance_id = ? AND remote_id NOT IN (SELECT remote_id FROM _poutine_seen_artists)",
    ).run(instanceId);
  })();
}
