/**
 * DLNA ContentDirectory object hierarchy backed by the hub's own Subsonic
 * API (#219, Phase 5 of #212).
 *
 * No direct database access. Every browse / search call resolves through a
 * `SubsonicCaller` — typically an in-process `app.inject()` wrapper, but
 * the interface is HTTP-shaped so a deployment split (Player as a separate
 * process talking to the Hub over loopback fetch) is a swap of the caller,
 * not a rewrite of this module.
 *
 * Object IDs are deterministic strings so DLNA clients (notably Windows
 * Media Player) can cache them across hub restarts without breaking. They
 * survive resync because they're keyed on `unified_*.id` UUIDs (the Subsonic
 * `ar`/`al`/`t` prefix is stripped on the way in and re-added on outbound
 * calls).
 *
 * Tree:
 *
 *   "0"                                  root
 *     "0/music"                          Music
 *       "0/music/artists"                All Artists
 *         "0/music/artist/<unified_artist_id>"        one artist
 *           — contains release groups for that artist
 *       "0/music/albums"                 All Albums (release groups)
 *         "0/music/album/<unified_release_group_id>"  one album
 *           — contains tracks across all releases in the group
 *
 * "All Tracks" (a global flat track enumeration) is intentionally NOT
 * exposed: Subsonic has no `getTracks` endpoint, and the only way to
 * synthesize it on top of `getAlbumList2 + getAlbum` is an N+1 fan-out.
 * Per spike #213 recommendation we drop the container. WMP / Kodi / VLC /
 * BubbleUPnP all default to entering Artists or Albums anyway. A future
 * OpenSubsonic `getSongs` extension (#214 survey) would let us add it back
 * cheaply; until then this is a documented gap.
 *
 * Release-level (edition) browsing is also not exposed — `unified_release_groups`
 * is the natural "album" object for DLNA clients.
 */
import { buildAudioItem, buildContainer, wrapDidl } from "./didl.js";
import { xmlEscape } from "./soap.js";
import { buildStreamUrl } from "./cast-tokens.js";

export const ROOT_ID = "0";
export const MUSIC_ID = "0/music";
export const ARTISTS_ID = "0/music/artists";
export const ALBUMS_ID = "0/music/albums";

export type ObjectKind =
  | "root"
  | "music"
  | "artists"
  | "albums"
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
  /**
   * Cast-token signer (#218). `res@uri` is a self-contained
   * `${baseUrl}/rest/stream.view?id=…&castToken=…&dlna=1` URL so the DLNA
   * renderer pulls bytes directly from the Hub Subsonic endpoint. No
   * Player relay, no per-renderer credentials.
   */
  castSecret: Buffer;
  /**
   * Pseudo-user the DLNA stream activity is attributed to (typically the
   * owner). Travels embedded in the cast token.
   */
  username: string;
  /**
   * Cast-token TTL in seconds for DIDL-emitted URLs. Some renderers cache
   * Browse responses for a while before fetching `res@uri`, so default
   * generously. Falls back to the cast-token DEFAULT_TTL_SEC (1h) when
   * omitted.
   */
  ttlSec?: number;
}

export interface BrowseResult {
  /** DIDL-Lite XML payload (already wrapped in `<DIDL-Lite>`). */
  result: string;
  /** Number of objects returned in this response. */
  numberReturned: number;
  /**
   * Total number of child objects (for pagination). `-1` means "unknown" —
   * Subsonic `getAlbumList2` does not return a total, and UPnP clients
   * tolerate -1 by walking the pager until they get a short page.
   */
  totalMatches: number;
}

/**
 * Minimal Subsonic JSON client surface the DLNA service needs. Production
 * uses an `app.inject()`-backed implementation (in-process loopback, no TCP).
 * Tests substitute fixture or mock callers.
 */
export interface SubsonicCaller {
  /** Returns the decoded JSON `subsonic-response` body. Throws on non-200. */
  call(endpoint: string, params: Record<string, string>): Promise<SubsonicResponse>;
}

export interface SubsonicResponse {
  "subsonic-response": Record<string, unknown> & {
    status: "ok" | "failed";
    error?: { code: number; message: string };
  };
}

interface SubsonicArtistIndex {
  ignoredArticles: string;
  index: Array<{
    name: string;
    artist: Array<{
      id: string;
      name: string;
      albumCount?: number;
      coverArt?: string;
    }>;
  }>;
}

interface SubsonicArtist {
  id: string;
  name: string;
  albumCount: number;
  coverArt?: string;
  album: SubsonicAlbumSummary[];
}

