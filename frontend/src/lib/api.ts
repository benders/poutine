const API_BASE = "/api";

let accessToken: string | null = localStorage.getItem("accessToken");
let refreshToken: string | null = localStorage.getItem("refreshToken");

export function setTokens(access: string, refresh: string) {
  accessToken = access;
  refreshToken = refresh;
  localStorage.setItem("accessToken", access);
  localStorage.setItem("refreshToken", refresh);
}

export function clearTokens() {
  accessToken = null;
  refreshToken = null;
  localStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
}

export function getAccessToken() {
  return accessToken;
}

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshToken) return false;

  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) {
      clearTokens();
      return false;
    }

    const data = await res.json();
    accessToken = data.accessToken;
    localStorage.setItem("accessToken", data.accessToken);
    return true;
  } catch {
    clearTokens();
    return false;
  }
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);

  if (accessToken) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }

  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  // Try refresh on 401
  if (res.status === 401 && refreshToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      headers.set("Authorization", `Bearer ${accessToken}`);
      res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error || res.statusText);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Auth API
export async function login(username: string, password: string) {
  const data = await api<{
    user: { id: string; username: string; isAdmin: boolean };
    accessToken: string;
    refreshToken: string;
  }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  setTokens(data.accessToken, data.refreshToken);
  return data.user;
}

export async function register(username: string, password: string) {
  const data = await api<{
    user: { id: string; username: string; isAdmin: boolean };
    accessToken: string;
    refreshToken: string;
  }>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  setTokens(data.accessToken, data.refreshToken);
  return data.user;
}

export async function getMe() {
  return api<{
    id: string;
    username: string;
    isAdmin: boolean;
    createdAt: string;
  }>("/auth/me");
}

// Library API
export interface Artist {
  id: string;
  name: string;
  musicbrainzId?: string;
  imageUrl?: string;
  trackCount: number;
  releaseGroupCount: number;
}

export interface ReleaseGroup {
  id: string;
  name: string;
  musicbrainzId?: string;
  year?: number;
  genre?: string;
  imageUrl?: string;
  artistId: string;
  artistName: string;
}

export interface TrackSource {
  instanceId: string;
  instanceName: string;
  instanceStatus: string;
  remoteId: string;
  format: string;
  bitrate: number;
  size: number;
}

export interface Track {
  id: string;
  title: string;
  musicbrainzId?: string;
  trackNumber: number;
  discNumber: number;
  durationMs: number;
  genre?: string;
  artistId: string;
  artistName: string;
  releaseId: string;
  releaseName: string;
  sources?: TrackSource[];
}

export interface Release {
  id: string;
  name: string;
  musicbrainzId?: string;
  edition?: string;
  trackCount: number;
  tracks: Track[];
}

export interface ReleaseGroupDetail extends ReleaseGroup {
  releases: Release[];
}

export interface ArtistDetail {
  id: string;
  name: string;
  musicbrainzId?: string;
  imageUrl?: string;
  releaseGroups: ReleaseGroup[];
}

export interface SearchResults {
  artists: Artist[];
  releaseGroups: ReleaseGroup[];
  tracks: Track[];
}

export interface Instance {
  id: string;
  name: string;
  url: string;
  adapterType: string;
  ownerId: string;
  status: string;
  lastSeen: string | null;
  lastSyncedAt: string | null;
  trackCount: number;
  serverVersion: string | null;
}

export function getArtists(params?: {
  search?: string;
  sort?: string;
  order?: string;
  limit?: number;
  offset?: number;
}) {
  const searchParams = new URLSearchParams();
  if (params?.search) searchParams.set("search", params.search);
  if (params?.sort) searchParams.set("sort", params.sort);
  if (params?.order) searchParams.set("order", params.order);
  if (params?.limit) searchParams.set("limit", String(params.limit));
  if (params?.offset) searchParams.set("offset", String(params.offset));
  const qs = searchParams.toString();
  return api<Artist[]>(`/library/artists${qs ? `?${qs}` : ""}`);
}

export function getArtist(id: string) {
  return api<ArtistDetail>(`/library/artists/${id}`);
}

export function getReleaseGroups(params?: {
  artistId?: string;
  genre?: string;
  yearFrom?: number;
  yearTo?: number;
  search?: string;
  sort?: string;
  order?: string;
  limit?: number;
  offset?: number;
}) {
  const searchParams = new URLSearchParams();
  if (params?.artistId) searchParams.set("artistId", params.artistId);
  if (params?.genre) searchParams.set("genre", params.genre);
  if (params?.yearFrom) searchParams.set("yearFrom", String(params.yearFrom));
  if (params?.yearTo) searchParams.set("yearTo", String(params.yearTo));
  if (params?.search) searchParams.set("search", params.search);
  if (params?.sort) searchParams.set("sort", params.sort);
  if (params?.order) searchParams.set("order", params.order);
  if (params?.limit) searchParams.set("limit", String(params.limit));
  if (params?.offset) searchParams.set("offset", String(params.offset));
  const qs = searchParams.toString();
  return api<ReleaseGroup[]>(`/library/release-groups${qs ? `?${qs}` : ""}`);
}

export function getReleaseGroup(id: string) {
  return api<ReleaseGroupDetail>(`/library/release-groups/${id}`);
}

export function getTracks(params?: {
  search?: string;
  releaseId?: string;
  artistId?: string;
  limit?: number;
  offset?: number;
}) {
  const searchParams = new URLSearchParams();
  if (params?.search) searchParams.set("search", params.search);
  if (params?.releaseId) searchParams.set("releaseId", params.releaseId);
  if (params?.artistId) searchParams.set("artistId", params.artistId);
  if (params?.limit) searchParams.set("limit", String(params.limit));
  if (params?.offset) searchParams.set("offset", String(params.offset));
  const qs = searchParams.toString();
  return api<Track[]>(`/library/tracks${qs ? `?${qs}` : ""}`);
}

export function searchLibrary(q: string) {
  return api<SearchResults>(`/library/search?q=${encodeURIComponent(q)}`);
}

export function getInstances() {
  return api<Instance[]>("/instances");
}

export function addInstance(data: {
  name: string;
  url: string;
  username: string;
  password: string;
}) {
  return api<Instance>("/instances", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function removeInstance(id: string) {
  return api(`/instances/${id}`, { method: "DELETE" });
}

export function syncInstance(id: string) {
  return api(`/instances/${id}/sync`, { method: "POST" });
}

export function syncAll() {
  return api("/instances/sync-all", { method: "POST" });
}

export function streamUrl(trackId: string, format = "opus", maxBitRate = 128) {
  const token = getAccessToken();
  return `/api/stream/${trackId}?format=${format}&maxBitRate=${maxBitRate}&token=${token}`;
}
