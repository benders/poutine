/**
 * DLNA ContentDirectory object hierarchy backed by the unified library.
 *
 * Object IDs are deterministic strings so DLNA clients (notably Windows
 * Media Player) can cache them across hub restarts without breaking. They
 * survive resync because they're keyed on `unified_*.id` UUIDs, which are
 * stable for the lifetime of an entity.
 *
 * Tree:
 *
 *   "0"                        root container
 *     "0/music"                Music
 *       "0/music/artists"      All Artists
 *         "0/music/artist/<unified_artist_id>"   one artist
 *           — contains release groups for that artist
 *       "0/music/albums"       All Albums (release groups)
 *         "0/music/album/<unified_release_group_id>"   one album
 *           — contains tracks across all releases in the group
 *       "0/music/tracks"       All Tracks
 *
 * We collapse `unified_release_groups` to "albums" for the v1 hierarchy;
 * release-level (edition) browsing is out of scope and rarely useful for
 * DLNA clients.
 */
import type Database from "better-sqlite3";
import { buildAudioItem, buildContainer, wrapDidl } from "./didl.js";
import { xmlEscape } from "./soap.js";

export const ROOT_ID = "0";
export const MUSIC_ID = "0/music";
export const ARTISTS_ID = "0/music/artists";
export const ALBUMS_ID = "0/music/albums";
export const TRACKS_ID = "0/music/tracks";

export type ObjectKind =
  | "root"
  | "music"
  | "artists"
  | "albums"
  | "tracks"
  | "artist"
  | "album";

export interface ParsedObjectId {
  kind: ObjectKind;
  /** UUID of the underlying unified_* row, for `artist` and `album`. */
  id?: string;
}

export function parseObjectId(s: string): ParsedObjectId | null {
  if (s === ROOT_ID) return { kind: "root" };
  if (s === MUSIC_ID) return { kind: "music" };
  if (s === ARTISTS_ID) return { kind: "artists" };
  if (s === ALBUMS_ID) return { kind: "albums" };
  if (s === TRACKS_ID) return { kind: "tracks" };
  const mArtist = s.match(/^0\/music\/artist\/([^/]+)$/);
  if (mArtist) return { kind: "artist", id: mArtist[1] };
  const mAlbum = s.match(/^0\/music\/album\/([^/]+)$/);
  if (mAlbum) return { kind: "album", id: mAlbum[1] };
  return null;
}

export function artistObjectId(unifiedArtistId: string): string {
  return `0/music/artist/${unifiedArtistId}`;
}

export function albumObjectId(unifiedReleaseGroupId: string): string {
  return `0/music/album/${unifiedReleaseGroupId}`;
}

export interface BrowseOptions {
  startIndex: number;
  requestedCount: number;
  /**
   * Absolute base URL the DLNA client can reach the hub at — e.g.
   * `http://192.168.1.10:3000`. Used to build `res@uri` and `albumArtURI`.
   * Must not have a trailing slash.
   */
  baseUrl: string;
}

export interface BrowseResult {
  /** DIDL-Lite XML payload (already wrapped in `<DIDL-Lite>`). */
  result: string;
  /** Number of objects returned in this response. */
  numberReturned: number;
  /** Total number of child objects (for pagination). */
  totalMatches: number;
}

interface ArtistRow {
  id: string;
  name: string;
  image_url: string | null;
  album_count: number;
}

interface AlbumRow {
  id: string;
  name: string;
  artist_id: string;
  artist_name: string;
  image_url: string | null;
  track_count: number;
}

interface TrackRow {
  id: string;
  title: string;
  artist_name: string;
  album_name: string;
  album_art: string | null;
  duration_ms: number | null;
  format: string | null;
  bitrate: number | null;
}

/**
 * Maps the unified library's source format hint to a DLNA-suitable MIME
 * type. Returns a best-effort `audio/mpeg` if unknown — Windows Media
 * Player legacy in particular wants something here.
 */
function mimeForFormat(format: string | null | undefined): string {
  switch ((format || "").toLowerCase()) {
    case "mp3":
      return "audio/mpeg";
    case "flac":
      return "audio/flac";
    case "ogg":
    case "opus":
      return "audio/ogg";
    case "aac":
    case "m4a":
      return "audio/mp4";
    case "wav":
      return "audio/wav";
    default:
      return "audio/mpeg";
  }
}

