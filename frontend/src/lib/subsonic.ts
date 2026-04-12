import { getAccessToken, clearTokens, attemptRefresh } from "./api.js";

const SUBSONIC_VERSION = "1.16.1";
const CLIENT = "poutine";

// ── Legacy credential cleanup ─────────────────────────────────────────────────
// Remove plaintext passwords stored by older versions
localStorage.removeItem("subsonicUser");
localStorage.removeItem("subsonicPass");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SubsonicArtist {
  id: string;
  name: string;
  albumCount: number;
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
  };
}

// ── Base fetch ────────────────────────────────────────────────────────────────

async function subsonicFetch<T>(
  endpoint: string,
  extra?: Record<string, string>,
  _retry = true,
): Promise<T> {
  const token = getAccessToken();
  if (!token) throw new SubsonicError("Not authenticated", 10);

  const params = new URLSearchParams({
    v: SUBSONIC_VERSION,
    c: CLIENT,
    f: "json",
  });
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      params.set(k, v);
    }
  }

  const res = await fetch(`/rest/${endpoint}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    if (res.status === 401) {
      if (_retry) {
        const newToken = await attemptRefresh();
        if (newToken) return subsonicFetch<T>(endpoint, extra, false);
      }
      clearTokens();
      window.location.replace("/login");
    }
    throw new SubsonicError(res.statusText);
  }

  const data = await res.json();
  const sr = data["subsonic-response"];
  if (sr.status !== "ok") {
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
}): Promise<SubsonicAlbum[]> {
  const sr = await subsonicFetch<{ albumList2: { album?: RawAlbum[] } }>(
    "getAlbumList2",
    {
      type: params?.type ?? "alphabeticalByName",
      size: String(params?.size ?? 500),
      offset: "0",
    },
  );
  return (sr.albumList2.album ?? []).map(parseAlbum);
}

export async function getArtists(): Promise<SubsonicArtist[]> {
  const sr = await subsonicFetch<{
    artists: { index: Array<{ artist?: RawArtist[] }> };
  }>("getArtists");
  const artists: SubsonicArtist[] = [];
  for (const idx of sr.artists.index) {
    for (const a of idx.artist ?? []) {
      artists.push({ id: a.id, name: a.name, albumCount: a.albumCount ?? 0 });
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

export function streamUrl(
  songId: string,
  format = "opus",
  maxBitRate = 128,
): string {
  // Auth via httpOnly access_token cookie (sent automatically by the browser).
  // Do NOT embed the JWT in the URL — the token baked in at render time goes
  // stale when the access token refreshes, causing playback to break mid-session.
  const params = new URLSearchParams({
    v: SUBSONIC_VERSION,
    c: CLIENT,
    id: songId,
    format,
    maxBitRate: String(maxBitRate),
  });
  return `/rest/stream?${params}`;
}

export function artUrl(coverArtId: string, size?: number): string {
  // Auth via httpOnly access_token cookie (sent automatically by the browser).
  // Do NOT embed the JWT in the URL — the token baked in at render time goes
  // stale when the access token refreshes, causing images to 401.
  const params = new URLSearchParams({
    v: SUBSONIC_VERSION,
    c: CLIENT,
    id: coverArtId,
  });
  if (size) params.set("size", String(size));
  return `/rest/getCoverArt?${params}`;
}
