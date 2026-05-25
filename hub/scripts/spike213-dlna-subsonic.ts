/**
 * Spike (#213): parallel DLNA ContentDirectory implementation backed by
 * Subsonic HTTP calls only — no DB access. Compared against the existing
 * DB-backed `DlnaObjectService` for correctness, latency, and round-trip
 * count.
 *
 * Run:
 *   pnpm --filter hub exec tsx scripts/spike213-dlna-subsonic.ts \
 *     --db /tmp/spike213.db \
 *     --subsonic-url http://localhost:26505 \
 *     --user admin --pass <pw>
 *
 * The DB is read-only here; the spike never writes. The Subsonic side
 * calls the live hub's `/rest/*` over loopback.
 */
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";

import {
  DlnaObjectService,
  ROOT_ID,
  MUSIC_ID,
  ARTISTS_ID,
  ALBUMS_ID,
  TRACKS_ID,
  artistObjectId,
  albumObjectId,
} from "../src/services/dlna-objects.js";
import { buildAudioItem, buildContainer, wrapDidl } from "../src/services/didl.js";
import { xmlEscape } from "../src/services/soap.js";
import {
  SubsonicClient,
  type SubsonicAlbum,
  type SubsonicArtist,
  type SubsonicSong,
} from "../src/adapters/subsonic.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

const stripArId = (id: string) => id.replace(/^ar/, "");
const stripAlId = (id: string) => id.replace(/^al/, "");
const stripTId = (id: string) => id.replace(/^t/, "");
const prefixAr = (id: string) => (id.startsWith("ar") ? id : `ar${id}`);
const prefixAl = (id: string) => (id.startsWith("al") ? id : `al${id}`);