function streamUri(baseUrl: string, trackId: string): string {
  return `${baseUrl}/dlna/stream/${encodeURIComponent(trackId)}`;
}

function albumArtUriFor(baseUrl: string, encodedCoverArtId: string | null): string | null {
  if (!encodedCoverArtId) return null;
  return `${baseUrl}/rest/getCoverArt?id=${encodeURIComponent(encodedCoverArtId)}`;
}

export class DlnaObjectService {
  constructor(private readonly db: Database.Database) {}

  /** ContentDirectory `Browse` (BrowseDirectChildren or BrowseMetadata). */
  browse(
    objectId: string,
    browseFlag: "BrowseMetadata" | "BrowseDirectChildren",
    opts: BrowseOptions,
  ): BrowseResult {
    const parsed = parseObjectId(objectId);
    if (!parsed) {
      return { result: wrapDidl(""), numberReturned: 0, totalMatches: 0 };
    }
    if (browseFlag === "BrowseMetadata") {
      return this.browseMetadata(parsed, opts);
    }
    return this.browseChildren(parsed, opts);
  }

  private browseMetadata(parsed: ParsedObjectId, opts: BrowseOptions): BrowseResult {
    const xml = (() => {
      switch (parsed.kind) {
        case "root":
          return buildContainer({
            objectId: ROOT_ID,
            parentId: "-1",
            title: "Poutine",
            upnpClass: "object.container.storageFolder",
            childCount: 1,
          });
        case "music":
          return buildContainer({
            objectId: MUSIC_ID,
            parentId: ROOT_ID,
            title: "Music",
            upnpClass: "object.container.storageFolder",
            childCount: 3,
          });
        case "artists":
          return buildContainer({
            objectId: ARTISTS_ID,
            parentId: MUSIC_ID,
            title: "Artists",
            upnpClass: "object.container.person.musicArtist",
            childCount: this.countArtists(),
          });
        case "albums":
          return buildContainer({
            objectId: ALBUMS_ID,
            parentId: MUSIC_ID,
            title: "Albums",
            upnpClass: "object.container.album.musicAlbum",
            childCount: this.countAlbums(),
          });
        case "tracks":
          return buildContainer({
            objectId: TRACKS_ID,
            parentId: MUSIC_ID,
            title: "All Tracks",
            upnpClass: "object.container.storageFolder",
            childCount: this.countTracks(),
          });
        case "artist": {
          const row = this.getArtist(parsed.id!);
          if (!row) return "";
          return buildContainer({
            objectId: artistObjectId(row.id),
            parentId: ARTISTS_ID,
            title: row.name,
            upnpClass: "object.container.person.musicArtist",
            childCount: row.album_count,
            albumArtUri: row.image_url,
            artist: row.name,
          });
        }
        case "album": {
          const row = this.getAlbum(parsed.id!);
          if (!row) return "";
          return buildContainer({
            objectId: albumObjectId(row.id),
            parentId: ALBUMS_ID,
            title: row.name,
            upnpClass: "object.container.album.musicAlbum",
            childCount: row.track_count,
            albumArtUri: albumArtUriFor(opts.baseUrl, row.image_url),
            artist: row.artist_name,
          });
        }
      }
    })();
    return {
      result: wrapDidl(xml),
      numberReturned: xml ? 1 : 0,
      totalMatches: xml ? 1 : 0,
    };
  }

