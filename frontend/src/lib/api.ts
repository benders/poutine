let accessToken: string | null = localStorage.getItem("accessToken");

export function setToken(token: string) {
  accessToken = token;
  localStorage.setItem("accessToken", token);
}

export function clearTokens() {
  accessToken = null;
  localStorage.removeItem("accessToken");
}

export function getAccessToken() {
  return accessToken;
}

async function apiFetch<T = unknown>(
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

  const res = await fetch(path, { ...options, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error || res.statusText);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// Admin auth

export async function login(username: string, password: string) {
  const data = await apiFetch<{
    user: { id: string; username: string; isAdmin: boolean };
    accessToken: string;
  }>("/admin/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  setToken(data.accessToken);
  return data.user;
}

export async function logout() {
  await apiFetch("/admin/logout", { method: "POST" }).catch(() => undefined);
  clearTokens();
}

export async function getMe() {
  return apiFetch<{
    id: string;
    username: string;
    isAdmin: boolean;
    createdAt: string;
  }>("/admin/me");
}

// Admin API

export interface User {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: string;
}

export interface Peer {
  id: string;
  url: string;
  publicKey: string;
  status: string;
  lastSeen: string | null;
}

export interface CacheStats {
  artCacheMaxBytes: number;
  artCacheCurrentBytes: number;
  artCacheFileCount: number;
}

export interface SyncResult {
  instanceId: string;
  artistCount: number;
  albumCount: number;
  trackCount: number;
  errors: string[];
}

export function getUsers() {
  return apiFetch<User[]>("/admin/users");
}

export function createUser(username: string, password: string) {
  return apiFetch<User>("/admin/users", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function deleteUser(id: string) {
  return apiFetch(`/admin/users/${id}`, { method: "DELETE" });
}

export function getPeers() {
  return apiFetch<Peer[]>("/admin/peers");
}

export function triggerSync() {
  return apiFetch<{ local: SyncResult; peers: SyncResult[] }>("/admin/sync", {
    method: "POST",
  });
}

export function getCacheStats() {
  return apiFetch<CacheStats>("/admin/cache");
}

export function updateCacheSettings(data: { artCacheMaxBytes?: number }) {
  return apiFetch<CacheStats>("/admin/cache", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function clearArtCache() {
  return apiFetch("/admin/cache", { method: "DELETE" });
}

// Legacy library types — to be replaced in Phase 7 with Subsonic client

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

// These library calls target /api/library/* which was removed in Phase 5.
// They will be replaced by Subsonic calls in Phase 7.
export function getArtists() {
  return apiFetch<Artist[]>("/api/library/artists");
}

export function getArtist(id: string) {
  return apiFetch<ArtistDetail>(`/api/library/artists/${id}`);
}

export function getReleaseGroups(params?: { artistId?: string }) {
  const qs = params?.artistId ? `?artistId=${params.artistId}` : "";
  return apiFetch<ReleaseGroup[]>(`/api/library/release-groups${qs}`);
}

export function getReleaseGroup(id: string) {
  return apiFetch<ReleaseGroupDetail>(`/api/library/release-groups/${id}`);
}

export function searchLibrary(q: string) {
  return apiFetch<SearchResults>(`/api/library/search?q=${encodeURIComponent(q)}`);
}

// Subsonic media URLs (auth via query params)
export function streamUrl(
  trackId: string,
  username: string,
  password: string,
  format = "opus",
  maxBitRate = 128,
) {
  const params = new URLSearchParams({
    u: username,
    p: password,
    v: "1.16.1",
    c: "poutine",
    id: trackId,
    format,
    maxBitRate: String(maxBitRate),
  });
  return `/rest/stream?${params}`;
}

export function artUrl(encodedId: string, size?: number): string {
  const params = new URLSearchParams({
    u: "guest",
    p: "guest",
    v: "1.16.1",
    c: "poutine",
    id: encodedId,
  });
  if (size) params.set("size", String(size));
  return `/rest/getCoverArt?${params}`;
}
