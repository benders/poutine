
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

export interface InstanceInfo {
  instanceId: string;
  publicKey: string;
  navidrome: {
    reachable: boolean;
    scanning: boolean;
    folderCount: number | null;
    lastScan: string | null;
    status: string;
    trackCount: number;
    lastSynced: string | null;
    lastSeen: string | null;
  };
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

export function getInstanceInfo() {
  return apiFetch<InstanceInfo>("/admin/instance");
}

export function triggerNavidromeScan() {
  return apiFetch<{ scanning: boolean; count: number; folderCount: number; lastScan: string | null }>(
    "/admin/instance/scan",
    { method: "POST" },
  );
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