  private browseChildren(parsed: ParsedObjectId, opts: BrowseOptions): BrowseResult {
    switch (parsed.kind) {
      case "root":
        return this.staticChildren(
          [
            buildContainer({
              objectId: MUSIC_ID,
              parentId: ROOT_ID,
              title: "Music",
              upnpClass: "object.container.storageFolder",
              childCount: 3,
            }),
          ],
          opts,
        );
      case "music":
        return this.staticChildren(
          [
            buildContainer({
              objectId: ARTISTS_ID,
              parentId: MUSIC_ID,
              title: "Artists",
              upnpClass: "object.container.storageFolder",
              childCount: this.countArtists(),
            }),
            buildContainer({
              objectId: ALBUMS_ID,
              parentId: MUSIC_ID,
              title: "Albums",
              upnpClass: "object.container.storageFolder",
              childCount: this.countAlbums(),
            }),
            buildContainer({
              objectId: TRACKS_ID,
              parentId: MUSIC_ID,
              title: "All Tracks",
              upnpClass: "object.container.storageFolder",
              childCount: this.countTracks(),
            }),
          ],
          opts,
        );
      case "artists":
        return this.listArtists(opts);
      case "albums":
        return this.listAlbums(null, opts);
      case "tracks":
        return this.listTracks(null, null, opts);
      case "artist":
        return this.listAlbums(parsed.id!, opts);
      case "album":
        return this.listTracks(null, parsed.id!, opts);
    }
  }

  private staticChildren(items: string[], opts: BrowseOptions): BrowseResult {
    const sliced = items.slice(
      opts.startIndex,
      opts.startIndex + (opts.requestedCount || items.length),
    );
    return {
      result: wrapDidl(sliced.join("")),
      numberReturned: sliced.length,
      totalMatches: items.length,
    };
  }

  // ---------- DB queries ----------

  private countArtists(): number {
    // Hide artists with no release group of their own. They show up as
    // empty containers in DLNA browsers (VLC, etc.) because the artist→
    // album path filters by `urg.artist_id` and a track-only credit owns
    // no release group. Their tracks remain reachable via the album they
    // appear on.
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM unified_artists ua
          WHERE EXISTS (SELECT 1 FROM unified_release_groups urg
                         WHERE urg.artist_id = ua.id)`,
      )
      .get() as { n: number };
    return row.n;
  }

  private countAlbums(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM unified_release_groups")
      .get() as { n: number };
    return row.n;
  }

  private countTracks(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM unified_tracks")
      .get() as { n: number };
    return row.n;
  }

  private getArtist(id: string): ArtistRow | null {
    return (
      (this.db
        .prepare(
          `SELECT ua.id, ua.name, ua.image_url,
                  (SELECT COUNT(*) FROM unified_release_groups urg WHERE urg.artist_id = ua.id) AS album_count
             FROM unified_artists ua
            WHERE ua.id = ?`,
        )
        .get(id) as ArtistRow | undefined) ?? null
    );
  }

  private getAlbum(id: string): AlbumRow | null {
    return (
      (this.db
        .prepare(
          `SELECT urg.id, urg.name, urg.artist_id, ua.name AS artist_name,
                  urg.image_url,
                  (SELECT COUNT(*) FROM unified_tracks ut
                     JOIN unified_releases ur ON ur.id = ut.release_id
                    WHERE ur.release_group_id = urg.id) AS track_count
             FROM unified_release_groups urg
             JOIN unified_artists ua ON ua.id = urg.artist_id
            WHERE urg.id = ?`,
        )
        .get(id) as AlbumRow | undefined) ?? null
    );
  }

  private listArtists(opts: BrowseOptions): BrowseResult {
    const total = this.countArtists();
    const rows = this.db
      .prepare(
        `SELECT ua.id, ua.name, ua.image_url,
                (SELECT COUNT(*) FROM unified_release_groups urg WHERE urg.artist_id = ua.id) AS album_count
           FROM unified_artists ua
          WHERE EXISTS (SELECT 1 FROM unified_release_groups urg
                         WHERE urg.artist_id = ua.id)
          ORDER BY ua.name COLLATE NOCASE
          LIMIT ? OFFSET ?`,
      )
      .all(this.limit(opts), opts.startIndex) as ArtistRow[];

    const xml = rows
      .map((r) =>
        buildContainer({
          objectId: artistObjectId(r.id),
          parentId: ARTISTS_ID,
          title: r.name,
          upnpClass: "object.container.person.musicArtist",
          childCount: r.album_count,
          albumArtUri: r.image_url,
          artist: r.name,
        }),
      )
      .join("");
    return {
      result: wrapDidl(xml),
      numberReturned: rows.length,
      totalMatches: total,
    };
  }

  private listAlbums(artistId: string | null, opts: BrowseOptions): BrowseResult {
    const where = artistId ? "WHERE urg.artist_id = ?" : "";
    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM unified_release_groups urg ${where}`,
      )
      .get(...(artistId ? [artistId] : [])) as { n: number };
    const total = totalRow.n;

