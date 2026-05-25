/**
 * Spike (#213): parallel DLNA ContentDirectory implementation backed by
 * Subsonic API calls over loopback HTTP — no direct DB access.
 *
 * This module exists so we can measure correctness and latency vs the
 * production `dlna-objects.ts` (DB-backed) implementation before
 * green-lighting the full re-architecture (#212). It is NOT wired into
 * the live `routes/dlna.ts` SOAP handler.
 *
 * Mapping (DLNA op → Subsonic call(s)):
 *   Browse root / music                     — static (no fetch)
 *   Browse "Artists"                        — getArtists
 *   Browse "Albums"                         — getAlbumList2?type=alphabeticalByName
 *   Browse "Tracks"                         — getAlbumList2 (alpha) + getAlbum per album (N+1)
 *   Browse artist/<id>                      — getArtist
 *   Browse album/<id>                       — getAlbum
 *   BrowseMetadata artist/<id>              — getArtist (drops album list, keeps header)
 *   BrowseMetadata album/<id>               — getAlbum  (drops song list, keeps header)
 *   Search                                  — search3
 *
 * Auth is straight `u+p` against the hub's own `/rest/*` endpoints. The
 * caller supplies a `SubsonicCaller` so the test harness can substitute
 * `app.inject(...)` for real HTTP if it wants finer measurement.
 */
import {
  ROOT_ID,
  MUSIC_ID,
  ARTISTS_ID,
  ALBUMS_ID,
  TRACKS_ID,
  parseObjectId,
  artistObjectId,
  albumObjectId,
  type BrowseOptions,
  type BrowseResult,
} from "./dlna-objects.js";
import { buildAudioItem, buildContainer, wrapDidl } from "./didl.js";
import { buildStreamUrl } from "./cast-tokens.js";

/**
 * Minimal Subsonic JSON client surface the spike needs. Implementations
 * are free to use `fetch(loopback)` or `app.inject()` — the latter avoids
 * a TCP round-trip but loses HTTP-layer cost in the measurement.
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

/** Stats collected per browse call. Useful for measurement assertions. */
export interface CallStats {
  /** Number of Subsonic round-trips made for this DLNA op. */
  roundTrips: number;
  /** Wall-clock ms spent inside Subsonic calls. */
  subsonicMs: number;
}

