import crypto from "node:crypto";
import { USER_AGENT } from "../version.js";
import { isSubsonicEnvelopeType } from "./upstream-envelope.js";

const FETCH_HEADERS = { "user-agent": USER_AGENT };

// ── Response types ──────────────────────────────────────────────────────────

export interface SubsonicArtist {
  id: string;
  name: string;
  albumCount?: number;
  coverArt?: string;
  artistImageUrl?: string;
  starred?: string;
  musicBrainzId?: string;
  sortName?: string;
}

export interface SubsonicAlbum {
  id: string;
  name: string;
  artist?: string;
  artistId?: string;
  coverArt?: string;
  songCount?: number;
  duration?: number;
  created?: string;
  year?: number;
  genre?: string;
  starred?: string;
  musicBrainzId?: string;
  isCompilation?: boolean;
  sortName?: string;
  discTitles?: Array<{ disc: number; title: string }>;
  originalReleaseDate?: { year?: number; month?: number; day?: number };
  releaseDate?: { year?: number; month?: number; day?: number };
  isDir?: boolean;
  title?: string;
  /** Tracks included when fetching a single album via getAlbum */
  song?: SubsonicSong[];
}

export interface SubsonicSong {
  id: string;
  parent?: string;
  title: string;
  album?: string;
  artist?: string;
  track?: number;
  year?: number;
  genre?: string;
  coverArt?: string;
  size?: number;
  contentType?: string;
  suffix?: string;
  duration?: number;
  bitRate?: number;
  path?: string;
  isDir?: boolean;
  albumId?: string;
  artistId?: string;
  type?: string;
  mediaType?: string;
  created?: string;
  starred?: string;
  musicBrainzId?: string;
  discNumber?: number;
  playCount?: number;
  bpm?: number;
  comment?: string;
  sortName?: string;
  channelCount?: number;
  samplingRate?: number;
  bitDepth?: number;
  replayGain?: {
    trackGain?: number;
    trackPeak?: number;
    albumGain?: number;
    albumPeak?: number;
  };
}

export interface SubsonicArtistIndex {
  name: string;
  artist: SubsonicArtist[];
}

export interface SubsonicSearchResult {
  artist?: SubsonicArtist[];
  album?: SubsonicAlbum[];
  song?: SubsonicSong[];
}

export interface SubsonicAlbumInfo {
  notes?: string;
  musicBrainzId?: string;
  lastFmUrl?: string;
  smallImageUrl?: string;
  mediumImageUrl?: string;
  largeImageUrl?: string;
}

export interface SubsonicArtistInfo {
  artist?: SubsonicArtist;
  similarArtist?: SubsonicArtist[];
  notes?: string;
  smallImageUrl?: string;
  mediumImageUrl?: string;
  largeImageUrl?: string;
  lastFmUrl?: string;
  musicBrainzId?: string;
  /** Artist bio (Navidrome extension). */
  biography?: string;
}

export interface SubsonicScanStatus {
  scanning: boolean;
  count: number;
  /** Number of music folders (Navidrome extension). */
  folderCount: number;
  /** ISO timestamp of the last completed scan (Navidrome extension). Null when never scanned. */
  lastScan: string | null;
}

export interface SubsonicPingResponse {
  status: string;
  version: string;
  type?: string;
  serverVersion?: string;
  openSubsonic?: boolean;
}

export interface SubsonicError {
  code: number;
  message: string;
}

// ── Internal envelope type ──────────────────────────────────────────────────

interface SubsonicResponseEnvelope {
  "subsonic-response": {
    status: "ok" | "failed";
    version?: string;
    type?: string;
    serverVersion?: string;
    openSubsonic?: boolean;
    error?: SubsonicError;
    [key: string]: unknown;
  };
}

// ── Call observer (issue #277) ───────────────────────────────────────────────

/**
 * One completed call to the local Navidrome, success or failure.
 *
 * `SubsonicClient` is Hub → Navidrome only (the Hub/Player boundary forbids
 * Player code from importing it, and peer traffic goes through
 * `federatedFetch`), so every event here describes the *local* Navidrome.
 */