    const rows = this.db
      .prepare(
        `SELECT urg.id, urg.name, urg.artist_id, ua.name AS artist_name,
                urg.image_url,
                (SELECT COUNT(*) FROM unified_tracks ut
                   JOIN unified_releases ur ON ur.id = ut.release_id
                  WHERE ur.release_group_id = urg.id) AS track_count
           FROM unified_release_groups urg
           JOIN unified_artists ua ON ua.id = urg.artist_id
           ${where}
          ORDER BY urg.year IS NULL, urg.year, urg.name COLLATE NOCASE
          LIMIT ? OFFSET ?`,
      )
      .all(...(artistId ? [artistId] : []), this.limit(opts), opts.startIndex) as AlbumRow[];

    const xml = rows
      .map((r) =>
        buildContainer({
          objectId: albumObjectId(r.id),
          parentId: artistId ? artistObjectId(artistId) : ALBUMS_ID,
          title: r.name,
          upnpClass: "object.container.album.musicAlbum",
          childCount: r.track_count,
          albumArtUri: albumArtUriFor(opts.baseUrl, r.image_url),
          artist: r.artist_name,
        }),
      )
      .join("");
    return {
      result: wrapDidl(xml),
      numberReturned: rows.length,
      totalMatches: total,
    };
  }

  private listTracks(
    artistId: string | null,
    albumId: string | null,
    opts: BrowseOptions,
  ): BrowseResult {
    const filters: string[] = [];
    const params: unknown[] = [];
    if (artistId) {
      filters.push("ut.artist_id = ?");
      params.push(artistId);
    }
    if (albumId) {
      filters.push("ur.release_group_id = ?");
      params.push(albumId);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM unified_tracks ut
           JOIN unified_releases ur ON ur.id = ut.release_id
           ${where}`,
      )
      .get(...params) as { n: number };
    const total = totalRow.n;

    const rows = this.db
      .prepare(
        `SELECT ut.id, ut.title, ut.duration_ms,
                ua.name AS artist_name,
                urg.name AS album_name, urg.image_url AS album_art,
                ts.format, ts.bitrate
           FROM unified_tracks ut
           JOIN unified_artists ua ON ua.id = ut.artist_id
           JOIN unified_releases ur ON ur.id = ut.release_id
           JOIN unified_release_groups urg ON urg.id = ur.release_group_id
           LEFT JOIN track_sources ts ON ts.unified_track_id = ut.id AND ts.preferred = 1
           ${where}
          ORDER BY ut.disc_number, ut.track_number, ut.title COLLATE NOCASE
          LIMIT ? OFFSET ?`,
      )
      .all(...params, this.limit(opts), opts.startIndex) as TrackRow[];

    const parentId = albumId
      ? albumObjectId(albumId)
      : artistId
        ? artistObjectId(artistId)
        : TRACKS_ID;

    const xml = rows
      .map((r) =>
        buildAudioItem({
          objectId: r.id,
          parentId,
          trackId: r.id,
          title: r.title,
          artist: r.artist_name,
          album: r.album_name,
          albumArtUri: albumArtUriFor(opts.baseUrl, r.album_art),
          durationSec: Math.floor((r.duration_ms ?? 0) / 1000),
          mimeType: mimeForFormat(r.format),
          streamUri: streamUri(opts.baseUrl, r.id),
          // DLNA.ORG_OP=01 indicates Range support; clients use it for seek.
          protocolInfoExtras: "DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000",
        }),
      )
      .join("");

    return {
      result: wrapDidl(xml),
      numberReturned: rows.length,
      totalMatches: total,
    };
  }

  private limit(opts: BrowseOptions): number {
    // UPnP convention: 0 = "as many as you can". Cap at 1000 so a buggy
    // client can't ask for the whole table in one shot.
    if (opts.requestedCount === 0) return 1000;
    return Math.min(opts.requestedCount, 1000);
  }
}

// Re-export for tests that want xmlEscape from this module surface area.
export { xmlEscape };
