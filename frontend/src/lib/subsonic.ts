import { md5 } from "js-md5";
import { getSubsonicCreds, clearTokens } from "./api.js";

const SUBSONIC_VERSION = "1.16.1";
const CLIENT = "poutine";

// Subsonic/OpenSubsonic credential-related error codes. Code 50 (not authorized
// for operation) is authorization, not authentication, and must NOT redirect.
// Code 10 (required parameter missing) lands here when the SPA's stored creds
// were cleared/never set — treat as "not logged in".
const AUTH_ERROR_CODES = new Set<number>([10, 40, 41, 42, 43, 44]);

export function isAuthErrorCode(code: unknown): boolean {
  return typeof code === "number" && AUTH_ERROR_CODES.has(code);
}

// Centralizes the "stored creds are no good, send the user back to /login"
// path. Idempotent: calling it from the /login page is a no-op so we don't
// thrash on auth-error toasts during login itself.
function redirectToLogin(): void {
  clearTokens();
  if (window.location.pathname !== "/login") {
    window.location.replace("/login");
  }
}

/**
 * Build the Subsonic u+t+s auth params for one request.
 * Salt is fresh per call so the URL/request can't be replayed at scale.
 * Returns null when the user isn't logged in.
 */
function authParams(): URLSearchParams | null {
  return authParamsWithSalt(freshSalt());
}

function freshSalt(): string {
  const saltBytes = new Uint8Array(8);
  crypto.getRandomValues(saltBytes);
  return Array.from(saltBytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function authParamsWithSalt(salt: string): URLSearchParams | null {
  const creds = getSubsonicCreds();
  if (!creds) return null;
  const token = md5(creds.password + salt);
  return new URLSearchParams({
    u: creds.username,
    t: token,
    s: salt,
    v: SUBSONIC_VERSION,
    c: CLIENT,
  });
}

// Stable per-session salt for cover-art URLs. Reusing a salt is acceptable
// here: if it were fresh per call, every render would produce a new <img src>
// and the browser would re-fetch getCoverArt in a tight loop. A stable URL
// also lets the HTTP cache do its job. (#112)
const ART_SALT = freshSalt();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SubsonicArtist {
  id: string;
  name: string;
  albumCount: number;
  coverArt?: string;
  shareId?: string;
}

export interface SubsonicAlbum {
  id: string;
  name: string;
  artist: string;
  artistId: string;
  coverArt?: string;
  songCount: number;
  year?: number;
  genre?: string;
  shareId?: string;
}

export interface SubsonicSong {
  id: string;
  title: string;
  album: string;
  albumId: string;
  artist: string;
  artistId: string;
  track?: number;
  discNumber?: number;
  /** Duration in milliseconds (converted from Subsonic's seconds) */
  durationMs: number;
  coverArt?: string;
  genre?: string;
  bitRate?: number;
  suffix?: string;
  sourceInstance?: string;
  // Additional metadata for debugging (Issue #42)
  year?: number;
  contentType?: string;
  size?: number;
  path?: string;
  channelCount?: number;
  samplingRate?: number;
  bitDepth?: number;
  sortName?: string;
  musicBrainzId?: string;
  comment?: string;
  bpm?: number;
}

export interface SubsonicArtistDetail extends SubsonicArtist {
  album: SubsonicAlbum[];
}

export interface SubsonicAlbumDetail extends SubsonicAlbum {
  songs: SubsonicSong[];
}

export interface SubsonicSearchResults {
  artists: SubsonicArtist[];
  albums: SubsonicAlbum[];
  songs: SubsonicSong[];
}

export class SubsonicError extends Error {
  code: number;
  constructor(message: string, code = 0) {
    super(message);
    this.name = "SubsonicError";
    this.code = code;
  }
}

// ── Raw API types (internal) ──────────────────────────────────────────────────

interface RawArtist {
  id: string;
  name: string;
  albumCount?: number;
  coverArt?: string;
  shareId?: string;
}

interface RawAlbum {
  id: string;
  name: string;
  artist?: string;
  artistId?: string;
  coverArt?: string;
  songCount?: number;
  year?: number;
  genre?: string;
  song?: RawSong[];
  shareId?: string;
}

interface RawSong {
  id: string;
  title: string;
  album?: string;
  albumId?: string;
  artist?: string;
  artistId?: string;
  track?: number;
  discNumber?: number;
  duration?: number;
  coverArt?: string;
  genre?: string;
  bitRate?: number;
  suffix?: string;
  sourceInstance?: string;
  // Additional metadata for debugging (Issue #42)
  year?: number;
  contentType?: string;
  size?: number;
  path?: string;
  channelCount?: number;
  samplingRate?: number;
  bitDepth?: number;
  sortName?: string;
  musicBrainzId?: string;
  comment?: string;
  bpm?: number;
}

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseAlbum(raw: RawAlbum): SubsonicAlbum {
  return {
    id: raw.id,
    name: raw.name,
    artist: raw.artist ?? "",
    artistId: raw.artistId ?? "",
    coverArt: raw.coverArt,
    songCount: raw.songCount ?? 0,
    year: raw.year,
    genre: raw.genre,
    shareId: raw.shareId,
  };
}

function parseSong(raw: RawSong): SubsonicSong {
  return {
    id: raw.id,
    title: raw.title,
    album: raw.album ?? "",
    albumId: raw.albumId ?? "",
    artist: raw.artist ?? "",
    artistId: raw.artistId ?? "",
    track: raw.track,
    discNumber: raw.discNumber,
    durationMs: (raw.duration ?? 0) * 1000,
    coverArt: raw.coverArt,
    genre: raw.genre,
    bitRate: raw.bitRate,
    suffix: raw.suffix,
    sourceInstance: raw.sourceInstance,
    // Additional metadata for debugging (Issue #42)
    year: raw.year,
    contentType: raw.contentType,
    size: raw.size,
    path: raw.path,
    channelCount: raw.channelCount,
    samplingRate: raw.samplingRate,
    bitDepth: raw.bitDepth,
    sortName: raw.sortName,
    musicBrainzId: raw.musicBrainzId,
    comment: raw.comment,
    bpm: raw.bpm,
  };
}

// ── Base fetch ────────────────────────────────────────────────────────────────

async function subsonicFetch<T>(
  endpoint: string,
  extra?: Record<string, string>,
): Promise<T> {
  const params = authParams();
  if (!params) {
    // No stored Subsonic creds — typically the upgrade path from a
    // pre-#106 install where the JWT survived but `subsonicUser`/`subsonicPass`
    // were never written. Redirect to /login same as a 40/41/etc. response.
    redirectToLogin();
    throw new SubsonicError("Not authenticated", 10);
  }
  params.set("f", "json");
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      params.set(k, v);
    }
  }

  const res = await fetch(`/rest/${endpoint}?${params}`);
  if (!res.ok) {
    if (res.status === 401) {
      redirectToLogin();
    }
    throw new SubsonicError(res.statusText);
  }

  const data = await res.json();
  const sr = data["subsonic-response"];
  if (sr.status !== "ok") {
    if (isAuthErrorCode(sr.error?.code)) {
      redirectToLogin();
    }
    throw new SubsonicError(
      sr.error?.message ?? "Unknown error",
      sr.error?.code ?? 0,
    );
  }
  return sr as T;
}