interface SubsonicAlbumSummary {
  id: string;
  name: string;
  artist: string;
  artistId: string;
  coverArt?: string;
  songCount: number;
  year?: number;
}

interface SubsonicAlbum extends SubsonicAlbumSummary {
  song: SubsonicSong[];
}

interface SubsonicSong {
  id: string;
  title: string;
  album: string;
  artist: string;
  albumId?: string;
  artistId?: string;
  coverArt?: string;
  duration?: number;
  bitRate?: number;
  contentType?: string;
  suffix?: string;
  track?: number;
  discNumber?: number;
}

interface SubsonicSearch3 {
  artist?: Array<{ id: string; name: string; albumCount?: number; coverArt?: string }>;
  album?: SubsonicAlbumSummary[];
  song?: SubsonicSong[];
}

/** Strip the `ar`, `al`, or `t` prefix from a Subsonic-encoded id. */
function stripPrefix(id: string, prefix: string): string {
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function mimeForContentType(ct: string | undefined): string {
  // Subsonic returns per-track Content-Type for the source file (mp3 →
  // audio/mpeg, flac → audio/flac, …). Fall back to audio/mpeg when the
  // upstream omits it — Windows Media Player legacy needs something here.
  return ct && ct.length > 0 ? ct : "audio/mpeg";
}

function streamUri(opts: BrowseOptions, unifiedTrackId: string): string {
  return buildStreamUrl({
    lanUrl: opts.baseUrl,
    castSecret: opts.castSecret,
    unifiedTrackId,
    username: opts.username,
    ttlSec: opts.ttlSec,
    client: "poutine-dlna",
    dlna: true,
  });
}

function coverArtUri(baseUrl: string, coverArtId: string | undefined | null): string | null {
  if (!coverArtId) return null;
  // Cover-art ids returned by Subsonic responses are already in the
  // `{instanceId}:{coverArtId}` shape expected by `/rest/getCoverArt`.
  return `${baseUrl}/rest/getCoverArt?id=${encodeURIComponent(coverArtId)}`;
}

const DLNA_PROTOCOL_INFO_EXTRAS =
  "DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000";

export class DlnaObjectService {
  constructor(private readonly caller: SubsonicCaller) {}

  /** ContentDirectory `Browse` (BrowseDirectChildren or BrowseMetadata). */
  async browse(
    objectId: string,
    browseFlag: "BrowseMetadata" | "BrowseDirectChildren",
    opts: BrowseOptions,
  ): Promise<BrowseResult> {
    const parsed = parseObjectId(objectId);
    if (!parsed) {
      return { result: wrapDidl(""), numberReturned: 0, totalMatches: 0 };
    }
    if (browseFlag === "BrowseMetadata") {
      return this.browseMetadata(parsed, opts);
    }
    return this.browseChildren(parsed, opts);
  }

  /** ContentDirectory `Search`. Maps to Subsonic search3. */
  async search(query: string, opts: BrowseOptions): Promise<BrowseResult> {
    const size = opts.requestedCount > 0 ? Math.min(opts.requestedCount, 100) : 50;
    const body = await this.caller.call("/rest/search3", {
      query,
      artistCount: String(size),
      albumCount: String(size),
      songCount: String(size),
    });
    const res = (body["subsonic-response"].searchResult3 as SubsonicSearch3 | undefined) ?? {};
    const items: string[] = [];
    for (const a of res.artist ?? []) {
      items.push(
        buildContainer({
          objectId: artistObjectId(stripPrefix(a.id, "ar")),
          parentId: ARTISTS_ID,
          title: a.name,
          upnpClass: "object.container.person.musicArtist",
          childCount: a.albumCount ?? -1,
          albumArtUri: coverArtUri(opts.baseUrl, a.coverArt),
          artist: a.name,
        }),
      );
    }
    for (const al of res.album ?? []) {
      items.push(
        buildContainer({
          objectId: albumObjectId(stripPrefix(al.id, "al")),
          parentId: ALBUMS_ID,
          title: al.name,
          upnpClass: "object.container.album.musicAlbum",
          childCount: al.songCount,
          albumArtUri: coverArtUri(opts.baseUrl, al.coverArt),
          artist: al.artist,
        }),
      );
    }
    for (const s of res.song ?? []) {
      items.push(this.songItem(s, /*parentId*/ ALBUMS_ID, opts));
    }
    return {
      result: wrapDidl(items.join("")),
      numberReturned: items.length,
      totalMatches: items.length,
    };
  }

  // ── BrowseMetadata ─────────────────────────────────────────────────────

  private async browseMetadata(
    parsed: ParsedObjectId,
    opts: BrowseOptions,
  ): Promise<BrowseResult> {
    let xml = "";
    switch (parsed.kind) {
      case "root":
        xml = buildContainer({
          objectId: ROOT_ID,
          parentId: "-1",
          title: "Poutine",
          upnpClass: "object.container.storageFolder",
          childCount: 1,
        });
        break;
      case "music":
        xml = buildContainer({
          objectId: MUSIC_ID,
          parentId: ROOT_ID,
          title: "Music",
          upnpClass: "object.container.storageFolder",
          childCount: 2,
        });
        break;
      case "artists":
        xml = buildContainer({
          objectId: ARTISTS_ID,
          parentId: MUSIC_ID,
          title: "Artists",
          upnpClass: "object.container.person.musicArtist",
          childCount: -1,
        });
        break;
      case "albums":
        xml = buildContainer({
          objectId: ALBUMS_ID,
          parentId: MUSIC_ID,
          title: "Albums",
          upnpClass: "object.container.album.musicAlbum",
          childCount: -1,
        });
        break;
      case "artist": {
        const artist = await this.fetchArtist(parsed.id!);
        if (!artist) break;
        xml = buildContainer({
          objectId: artistObjectId(parsed.id!),
          parentId: ARTISTS_ID,
          title: artist.name,
          upnpClass: "object.container.person.musicArtist",
          childCount: artist.albumCount,
          albumArtUri: coverArtUri(opts.baseUrl, artist.coverArt),
          artist: artist.name,
        });
        break;
      }
      case "album": {
        const album = await this.fetchAlbum(parsed.id!);
        if (!album) break;
        xml = buildContainer({
          objectId: albumObjectId(parsed.id!),
          parentId: ALBUMS_ID,
          title: album.name,
          upnpClass: "object.container.album.musicAlbum",
          childCount: album.song.length,
          albumArtUri: coverArtUri(opts.baseUrl, album.coverArt),
          artist: album.artist,
        });
        break;
      }
    }
    return { result: wrapDidl(xml), numberReturned: xml ? 1 : 0, totalMatches: xml ? 1 : 0 };
  }

  // ── BrowseDirectChildren ───────────────────────────────────────────────

  private async browseChildren(
    parsed: ParsedObjectId,
    opts: BrowseOptions,
  ): Promise<BrowseResult> {
    switch (parsed.kind) {
      case "root":
        return this.staticChildren(
          [
            buildContainer({
              objectId: MUSIC_ID,
              parentId: ROOT_ID,
              title: "Music",
              upnpClass: "object.container.storageFolder",
              childCount: 2,
            }),
          ],
          opts,
        );
      case "music":
        // Static "Music" subtree. childCount=-1 (unknown) lets us skip the
        // round-trips Subsonic would need to compute exact counts; every UPnP
        // client we care about tolerates -1 and just walks in.
        return this.staticChildren(
          [
            buildContainer({
              objectId: ARTISTS_ID,
              parentId: MUSIC_ID,
              title: "Artists",
              upnpClass: "object.container.storageFolder",
              childCount: -1,
            }),
            buildContainer({
              objectId: ALBUMS_ID,
              parentId: MUSIC_ID,
              title: "Albums",
              upnpClass: "object.container.storageFolder",
              childCount: -1,
            }),
          ],
          opts,
        );
      case "artists":
        return this.listArtists(opts);
      case "albums":
        return this.listAlbums(null, opts);
      case "artist":
        return this.listAlbums(parsed.id!, opts);
      case "album":
        return this.listTracks(parsed.id!, opts);
    }
  }

  // ── List builders ──────────────────────────────────────────────────────

  private async listArtists(opts: BrowseOptions): Promise<BrowseResult> {
    const body = await this.caller.call("/rest/getArtists", {});
    const idx = (body["subsonic-response"].artists as SubsonicArtistIndex | undefined) ?? {
      ignoredArticles: "",
      index: [],
    };
    const all = idx.index.flatMap((g) => g.artist);
    const total = all.length;
    const sliced = all.slice(opts.startIndex, opts.startIndex + (opts.requestedCount || all.length));
    const xml = sliced
      .map((a) =>
        buildContainer({
          objectId: artistObjectId(stripPrefix(a.id, "ar")),
          parentId: ARTISTS_ID,
          title: a.name,
          upnpClass: "object.container.person.musicArtist",
          childCount: a.albumCount ?? -1,
          albumArtUri: coverArtUri(opts.baseUrl, a.coverArt),
          artist: a.name,
        }),
      )
      .join("");
    return { result: wrapDidl(xml), numberReturned: sliced.length, totalMatches: total };
  }

  private async listAlbums(
    rawArtistId: string | null,
    opts: BrowseOptions,
  ): Promise<BrowseResult> {
    if (rawArtistId) {
      // Artist subtree — single call returns the album list ordered
      // year DESC, name (Subsonic getArtist).
      const body = await this.caller.call("/rest/getArtist", { id: `ar${rawArtistId}` });
      const artist = body["subsonic-response"].artist as SubsonicArtist | undefined;
      if (!artist) {
        return { result: wrapDidl(""), numberReturned: 0, totalMatches: 0 };
      }
      const total = artist.album?.length ?? 0;
      const sliced = (artist.album ?? []).slice(
        opts.startIndex,
        opts.startIndex + (opts.requestedCount || total),
      );
      const xml = sliced
        .map((a) =>
          buildContainer({
            objectId: albumObjectId(stripPrefix(a.id, "al")),
            parentId: artistObjectId(rawArtistId),
            title: a.name,
            upnpClass: "object.container.album.musicAlbum",
            childCount: a.songCount,
            albumArtUri: coverArtUri(opts.baseUrl, a.coverArt),
            artist: a.artist,
          }),
        )
        .join("");
      return { result: wrapDidl(xml), numberReturned: sliced.length, totalMatches: total };
    }

    // Global "Albums" — paginate via getAlbumList2. Subsonic doesn't return
    // a total in this response, so totalMatches stays -1 and the client
    // walks the pager until it gets a short page.
    const size = opts.requestedCount > 0 ? Math.min(opts.requestedCount, 500) : 500;
    const body = await this.caller.call("/rest/getAlbumList2", {
      type: "alphabeticalByName",
      size: String(size),
      offset: String(opts.startIndex),
    });
    const list =
      ((body["subsonic-response"].albumList2 as { album?: SubsonicAlbumSummary[] } | undefined)
        ?.album) ?? [];
    const xml = list
      .map((a) =>
        buildContainer({
          objectId: albumObjectId(stripPrefix(a.id, "al")),
          parentId: ALBUMS_ID,
          title: a.name,
          upnpClass: "object.container.album.musicAlbum",
          childCount: a.songCount,
          albumArtUri: coverArtUri(opts.baseUrl, a.coverArt),
          artist: a.artist,
        }),
      )
      .join("");
    return { result: wrapDidl(xml), numberReturned: list.length, totalMatches: -1 };
  }

  private async listTracks(rawAlbumId: string, opts: BrowseOptions): Promise<BrowseResult> {
    const album = await this.fetchAlbum(rawAlbumId);
    if (!album) return { result: wrapDidl(""), numberReturned: 0, totalMatches: 0 };
    const total = album.song.length;
    const sliced = album.song.slice(
      opts.startIndex,
      opts.startIndex + (opts.requestedCount || total),
    );
    const parent = albumObjectId(rawAlbumId);
    const xml = sliced.map((s) => this.songItem(s, parent, opts)).join("");
    return { result: wrapDidl(xml), numberReturned: sliced.length, totalMatches: total };
  }

  // ── Subsonic helpers ──────────────────────────────────────────────────

  private async fetchArtist(rawId: string): Promise<SubsonicArtist | null> {
    const body = await this.caller.call("/rest/getArtist", { id: `ar${rawId}` });
    return (body["subsonic-response"].artist as SubsonicArtist | undefined) ?? null;
  }

  private async fetchAlbum(rawId: string): Promise<SubsonicAlbum | null> {
    const body = await this.caller.call("/rest/getAlbum", { id: `al${rawId}` });
    return (body["subsonic-response"].album as SubsonicAlbum | undefined) ?? null;
  }

  private songItem(s: SubsonicSong, parentId: string, opts: BrowseOptions): string {
    const trackId = stripPrefix(s.id, "t");
    return buildAudioItem({
      objectId: trackId,
      parentId,
      trackId,
      title: s.title,
      artist: s.artist,
      album: s.album,
      albumArtUri: coverArtUri(opts.baseUrl, s.coverArt),
      durationSec: s.duration ?? 0,
      mimeType: mimeForContentType(s.contentType),
      streamUri: streamUri(opts, trackId),
      // DLNA.ORG_OP=01 indicates Range support; clients use it for seek.
      protocolInfoExtras: DLNA_PROTOCOL_INFO_EXTRAS,
    });
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
}

// Re-export for tests that want xmlEscape from this module surface area.
export { xmlEscape };