/** Strip the `ar`, `al`, or `t` prefix from a Subsonic-encoded id. */
function stripPrefix(id: string, prefix: string): string {
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function mimeForContentType(ct: string | undefined): string {
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

function coverArtUri(baseUrl: string, coverArtId: string | undefined): string | null {
  if (!coverArtId) return null;
  // Cover-art ids returned by Subsonic responses are already in the
  // `{instanceId}:{coverArtId}` shape expected by `/rest/getCoverArt`.
  return `${baseUrl}/rest/getCoverArt?id=${encodeURIComponent(coverArtId)}`;
}

export interface SubsonicDlnaOptions extends BrowseOptions {
  /** Records how many Subsonic calls and how much time each DLNA op took. */
  stats?: CallStats;
}

export class DlnaObjectServiceSubsonic {
  constructor(private readonly caller: SubsonicCaller) {}

  async browse(
    objectId: string,
    flag: "BrowseMetadata" | "BrowseDirectChildren",
    opts: SubsonicDlnaOptions,
  ): Promise<BrowseResult> {
    const parsed = parseObjectId(objectId);
    if (!parsed) return { result: wrapDidl(""), numberReturned: 0, totalMatches: 0 };
    if (flag === "BrowseMetadata") return this.browseMetadata(parsed, opts);
    return this.browseChildren(parsed, opts);
  }

  // ── BrowseDirectChildren ────────────────────────────────────────────────

  private async browseChildren(
    parsed: NonNullable<ReturnType<typeof parseObjectId>>,
    opts: SubsonicDlnaOptions,
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
              childCount: 3,
            }),
          ],
          opts,
        );
      case "music":
        // The static "Music" subtree has 3 buckets. We could fetch counts
        // from /rest/* but they're not load-bearing for the SOAP client
        // (most browsers treat childCount=-1 as "unknown" and just walk
        // in). Skip the round-trips.
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
            buildContainer({
              objectId: TRACKS_ID,
              parentId: MUSIC_ID,
              title: "All Tracks",
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
      case "tracks":
        return this.listAllTracks(opts);
      case "artist":
        return this.listAlbums(parsed.id!, opts);
      case "album":
        return this.listTracks(parsed.id!, opts);
    }
  }

  // ── BrowseMetadata ─────────────────────────────────────────────────────

  private async browseMetadata(
    parsed: NonNullable<ReturnType<typeof parseObjectId>>,
    opts: SubsonicDlnaOptions,
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
          childCount: 3,
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
      case "tracks":
        xml = buildContainer({
          objectId: TRACKS_ID,
          parentId: MUSIC_ID,
          title: "All Tracks",
          upnpClass: "object.container.storageFolder",
          childCount: -1,
        });
        break;
      case "artist": {
        const artist = await this.fetchArtist(parsed.id!, opts);
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
        const album = await this.fetchAlbum(parsed.id!, opts);
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

  // ── List builders ──────────────────────────────────────────────────────

  private async listArtists(opts: SubsonicDlnaOptions): Promise<BrowseResult> {
    const body = await this.callTracked("/rest/getArtists", {}, opts);
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
    opts: SubsonicDlnaOptions,
  ): Promise<BrowseResult> {
    if (rawArtistId) {
      // Artist subtree — single call returns the album list.
      const body = await this.callTracked(
        "/rest/getArtist",
        { id: `ar${rawArtistId}` },
        opts,
      );
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

    // Global "Albums" — paginate via getAlbumList2.
    const size = opts.requestedCount > 0 ? Math.min(opts.requestedCount, 500) : 500;
    const body = await this.callTracked(
      "/rest/getAlbumList2",
      {
        type: "alphabeticalByName",
        size: String(size),
        offset: String(opts.startIndex),
      },
      opts,
    );
    const list = ((body["subsonic-response"].albumList2 as { album?: SubsonicAlbumSummary[] } | undefined)
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
    // Subsonic doesn't return a total. Caller pages until empty.
    return { result: wrapDidl(xml), numberReturned: list.length, totalMatches: -1 };
  }

  private async listTracks(
    rawAlbumId: string,
    opts: SubsonicDlnaOptions,
  ): Promise<BrowseResult> {
    const album = await this.fetchAlbum(rawAlbumId, opts);
    if (!album) return { result: wrapDidl(""), numberReturned: 0, totalMatches: 0 };
    const total = album.song.length;
    const sliced = album.song.slice(
      opts.startIndex,
      opts.startIndex + (opts.requestedCount || total),
    );
    const parent = albumObjectId(rawAlbumId);
    const xml = sliced
      .map((s) =>
        buildAudioItem({
          objectId: stripPrefix(s.id, "t"),
          parentId: parent,
          trackId: stripPrefix(s.id, "t"),
          title: s.title,
          artist: s.artist,
          album: s.album,
          albumArtUri: coverArtUri(opts.baseUrl, s.coverArt),
          durationSec: s.duration ?? 0,
          mimeType: mimeForContentType(s.contentType),
          streamUri: streamUri(opts, stripPrefix(s.id, "t")),
          protocolInfoExtras:
            "DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000",
        }),
      )
      .join("");
    return { result: wrapDidl(xml), numberReturned: sliced.length, totalMatches: total };
  }

  /**
   * "All Tracks" via Subsonic is the lossy case. There is no global track
   * list endpoint. The cheap-correct option is to walk getAlbumList2 then
   * fan out to getAlbum — an unavoidable N+1 where N = album count. For
   * the spike we cap the walk at a page so latency stays bounded; the
   * production refactor should treat this view as "best-effort or drop"
   * and document the gap.
   */
  private async listAllTracks(opts: SubsonicDlnaOptions): Promise<BrowseResult> {
    const pageSize = opts.requestedCount > 0 ? Math.min(opts.requestedCount, 100) : 100;
    const albumsBody = await this.callTracked(
      "/rest/getAlbumList2",
      {
        type: "alphabeticalByName",
        size: String(Math.ceil(pageSize / 4)), // assume ~4 tracks/album
        offset: "0",
      },
      opts,
    );
    const albums =
      ((albumsBody["subsonic-response"].albumList2 as { album?: SubsonicAlbumSummary[] } | undefined)
        ?.album) ?? [];
    const songs: SubsonicSong[] = [];
    for (const a of albums) {
      const albumBody = await this.callTracked(
        "/rest/getAlbum",
        { id: a.id },
        opts,
      );
      const full = albumBody["subsonic-response"].album as SubsonicAlbum | undefined;
      if (full?.song) songs.push(...full.song);
      if (songs.length >= pageSize) break;
    }
    const sliced = songs.slice(opts.startIndex, opts.startIndex + pageSize);
    const xml = sliced
      .map((s) =>
        buildAudioItem({
          objectId: stripPrefix(s.id, "t"),
          parentId: TRACKS_ID,
          trackId: stripPrefix(s.id, "t"),
          title: s.title,
          artist: s.artist,
          album: s.album,
          albumArtUri: coverArtUri(opts.baseUrl, s.coverArt),
          durationSec: s.duration ?? 0,
          mimeType: mimeForContentType(s.contentType),
          streamUri: streamUri(opts, stripPrefix(s.id, "t")),
          protocolInfoExtras:
            "DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000",
        }),
      )
      .join("");
    return { result: wrapDidl(xml), numberReturned: sliced.length, totalMatches: -1 };
  }

  /** DLNA `Search` mapped to Subsonic search3. */
  async search(
    query: string,
    opts: SubsonicDlnaOptions,
  ): Promise<BrowseResult> {
    const size = opts.requestedCount > 0 ? Math.min(opts.requestedCount, 100) : 50;
    const body = await this.callTracked(
      "/rest/search3",
      {
        query,
        artistCount: String(size),
        albumCount: String(size),
        songCount: String(size),
      },
      opts,
    );
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
      items.push(
        buildAudioItem({
          objectId: stripPrefix(s.id, "t"),
          parentId: TRACKS_ID,
          trackId: stripPrefix(s.id, "t"),
          title: s.title,
          artist: s.artist,
          album: s.album,
          albumArtUri: coverArtUri(opts.baseUrl, s.coverArt),
          durationSec: s.duration ?? 0,
          mimeType: mimeForContentType(s.contentType),
          streamUri: streamUri(opts, stripPrefix(s.id, "t")),
          protocolInfoExtras:
            "DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000",
        }),
      );
    }
    return {
      result: wrapDidl(items.join("")),
      numberReturned: items.length,
      totalMatches: items.length,
    };
  }

  // ── Internal fetch helpers (track stats) ───────────────────────────────

  private async fetchArtist(
    rawId: string,
    opts: SubsonicDlnaOptions,
  ): Promise<SubsonicArtist | null> {
    const body = await this.callTracked(
      "/rest/getArtist",
      { id: `ar${rawId}` },
      opts,
    );
    return (body["subsonic-response"].artist as SubsonicArtist | undefined) ?? null;
  }

  private async fetchAlbum(
    rawId: string,
    opts: SubsonicDlnaOptions,
  ): Promise<SubsonicAlbum | null> {
    const body = await this.callTracked(
      "/rest/getAlbum",
      { id: `al${rawId}` },
      opts,
    );
    return (body["subsonic-response"].album as SubsonicAlbum | undefined) ?? null;
  }

  private async callTracked(
    endpoint: string,
    params: Record<string, string>,
    opts: SubsonicDlnaOptions,
  ): Promise<SubsonicResponse> {
    const start = performance.now();
    try {
      return await this.caller.call(endpoint, params);
    } finally {
      if (opts.stats) {
        opts.stats.roundTrips += 1;
        opts.stats.subsonicMs += performance.now() - start;
      }
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
}