// ── API functions ─────────────────────────────────────────────────────────────

export async function getAlbumList2(params?: {
  type?: string;
  size?: number;
  instanceId?: string;
}): Promise<SubsonicAlbum[]> {
  const type = params?.type ?? "alphabeticalByName";
  const pageSize = Math.min(params?.size ?? 500, 500);
  const all: RawAlbum[] = [];
  let offset = 0;
  // Random doesn't paginate meaningfully — server returns a fresh shuffle per
  // call, so paging would just produce duplicates. One page is enough.
  const single = type === "random";
  // Subsonic caps getAlbumList2 at 500 per call; page until a short page returns.
  for (;;) {
    const extra: Record<string, string> = {
      type,
      size: String(pageSize),
      offset: String(offset),
    };
    if (params?.instanceId) extra.instanceId = params.instanceId;
    const sr = await subsonicFetch<{ albumList2: { album?: RawAlbum[] } }>(
      "getAlbumList2",
      extra,
    );
    const page = sr.albumList2.album ?? [];
    all.push(...page);
    if (single || page.length < pageSize) break;
    offset += pageSize;
  }
  return all.map(parseAlbum);
}

export async function getArtists(): Promise<SubsonicArtist[]> {
  const sr = await subsonicFetch<{
    artists: { index: Array<{ artist?: RawArtist[] }> };
  }>("getArtists");
  const artists: SubsonicArtist[] = [];
  for (const idx of sr.artists.index) {
    for (const a of idx.artist ?? []) {
      artists.push({ id: a.id, name: a.name, albumCount: a.albumCount ?? 0, coverArt: a.coverArt });
    }
  }
  return artists;
}

