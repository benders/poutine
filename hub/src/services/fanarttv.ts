/**
 * fanart.tv API client.
 *
 * Lookups are MBID-only. Artists key on artist MBID; albums key on release-group MBID.
 *
 * Tier behaviour:
 * - Project key only: 7-day delay on newly added images (fine for Poutine).
 * - Project + personal client_key: 2-day delay.
 *
 * 404 means "no artwork on file" — treated as a normal empty result, not an error.
 */
import { USER_AGENT } from "../version.js";

const DEFAULT_BASE_URL = "https://webservice.fanart.tv/v3.2";
/** Poutine's bundled project key. Override with FANARTTV_API_KEY. */
export const POUTINE_FANARTTV_PROJECT_KEY = "dd4c8d4d423b6bae65169cd5a6339d3f";

/** Single image entry as returned by fanart.tv v3.2 (artist or album scope). */
export interface FanartTvImage {
  id: string;
  url: string;
  lang?: string;
  likes?: string;
  width?: string;
  height?: string;
}

export interface FanartTvAlbum {
  /** Release-group MBID — present on the artist endpoint, absent on /music/albums/. */
  mbid_id?: string;
  albumcover?: FanartTvImage[];
  cdart?: FanartTvImage[];
}

/**
 * Artist endpoint response. The `albums` field is an **array** of album
 * subtrees (each tagged with its release-group MBID), not a keyed object.
 * The /music/albums/{rg-mbid} endpoint returns a similar shape but scoped to
 * a single release group; callers should still iterate `albums` defensively.
 */
export interface FanartTvArtistResponse {
  name?: string;
  mbid_id?: string;
  artistbackground?: FanartTvImage[];
  artistthumb?: FanartTvImage[];
  hdmusiclogo?: FanartTvImage[];
  musiclogo?: FanartTvImage[];
  musicbanner?: FanartTvImage[];
  albums?: FanartTvAlbum[];
}

/** Minimal Fastify-compatible logger surface. */
export interface FanartTvLogger {
  error: (msg: string) => void;
  info?: (msg: string) => void;
}

/** Per-request timeout for fanart.tv calls. Failures fall through to "no result". */
const REQUEST_TIMEOUT_MS = 10_000;

export class FanartTvClient {
  private readonly projectKey: string;
  private readonly personalKey: string | undefined;
  private readonly baseUrl: string;
  private readonly log: FanartTvLogger;

  constructor(opts: {
    projectKey: string;
    personalKey?: string;
    baseUrl?: string;
    log?: FanartTvLogger;
  }) {
    this.projectKey = opts.projectKey;
    this.personalKey = opts.personalKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.log = opts.log ?? {
      error: (msg) => console.error(msg),
    };
  }

  isEnabled(): boolean {
    return this.projectKey.length > 0;
  }

  private buildUrl(path: string): string {
    const params = new URLSearchParams({ api_key: this.projectKey });
    if (this.personalKey) params.set("client_key", this.personalKey);
    return `${this.baseUrl}${path}?${params.toString()}`;
  }

  private async fetchJson<T>(path: string): Promise<T | null> {
    if (!this.isEnabled()) return null;
    try {
      const res = await fetch(this.buildUrl(path), {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        this.log.error(`fanart.tv API error: ${res.status} ${res.statusText}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      this.log.error(`fanart.tv API request failed: ${err}`);
      return null;
    }
  }

  /** Look up an artist by MusicBrainz Artist ID. */
  getArtist(mbid: string): Promise<FanartTvArtistResponse | null> {
    return this.fetchJson<FanartTvArtistResponse>(`/music/${encodeURIComponent(mbid)}`);
  }

  /**
   * Look up an album by MusicBrainz Release-Group ID.
   *
   * fanart.tv's album endpoint also lives under /music/ — albums are nested in
   * the artist response keyed by release-group MBID. The dedicated /music/albums/
   * path returns the same album subtree without needing the artist MBID.
   */
  getAlbum(releaseGroupMbid: string): Promise<FanartTvArtistResponse | null> {
    return this.fetchJson<FanartTvArtistResponse>(
      `/music/albums/${encodeURIComponent(releaseGroupMbid)}`,
    );
  }

  /** Best artist image — prefer thumb, then background. Returns null if none. */
  static bestArtistImage(resp: FanartTvArtistResponse | null): string | null {
    if (!resp) return null;
    return (
      pickFirstUrl(resp.artistthumb) ??
      pickFirstUrl(resp.artistbackground) ??
      null
    );
  }

  /**
   * Best album cover for a given release-group MBID. fanart.tv returns
   * `albums` as an array of subtrees, each tagged with its `mbid_id`.
   * The /music/albums/ endpoint returns the same shape with one entry.
   */
  static bestAlbumCover(
    resp: FanartTvArtistResponse | null,
    releaseGroupMbid: string,
  ): string | null {
    if (!resp?.albums || resp.albums.length === 0) return null;
    const match =
      resp.albums.find((a) => a.mbid_id === releaseGroupMbid) ?? resp.albums[0];
    return pickFirstUrl(match.albumcover) ?? null;
  }
}

function pickFirstUrl(images: FanartTvImage[] | undefined): string | null {
  if (!images || images.length === 0) return null;
  // Prefer entries with the most likes, then first.
  const sorted = [...images].sort(
    (a, b) => parseInt(b.likes ?? "0", 10) - parseInt(a.likes ?? "0", 10),
  );
  return sorted[0]?.url ?? null;
}