export interface SubsonicCallEvent {
  /** Subsonic path, e.g. `/rest/stream`. Never carries auth params. */
  path: string;
  /** `json` for envelope calls, `binary` for raw byte calls (stream, art). */
  kind: "json" | "binary";
  ok: boolean;
  /** HTTP status when a response arrived; null on a transport-level failure. */
  status: number | null;
  durationMs: number;
  /** Present when `ok` is false. */
  error?: Error;
  /**
   * Binary call answered 200/206 with a Subsonic error envelope instead of
   * bytes (#285 — stale id, unreadable file). `ok` is false, but the response
   * is still returned so the caller can map the error code itself.
   */
  envelope?: boolean;
  /** Caller-supplied label, e.g. the health probe marking its own traffic. */
  tag?: string;
}

export type SubsonicObserver = (event: SubsonicCallEvent) => void;

// Process-wide, because a hub has exactly one local Navidrome while
// `SubsonicClient` is constructed per-request in several routes. Set once at
// boot (`server.ts` → NavidromeMonitor) and cleared on app close so tests
// don't leak an observer bound to a closed app.
let callObserver: SubsonicObserver | null = null;

/** Install (or with `null`, remove) the process-wide call observer. */
export function setSubsonicObserver(observer: SubsonicObserver | null): void {
  callObserver = observer;
}

/**
 * Remove `observer` only if it is the one currently installed.
 *
 * Tests build and close several apps in one process; an unconditional clear on
 * close would silently unhook the observer a *later* app had installed. Pass
 * the exact function the owning app registered.
 */
export function clearSubsonicObserver(observer: SubsonicObserver): void {
  if (callObserver === observer) callObserver = null;
}

function emit(event: SubsonicCallEvent): void {
  if (!callObserver) return;
  try {
    callObserver(event);
  } catch {
    // An observer must never be able to fail a Navidrome call.
  }
}

// ── Client ──────────────────────────────────────────────────────────────────

export interface SubsonicClientConfig {
  url: string;
  username: string;
  password: string;
}