export async function getArtist(id: string): Promise<SubsonicArtistDetail> {
  const sr = await subsonicFetch<{
    artist: RawArtist & { album?: RawAlbum[] };
  }>("getArtist", { id });
  const raw = sr.artist;
  return {
    id: raw.id,
    name: raw.name,
    albumCount: raw.albumCount ?? raw.album?.length ?? 0,
    coverArt: raw.coverArt,
    shareId: raw.shareId,
    album: (raw.album ?? []).map(parseAlbum),
  };
}

export async function getAlbum(id: string): Promise<SubsonicAlbumDetail> {
  const sr = await subsonicFetch<{ album: RawAlbum }>("getAlbum", { id });
  const raw = sr.album;
  return {
    ...parseAlbum(raw),
    songs: (raw.song ?? []).map(parseSong),
  };
}

export async function search3(query: string): Promise<SubsonicSearchResults> {
  const sr = await subsonicFetch<{
    searchResult3: {
      artist?: RawArtist[];
      album?: RawAlbum[];
      song?: RawSong[];
    };
  }>("search3", {
    query,
    artistCount: "10",
    albumCount: "10",
    songCount: "10",
  });
  const r = sr.searchResult3;
  return {
    artists: (r.artist ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      albumCount: a.albumCount ?? 0,
    })),
    albums: (r.album ?? []).map(parseAlbum),
    songs: (r.song ?? []).map(parseSong),
  };
}

// ── URL helpers ───────────────────────────────────────────────────────────────

// Single place that defines what format/bitrate the SPA asks the hub to serve.
// PlayerBar renders these same values as the "actually streamed" metadata, so
// changing the defaults here also changes what the user sees in the player.
export const STREAM_FORMAT = "opus";
export const STREAM_MAX_BITRATE = 320;

export interface EffectiveStream {
  format: string;
  bitRate: number;
  bitRateIsCap: boolean; // true when we only know the ceiling (transcoded)
}

// Mirrors the hub's stream-params.applyTranscodeRule so the player UI can
// predict whether the server will transcode without waiting for the response.
const LOSSY_SOURCE_FORMATS = new Set(["mp3", "opus", "aac", "ogg", "m4a"]);

export function effectiveStream(
  source: { suffix?: string | null; bitRate?: number | null },
  format: string = STREAM_FORMAT,
  maxBitRate: number = STREAM_MAX_BITRATE,
): EffectiveStream {
  const sourceFormat = source.suffix?.toLowerCase() ?? null;
  const sourceBitRate = source.bitRate ?? null;
  if (!sourceFormat) {
    return { format, bitRate: maxBitRate, bitRateIsCap: true };
  }
  const sameFormat = sourceFormat === format.toLowerCase();
  const lossyPassthrough =
    LOSSY_SOURCE_FORMATS.has(sourceFormat) &&
    (sourceBitRate ?? Infinity) <= maxBitRate;
  if (sameFormat || lossyPassthrough) {
    // Server serves raw bytes.
    return {
      format: sourceFormat,
      bitRate: sourceBitRate ?? maxBitRate,
      bitRateIsCap: sourceBitRate == null,
    };
  }
  // Lossless source transcoded to target format (or source bitrate > cap).
  return { format, bitRate: maxBitRate, bitRateIsCap: true };
}

export interface StreamUrlOptions {
  format?: string;
  maxBitRate?: number;
  /** Seconds into the track to start streaming. Subsonic `timeOffset`. */
  timeOffset?: number;
}

export function streamUrl(
  songId: string,
  options: StreamUrlOptions = {},
): string | null {
  const { format = STREAM_FORMAT, maxBitRate = STREAM_MAX_BITRATE, timeOffset } = options;
  const params = authParams();
  if (!params) return null;
  params.set("id", songId);
  params.set("format", format);
  params.set("maxBitRate", String(maxBitRate));
  if (timeOffset !== undefined && timeOffset > 0) {
    params.set("timeOffset", String(Math.floor(timeOffset)));
  }
  return `/rest/stream?${params}`;
}

export function artUrl(coverArtId: string, size?: number): string | null {
  // Last.fm and other absolute URLs are returned as-is.
  if (coverArtId.startsWith("http://") || coverArtId.startsWith("https://")) {
    return coverArtId;
  }
  const params = authParamsWithSalt(ART_SALT);
  if (!params) return null;
  params.set("id", coverArtId);
  if (size) params.set("size", String(size));
  return `/rest/getCoverArt?${params}`;
}