function mimeForSuffix(suffix: string | undefined): string {
  switch ((suffix || "").toLowerCase()) {
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

function coverArtUri(baseUrl: string, coverArt: string | undefined): string | null {
  if (!coverArt) return null;
  return `${baseUrl}/rest/getCoverArt?id=${encodeURIComponent(coverArt)}`;
}

// ─── Instrumented Subsonic client ─────────────────────────────────────────

class InstrumentedSubsonic extends SubsonicClient {
  public calls: { method: string; ms: number }[] = [];
  reset() {
    this.calls = [];
  }
  private async track<T>(method: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.calls.push({ method, ms: performance.now() - t0 });
    }
  }
  override getArtists() {
    return this.track("getArtists", () => super.getArtists());
  }
  override getArtist(id: string) {
    return this.track("getArtist", () => super.getArtist(id));
  }
  override getAlbum(id: string) {
    return this.track("getAlbum", () => super.getAlbum(id));
  }
  override getAlbumList2(p: { type: string; size?: number; offset?: number }) {
    return this.track("getAlbumList2", () => super.getAlbumList2(p));
  }
  override getSong(id: string) {
    return this.track("getSong", () => super.getSong(id));
  }
  override search3(
    q: string,
    p?: { artistCount?: number; albumCount?: number; songCount?: number },
  ) {
    return this.track("search3", () => super.search3(q, p));
  }
}

// ─── Subsonic-backed DLNA implementation ──────────────────────────────────

interface BrowseOptions {
  startIndex: number;
  requestedCount: number;
  baseUrl: string;
}
interface BrowseResult {
  result: string;
  numberReturned: number;
  totalMatches: number;
}

class DlnaObjectServiceSubsonic {
  constructor(private readonly client: InstrumentedSubsonic) {}

  /** Flatten the `getArtists` index into a single sorted array. */
  private async allArtists(): Promise<SubsonicArtist[]> {
    const indices = await this.client.getArtists();
    const flat: SubsonicArtist[] = [];
    for (const idx of indices) for (const a of idx.artist) flat.push(a);
    // index order is already alpha by Subsonic spec
    return flat;
  }

  /**
   * Pull entire album list via getAlbumList2 in pages. Subsonic has no
   * "total" count — we keep going until a short page (<size). Worst case
   * for a 50k-album library at size=500: 100 round-trips.
   */
  private async allAlbums(opts: { artistId?: string }): Promise<SubsonicAlbum[]> {
    if (opts.artistId) {
      // Single call: getArtist returns all albums for that artist.
      const artist = await this.client.getArtist(opts.artistId);
      return artist.album ?? [];
    }
    const PAGE = 500;
    const out: SubsonicAlbum[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.client.getAlbumList2({
        type: "alphabeticalByArtist",
        size: PAGE,
        offset,
      });
      out.push(...page);
      if (page.length < PAGE) break;
    }
    return out;
  }

  async browse(
    objectId: string,
    flag: "BrowseMetadata" | "BrowseDirectChildren",
    opts: BrowseOptions,
  ): Promise<BrowseResult> {
    if (flag === "BrowseMetadata") return this.browseMetadata(objectId, opts);
    return this.browseChildren(objectId, opts);
  }

  private async browseMetadata(objectId: string, opts: BrowseOptions): Promise<BrowseResult> {
    if (objectId === ROOT_ID) {
      const xml = buildContainer({
        objectId: ROOT_ID,
        parentId: "-1",
        title: "Poutine",
        upnpClass: "object.container.storageFolder",
        childCount: 1,
      });
      return { result: wrapDidl(xml), numberReturned: 1, totalMatches: 1 };
    }
    if (objectId === MUSIC_ID) {
      return {
        result: wrapDidl(
          buildContainer({
            objectId: MUSIC_ID,
            parentId: ROOT_ID,
            title: "Music",
            upnpClass: "object.container.storageFolder",
            childCount: 3,
          }),
        ),
        numberReturned: 1,
        totalMatches: 1,
      };
    }
    if (objectId === ARTISTS_ID) {
      const artists = await this.allArtists();
      return {
        result: wrapDidl(
          buildContainer({
            objectId: ARTISTS_ID,
            parentId: MUSIC_ID,
            title: "Artists",
            upnpClass: "object.container.person.musicArtist",
            childCount: artists.length,
          }),
        ),
        numberReturned: 1,
        totalMatches: 1,
      };
    }
    if (objectId === ALBUMS_ID) {
      const albums = await this.allAlbums({});
      return {
        result: wrapDidl(
          buildContainer({
            objectId: ALBUMS_ID,
            parentId: MUSIC_ID,
            title: "Albums",
            upnpClass: "object.container.album.musicAlbum",
            childCount: albums.length,
          }),
        ),
        numberReturned: 1,
        totalMatches: 1,
      };
    }
    if (objectId === TRACKS_ID) {
      // Gap: Subsonic has no track-count endpoint. Would require summing
      // songCount across all albums — N+1 against album list.
      return {
        result: wrapDidl(
          buildContainer({
            objectId: TRACKS_ID,
            parentId: MUSIC_ID,
            title: "All Tracks",
            upnpClass: "object.container.storageFolder",
            childCount: -1,
          }),
        ),
        numberReturned: 1,
        totalMatches: 1,
      };
    }
    const mArtist = objectId.match(/^0\/music\/artist\/([^/]+)$/);
    if (mArtist) {
      const sid = prefixAr(mArtist[1]);
      const artist = await this.client.getArtist(sid);
      return {
        result: wrapDidl(
          buildContainer({
            objectId: artistObjectId(stripArId(artist.id)),
            parentId: ARTISTS_ID,
            title: artist.name,
            upnpClass: "object.container.person.musicArtist",
            childCount: artist.album?.length ?? artist.albumCount ?? 0,
            albumArtUri: artist.artistImageUrl,
            artist: artist.name,
          }),
        ),
        numberReturned: 1,
        totalMatches: 1,
      };
    }
    const mAlbum = objectId.match(/^0\/music\/album\/([^/]+)$/);
    if (mAlbum) {
      const sid = prefixAl(mAlbum[1]);
      const album = await this.client.getAlbum(sid);
      return {
        result: wrapDidl(
          buildContainer({
            objectId: albumObjectId(stripAlId(album.id)),
            parentId: ALBUMS_ID,
            title: album.name,
            upnpClass: "object.container.album.musicAlbum",
            childCount: album.songCount ?? album.song?.length ?? 0,
            albumArtUri: coverArtUri(opts.baseUrl, album.coverArt),
            artist: album.artist,
          }),
        ),
        numberReturned: 1,
        totalMatches: 1,
      };
    }
    return { result: wrapDidl(""), numberReturned: 0, totalMatches: 0 };
  }

  private async browseChildren(objectId: string, opts: BrowseOptions): Promise<BrowseResult> {
    if (objectId === ROOT_ID) {
      const xml = buildContainer({
        objectId: MUSIC_ID,
        parentId: ROOT_ID,
        title: "Music",
        upnpClass: "object.container.storageFolder",
        childCount: 3,
      });
      return { result: wrapDidl(xml), numberReturned: 1, totalMatches: 1 };
    }
    if (objectId === MUSIC_ID) {
      const [artists, albums] = await Promise.all([this.allArtists(), this.allAlbums({})]);
      const items = [
        buildContainer({
          objectId: ARTISTS_ID,
          parentId: MUSIC_ID,
          title: "Artists",
          upnpClass: "object.container.storageFolder",
          childCount: artists.length,
        }),
        buildContainer({
          objectId: ALBUMS_ID,
          parentId: MUSIC_ID,
          title: "Albums",
          upnpClass: "object.container.storageFolder",
          childCount: albums.length,
        }),
        buildContainer({
          objectId: TRACKS_ID,
          parentId: MUSIC_ID,
          title: "All Tracks",
          upnpClass: "object.container.storageFolder",
          childCount: -1, // gap
        }),
      ];
      return {
        result: wrapDidl(items.join("")),
        numberReturned: items.length,
        totalMatches: items.length,
      };
    }
    if (objectId === ARTISTS_ID) {
      const all = await this.allArtists();
      const sliced = all.slice(
        opts.startIndex,
        opts.startIndex + (opts.requestedCount || all.length),
      );
      const xml = sliced
        .map((a) =>
          buildContainer({
            objectId: artistObjectId(stripArId(a.id)),
            parentId: ARTISTS_ID,
            title: a.name,
            upnpClass: "object.container.person.musicArtist",
            childCount: a.albumCount ?? 0,
            albumArtUri: a.artistImageUrl,
            artist: a.name,
          }),
        )
        .join("");
      return { result: wrapDidl(xml), numberReturned: sliced.length, totalMatches: all.length };
    }
    if (objectId === ALBUMS_ID) {
      const all = await this.allAlbums({});
      const sliced = all.slice(
        opts.startIndex,
        opts.startIndex + (opts.requestedCount || all.length),
      );
      const xml = sliced
        .map((a) =>
          buildContainer({
            objectId: albumObjectId(stripAlId(a.id)),
            parentId: ALBUMS_ID,
            title: a.name,
            upnpClass: "object.container.album.musicAlbum",
            childCount: a.songCount ?? 0,
            albumArtUri: coverArtUri(opts.baseUrl, a.coverArt),
            artist: a.artist,
          }),
        )
        .join("");
      return { result: wrapDidl(xml), numberReturned: sliced.length, totalMatches: all.length };
    }
    if (objectId === TRACKS_ID) {
      // Gap: requires iterating every album to enumerate tracks. Skipped.
      return { result: wrapDidl(""), numberReturned: 0, totalMatches: -1 };
    }
    const mArtist = objectId.match(/^0\/music\/artist\/([^/]+)$/);
    if (mArtist) {
      const sid = prefixAr(mArtist[1]);
      const artist = await this.client.getArtist(sid);
      const albums = artist.album ?? [];
      const sliced = albums.slice(
        opts.startIndex,
        opts.startIndex + (opts.requestedCount || albums.length),
      );
      const xml = sliced
        .map((a) =>
          buildContainer({
            objectId: albumObjectId(stripAlId(a.id)),
            parentId: artistObjectId(stripArId(artist.id)),
            title: a.name,
            upnpClass: "object.container.album.musicAlbum",
            childCount: a.songCount ?? 0,
            albumArtUri: coverArtUri(opts.baseUrl, a.coverArt),
            artist: a.artist,
          }),
        )
        .join("");
      return { result: wrapDidl(xml), numberReturned: sliced.length, totalMatches: albums.length };
    }
    const mAlbum = objectId.match(/^0\/music\/album\/([^/]+)$/);
    if (mAlbum) {
      const sid = prefixAl(mAlbum[1]);
      const album = await this.client.getAlbum(sid);
      const songs = album.song ?? [];
      const sliced = songs.slice(
        opts.startIndex,
        opts.startIndex + (opts.requestedCount || songs.length),
      );
      const xml = sliced
        .map((s) =>
          buildAudioItem({
            objectId: stripTId(s.id),
            parentId: albumObjectId(stripAlId(album.id)),
            trackId: stripTId(s.id),
            title: s.title,
            artist: s.artist ?? "",
            album: album.name,
            albumArtUri: coverArtUri(opts.baseUrl, s.coverArt ?? album.coverArt),
            durationSec: s.duration ?? 0,
            mimeType: s.contentType ?? mimeForSuffix(s.suffix),
            streamUri: streamUri(opts.baseUrl, stripTId(s.id)),
            protocolInfoExtras: "DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000",
          }),
        )
        .join("");
      return { result: wrapDidl(xml), numberReturned: sliced.length, totalMatches: songs.length };
    }
    return { result: wrapDidl(""), numberReturned: 0, totalMatches: 0 };
  }

  /** Search via search3 — single call covers artists+albums+songs. */
  async search(query: string, opts: BrowseOptions): Promise<BrowseResult> {
    const r = await this.client.search3(query, {
      artistCount: 50,
      albumCount: 50,
      songCount: 100,
    });
    const parts: string[] = [];
    for (const a of r.artist ?? []) {
      parts.push(
        buildContainer({
          objectId: artistObjectId(stripArId(a.id)),
          parentId: ARTISTS_ID,
          title: a.name,
          upnpClass: "object.container.person.musicArtist",
          childCount: a.albumCount ?? 0,
        }),
      );
    }
    for (const a of r.album ?? []) {
      parts.push(
        buildContainer({
          objectId: albumObjectId(stripAlId(a.id)),
          parentId: ALBUMS_ID,
          title: a.name,
          upnpClass: "object.container.album.musicAlbum",
          childCount: a.songCount ?? 0,
          albumArtUri: coverArtUri(opts.baseUrl, a.coverArt),
          artist: a.artist,
        }),
      );
    }
    for (const s of r.song ?? []) {
      parts.push(
        buildAudioItem({
          objectId: stripTId(s.id),
          parentId: TRACKS_ID,
          trackId: stripTId(s.id),
          title: s.title,
          artist: s.artist ?? "",
          album: s.album ?? "",
          albumArtUri: coverArtUri(opts.baseUrl, s.coverArt),
          durationSec: s.duration ?? 0,
          mimeType: s.contentType ?? mimeForSuffix(s.suffix),
          streamUri: streamUri(opts.baseUrl, stripTId(s.id)),
          protocolInfoExtras: "DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000",
        }),
      );
    }
    const sliced = parts.slice(
      opts.startIndex,
      opts.startIndex + (opts.requestedCount || parts.length),
    );
    return {
      result: wrapDidl(sliced.join("")),
      numberReturned: sliced.length,
      totalMatches: parts.length,
    };
  }
}

// ─── Bench harness ────────────────────────────────────────────────────────

interface Row {
  case: string;
  dbMs: number;
  ssMs: number;
  ratio: string;
  rtCount: number;
  rtMethods: string;
  dbTotal: number;
  ssTotal: number;
  match: string;
}

/**
 * Normalize DIDL for diffing: strip whitespace between tags, sort attributes
 * inside each opening tag alphabetically. Field order within a container/item
 * differs between impls in defensible ways.
 */
function normalizeDidl(xml: string): string {
  return xml
    .replace(/>\s+</g, "><")
    .replace(/<([\w:]+)([^/>]*)>/g, (_m, tag: string, attrs: string) => {
      const pairs = [...attrs.matchAll(/(\w+(?::\w+)?)="([^"]*)"/g)].map(
        (m) => `${m[1]}="${m[2]}"`,
      );
      pairs.sort();
      return `<${tag}${pairs.length ? " " + pairs.join(" ") : ""}>`;
    });
}

