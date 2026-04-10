import crypto from "node:crypto";

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
  ): Promise<Record<string, unknown>> {
    const url = this.buildUrl(path, extraParams);
    const response = await fetch(url);

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

    return envelope as unknown as Record<string, unknown>;
  }

  /**
   * Make a raw request that returns the Response object directly
   * (for binary streams like audio and cover art).
   */
  private async rawRequest(
    path: string,
    extraParams?: Record<string, string>,
  ): Promise<Response> {
    const url = this.buildUrl(path, extraParams);
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Subsonic HTTP error: ${response.status} ${response.statusText}`,
      );
    }

    return response;
  }

  // ── API methods ─────────────────────────────────────────────────────────

  async ping(): Promise<SubsonicPingResponse> {
    const data = await this.request("/rest/ping");
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
    },
  ): Promise<Response> {
    const extra: Record<string, string> = { id };
    if (params?.format !== undefined) extra.format = params.format;
    if (params?.maxBitRate !== undefined)
      extra.maxBitRate = String(params.maxBitRate);
    if (params?.timeOffset !== undefined)
      extra.timeOffset = String(params.timeOffset);

    return this.rawRequest("/rest/stream", extra);
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