export class SubsonicClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;

  constructor(config: SubsonicClientConfig) {
    // Strip trailing slash from URL
    this.baseUrl = config.url.replace(/\/+$/, "");
    this.username = config.username;
    this.password = config.password;
  }

  // ── Auth helpers ────────────────────────────────────────────────────────

  private generateAuthParams(): URLSearchParams {
    const salt = crypto.randomBytes(12).toString("hex");
    const token = crypto
      .createHash("md5")
      .update(this.password + salt)
      .digest("hex");

    return new URLSearchParams({
      u: this.username,
      t: token,
      s: salt,
      v: "1.16.1",
      c: "poutine",
      f: "json",
    });
  }

  private buildUrl(
    path: string,
    extraParams?: Record<string, string>,
  ): string {
    const params = this.generateAuthParams();
    if (extraParams) {
      for (const [key, value] of Object.entries(extraParams)) {
        params.set(key, value);
      }
    }
    return `${this.baseUrl}${path}?${params.toString()}`;
  }

  // ── Request helpers ─────────────────────────────────────────────────────

  /**
   * Make a JSON API request, unwrap the Subsonic response envelope,
   * and throw on error responses.
   */
  private async request(
    path: string,
    extraParams?: Record<string, string>,
    options?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    const started = Date.now();
    let status: number | null = null;
    try {
      const url = this.buildUrl(path, extraParams);
      const response = await fetch(url, {
        headers: FETCH_HEADERS,
        signal: options?.signal,
      });
      status = response.status;

      if (!response.ok) {
        throw new Error(
          `Subsonic HTTP error: ${response.status} ${response.statusText}`,
        );
      }

      const body = (await response.json()) as SubsonicResponseEnvelope;
      const envelope = body["subsonic-response"];

      if (!envelope) {
        throw new Error("Invalid Subsonic response: missing subsonic-response envelope");
      }

      if (envelope.status === "failed") {
        const err = envelope.error;
        throw new Error(
          `Subsonic error ${err?.code ?? "unknown"}: ${err?.message ?? "Unknown error"}`,
        );
      }

      emit({
        path,
        kind: "json",
        ok: true,
        status,
        durationMs: Date.now() - started,
      });
      return envelope as unknown as Record<string, unknown>;
    } catch (err) {
      emit({
        path,
        kind: "json",
        ok: false,
        status,
        durationMs: Date.now() - started,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      throw err;
    }
  }

  /**
   * Make a raw request that returns the Response object directly
   * (for binary streams like audio and cover art).
   */
  private async rawRequest(
    path: string,
    extraParams?: Record<string, string>,
    extraHeaders?: Record<string, string>,
    options?: { signal?: AbortSignal; observerTag?: string },
  ): Promise<Response> {
    const started = Date.now();
    let status: number | null = null;
    try {
      const url = this.buildUrl(path, extraParams);
      const headers: Record<string, string> = { ...FETCH_HEADERS, ...extraHeaders };
      const response = await fetch(url, { headers, signal: options?.signal });
      status = response.status;

      // 200 OK and 206 Partial Content are both success for byte-range streams.
      if (!response.ok && response.status !== 206) {
        throw new Error(
          `Subsonic HTTP error: ${response.status} ${response.statusText}`,
        );
      }

      // Navidrome reports a failed stream as 200 + an error envelope (#285).
      // Not a success — but the body is left unread for the caller to parse.
      const envelope = isSubsonicEnvelopeType(response.headers.get("content-type"));

      // Headers-only success: a mid-stream failure is the caller's to observe
      // (`routes/subsonic/stream.ts` reports what its pipeline() sees).
      emit({
        path,
        kind: "binary",
        ok: !envelope,
        status,
        durationMs: Date.now() - started,
        ...(envelope
          ? { envelope: true, error: new Error("Subsonic error envelope instead of bytes") }
          : {}),
        ...(options?.observerTag ? { tag: options.observerTag } : {}),
      });
      return response;
    } catch (err) {
      emit({
        path,
        kind: "binary",
        ok: false,
        status,
        durationMs: Date.now() - started,
        error: err instanceof Error ? err : new Error(String(err)),
        ...(options?.observerTag ? { tag: options.observerTag } : {}),
      });
      throw err;
    }
  }

  // ── API methods ─────────────────────────────────────────────────────────

  async ping(options?: { signal?: AbortSignal }): Promise<SubsonicPingResponse> {
    const data = await this.request("/rest/ping", undefined, options);
    return {
      status: data.status as string,
      version: data.version as string,
      type: data.type as string | undefined,
      serverVersion: data.serverVersion as string | undefined,
      openSubsonic: data.openSubsonic as boolean | undefined,
    };
  }

  async getArtists(): Promise<SubsonicArtistIndex[]> {
    const data = await this.request("/rest/getArtists");
    const artists = data.artists as { index?: SubsonicArtistIndex[] } | undefined;
    return artists?.index ?? [];
  }

  async getArtist(id: string): Promise<SubsonicArtist & { album?: SubsonicAlbum[] }> {
    const data = await this.request("/rest/getArtist", { id });
    return data.artist as SubsonicArtist & { album?: SubsonicAlbum[] };
  }

  async getAlbumList2(params: {
    type: string;
    size?: number;
    offset?: number;
  }): Promise<SubsonicAlbum[]> {
    const extra: Record<string, string> = { type: params.type };
    if (params.size !== undefined) extra.size = String(params.size);
    if (params.offset !== undefined) extra.offset = String(params.offset);

    const data = await this.request("/rest/getAlbumList2", extra);
    const albumList = data.albumList2 as { album?: SubsonicAlbum[] } | undefined;
    return albumList?.album ?? [];
  }

  async getAlbum(id: string): Promise<SubsonicAlbum> {
    const data = await this.request("/rest/getAlbum", { id });
    return data.album as SubsonicAlbum;
  }

  async getSong(id: string): Promise<SubsonicSong> {
    const data = await this.request("/rest/getSong", { id });
    return data.song as SubsonicSong;
  }

  async search3(
    query: string,
    params?: {
      artistCount?: number;
      albumCount?: number;
      songCount?: number;
    },
  ): Promise<SubsonicSearchResult> {
    const extra: Record<string, string> = { query };
    if (params?.artistCount !== undefined)
      extra.artistCount = String(params.artistCount);
    if (params?.albumCount !== undefined)
      extra.albumCount = String(params.albumCount);
    if (params?.songCount !== undefined)
      extra.songCount = String(params.songCount);

    const data = await this.request("/rest/search3", extra);
    return (data.searchResult3 as SubsonicSearchResult) ?? {};
  }

  async stream(
    id: string,
    params?: {
      format?: string;
      maxBitRate?: number;
      timeOffset?: number;
      estimateContentLength?: boolean;
      range?: string;
      /** Time-boxes the request — used by the health probe (#277). */
      signal?: AbortSignal;
      /** Copied onto the observer event (`SubsonicCallEvent.tag`). */
      observerTag?: string;
    },
  ): Promise<Response> {
    const extra: Record<string, string> = { id };
    if (params?.format !== undefined) extra.format = params.format;
    if (params?.maxBitRate !== undefined)
      extra.maxBitRate = String(params.maxBitRate);
    if (params?.timeOffset !== undefined)
      extra.timeOffset = String(params.timeOffset);
    if (params?.estimateContentLength)
      extra.estimateContentLength = "true";

    const headers: Record<string, string> | undefined = params?.range
      ? { range: params.range }
      : undefined;
    return this.rawRequest(
      "/rest/stream",
      extra,
      headers,
      { signal: params?.signal, observerTag: params?.observerTag },
    );
  }

  async getCoverArt(id: string, size?: number): Promise<Response> {
    const extra: Record<string, string> = { id };
    if (size !== undefined) extra.size = String(size);

    return this.rawRequest("/rest/getCoverArt", extra);
  }

  async getAlbumInfo(id: string): Promise<SubsonicAlbumInfo> {
    const data = await this.request("/rest/getAlbumInfo2", { id });
    return (data.albumInfo as SubsonicAlbumInfo) ?? {};
  }

  async getArtistInfo(
    id: string,
    params?: { musicBrainzId?: string; count?: number; includeNotYetReleased?: boolean },
  ): Promise<SubsonicArtistInfo> {
    const extra: Record<string, string> = { id };
    if (params?.musicBrainzId !== undefined)
      extra.musicBrainzId = params.musicBrainzId;
    if (params?.count !== undefined) extra.count = String(params.count);
    if (params?.includeNotYetReleased !== undefined)
      extra.includeNotYetReleased = params.includeNotYetReleased ? "true" : "false";

    const data = await this.request("/rest/getArtistInfo2", extra);
    return (data.artistInfo2 as SubsonicArtistInfo) ?? {};
  }

  async getScanStatus(): Promise<SubsonicScanStatus> {
    const data = await this.request("/rest/getScanStatus");
    const s = data.scanStatus as Record<string, unknown> | undefined;
    return {
      scanning: Boolean(s?.scanning),
      count: (s?.count as number) ?? 0,
      folderCount: (s?.folderCount as number) ?? 0,
      lastScan: (s?.lastScan as string) ?? null,
    };
  }

  async startScan(fullScan = false): Promise<SubsonicScanStatus> {
    const extra: Record<string, string> = {};
    if (fullScan) extra.fullScan = "true";
    const data = await this.request("/rest/startScan", extra);
    const s = data.scanStatus as Record<string, unknown> | undefined;
    return {
      scanning: Boolean(s?.scanning),
      count: (s?.count as number) ?? 0,
      folderCount: (s?.folderCount as number) ?? 0,
      lastScan: (s?.lastScan as string) ?? null,
    };
  }
}
