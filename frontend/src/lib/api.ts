
let accessToken: string | null = localStorage.getItem("accessToken");
let refreshPromise: Promise<string | null> | null = null;

export async function attemptRefresh(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const res = await fetch("/admin/refresh", { method: "POST" });
        if (!res.ok) return null;
        const data = await res.json();
        setToken(data.accessToken);
        return data.accessToken as string;
      } catch {
        return null;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

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
  _retry = true,
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
    if (res.status === 401) {
      if (_retry) {
        const newToken = await attemptRefresh();
        if (newToken) return apiFetch<T>(path, options, false);
      }
      clearTokens();
      window.location.replace("/login");
      return undefined as T;
    }
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
  const res = await fetch("/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error || res.statusText);
  }
  const data = await res.json() as {
    user: { id: string; username: string; isAdmin: boolean };
    accessToken: string;
  };
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
  lastSyncOk: boolean | null;
  lastSyncMessage: string | null;
  trackCount: number;
  artistCount: number;
  albumCount: number;
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
    lastSyncOk: boolean | null;
    lastSyncMessage: string | null;
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

export async function deletePeerData(): Promise<void> {
  await apiFetch("/admin/peers/data", { method: "DELETE" });
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
// Activity API

export interface SyncOperation {
  id: string;
  type: "manual" | "auto";
  scope: "local" | "peer";
  scopeId: string | null;
  status: "running" | "complete" | "failed";
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  artistCount: number | null;
  albumCount: number | null;
  trackCount: number | null;
  errors: string[] | null;
}

export interface StreamOperation {
  id: string;
  username: string;
  trackId: string;
  trackTitle: string;
  artistName: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  bytesTransferred: number;
}

export interface ActivitySummary {
  activeStreams: number;
  runningSyncs: number;
  recentSyncCount: number;
  recentStreamCount: number;
  lastSync: SyncOperation | null;
  lastStream: StreamOperation | null;
}

export function getRecentSyncOperations(limit = 100) {
  return apiFetch<SyncOperation[]>(`/admin/activity/sync?limit=${limit}`);
}

export function getRunningSyncOperations() {
  return apiFetch<SyncOperation[]>(`/admin/activity/sync/running`);
}

export function clearSyncHistory() {
  return apiFetch<{ cleared: boolean }>(`/admin/activity/sync`, { method: "DELETE" });
}

export function getRecentStreamOperations(limit = 100) {
  return apiFetch<StreamOperation[]>(`/admin/activity/streams?limit=${limit}`);
}

export function getActiveStreams() {
  return apiFetch<StreamOperation[]>(`/admin/activity/streams/active`);
}

export function clearStreamHistory() {
  return apiFetch<{ cleared: boolean }>(`/admin/activity/streams`, { method: "DELETE" });
}

export function getActivitySummary() {
  return apiFetch<ActivitySummary>(`/admin/activity/summary`);
}