/** Set-compare top-level container/item IDs (order may vary). */
function idSet(xml: string): Set<string> {
  const ids = new Set<string>();
  for (const m of xml.matchAll(/<(?:container|item)\s+id="([^"]+)"/g)) ids.add(m[1]);
  return ids;
}

async function main() {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      "subsonic-url": { type: "string" },
      user: { type: "string" },
      pass: { type: "string" },
      "base-url": { type: "string", default: "http://localhost:26505" },
      out: { type: "string" },
    },
  });
  if (!values.db || !values["subsonic-url"] || !values.user || !values.pass) {
    console.error(
      "usage: spike213-dlna-subsonic.ts --db <path> --subsonic-url <url> --user <u> --pass <p> [--base-url <url>] [--out <file>]",
    );
    process.exit(2);
  }

  const db = new Database(values.db, { readonly: true });
  const dbSvc = new DlnaObjectService(db);
  const client = new InstrumentedSubsonic({
    url: values["subsonic-url"]!,
    username: values.user!,
    password: values.pass!,
  });
  const ssSvc = new DlnaObjectServiceSubsonic(client);
  const baseUrl = values["base-url"]!;
  const opts = { startIndex: 0, requestedCount: 0, baseUrl };

  // Pick sample IDs from the DB.
  const sampleArtist = db
    .prepare(
      `SELECT ua.id FROM unified_artists ua
        WHERE EXISTS (SELECT 1 FROM unified_release_groups urg WHERE urg.artist_id = ua.id)
        ORDER BY (SELECT COUNT(*) FROM unified_release_groups urg WHERE urg.artist_id = ua.id) DESC
        LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  const sampleAlbum = db
    .prepare(
      `SELECT urg.id FROM unified_release_groups urg
        ORDER BY (SELECT COUNT(*) FROM unified_tracks ut
                    JOIN unified_releases ur ON ur.id = ut.release_id
                   WHERE ur.release_group_id = urg.id) DESC
        LIMIT 1`,
    )
    .get() as { id: string } | undefined;

  if (!sampleArtist || !sampleAlbum) {
    console.error("DB has no artists/albums to sample.");
    process.exit(1);
  }

  type Case = {
    name: string;
    objectId: string;
    flag: "BrowseDirectChildren" | "BrowseMetadata";
  };
  const cases: Case[] = [
    { name: "Browse ROOT children", objectId: ROOT_ID, flag: "BrowseDirectChildren" },
    { name: "Browse MUSIC children", objectId: MUSIC_ID, flag: "BrowseDirectChildren" },
    { name: "Browse ARTISTS children", objectId: ARTISTS_ID, flag: "BrowseDirectChildren" },
    { name: "Browse ALBUMS children", objectId: ALBUMS_ID, flag: "BrowseDirectChildren" },
    {
      name: "Browse artist children (top artist)",
      objectId: artistObjectId(sampleArtist.id),
      flag: "BrowseDirectChildren",
    },
    {
      name: "Browse album children (largest album)",
      objectId: albumObjectId(sampleAlbum.id),
      flag: "BrowseDirectChildren",
    },
    {
      name: "BrowseMetadata album",
      objectId: albumObjectId(sampleAlbum.id),
      flag: "BrowseMetadata",
    },
    {
      name: "BrowseMetadata artist",
      objectId: artistObjectId(sampleArtist.id),
      flag: "BrowseMetadata",
    },
  ];

  const rows: Row[] = [];

  for (const c of cases) {
    const dbStart = performance.now();
    const dbRes = dbSvc.browse(c.objectId, c.flag, opts);
    const dbMs = performance.now() - dbStart;

    client.reset();
    const ssStart = performance.now();
    const ssRes = await ssSvc.browse(c.objectId, c.flag, opts);
    const ssMs = performance.now() - ssStart;
    const callsForCase = [...client.calls];

    const dbIds = idSet(dbRes.result);
    const ssIds = idSet(ssRes.result);
    const idsMatch = dbIds.size === ssIds.size && [...dbIds].every((x) => ssIds.has(x));
    const normalizedMatch = normalizeDidl(dbRes.result) === normalizeDidl(ssRes.result);

    const methodsCount: Record<string, number> = {};
    for (const call of callsForCase) {
      methodsCount[call.method] = (methodsCount[call.method] ?? 0) + 1;
    }
    const rtMethods = Object.entries(methodsCount)
      .map(([m, n]) => `${m}×${n}`)
      .join(", ");

    rows.push({
      case: c.name,
      dbMs,
      ssMs,
      ratio: dbMs > 0 ? (ssMs / dbMs).toFixed(1) + "×" : "n/a",
      rtCount: callsForCase.length,
      rtMethods,
      dbTotal: dbRes.totalMatches,
      ssTotal: ssRes.totalMatches,
      match: normalizedMatch ? "exact" : idsMatch ? "ids" : "diff",
    });
  }

  // Search case
  {
    client.reset();
    const q = "love";
    const ssStart = performance.now();
    const ssRes = await ssSvc.search(q, opts);
    const ssMs = performance.now() - ssStart;
    rows.push({
      case: `search3 q="${q}"`,
      dbMs: 0,
      ssMs,
      ratio: "n/a",
      rtCount: client.calls.length,
      rtMethods: client.calls.map((c) => c.method).join(", "),
      dbTotal: -1,
      ssTotal: ssRes.totalMatches,
      match: "n/a (DB impl has no search)",
    });
  }

  // Output: markdown table.
  const header =
    "| Case | DB ms | Subsonic ms | Ratio | Round-trips | Methods | DB total | SS total | Match |\n" +
    "|---|--:|--:|--:|--:|---|--:|--:|---|";
  const body = rows
    .map(
      (r) =>
        `| ${r.case} | ${r.dbMs.toFixed(2)} | ${r.ssMs.toFixed(2)} | ${r.ratio} | ${r.rtCount} | ${r.rtMethods} | ${r.dbTotal} | ${r.ssTotal} | ${r.match} |`,
    )
    .join("\n");
  const out = `# DLNA-via-Subsonic spike (#213)\n\n${header}\n${body}\n`;
  if (values.out) {
    writeFileSync(values.out, out);
    console.error(`wrote ${values.out}`);
  }
  process.stdout.write(out);

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
