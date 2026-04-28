
let accessToken: string | null = localStorage.getItem("accessToken");
let refreshPromise: Promise<string | null> | null = null;

export interface SubsonicCreds {
  username: string;
  password: string;
}

function readSubsonicCreds(): SubsonicCreds | null {
  const username = localStorage.getItem("subsonicUser");
  const password = localStorage.getItem("subsonicPass");
  if (!username || !password) return null;
  return { username, password };
}

let subsonicCreds: SubsonicCreds | null = readSubsonicCreds();

export function getSubsonicCreds(): SubsonicCreds | null {
  return subsonicCreds;
}

export function setSubsonicCreds(creds: SubsonicCreds | null) {
  subsonicCreds = creds;
  if (creds) {
    localStorage.setItem("subsonicUser", creds.username);
    localStorage.setItem("subsonicPass", creds.password);
  } else {
    localStorage.removeItem("subsonicUser");
    localStorage.removeItem("subsonicPass");
  }
}

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
  setSubsonicCreds(null);
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
      if (window.location.pathname !== "/login") {
        window.location.replace("/login");
      }
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
    subsonicCredentials: SubsonicCreds | null;
  };
  setToken(data.accessToken);
  setSubsonicCreds(data.subsonicCredentials);
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
  appVersion: string | null;
  apiVersion: number | null;
}

export interface InstanceInfo {
  instanceId: string;
  publicKey: string;
  appVersion: string;
  apiVersion: number;
  artistCount: number;
  albumCount: number;
  trackCount: number;
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

export interface PeerSummary {
  id: string;
  name: string;
  status: string;
  albumCount: number;
}

export function getPeersSummary() {
  return apiFetch<PeerSummary[]>("/admin/peers/summary");
}

/** Display name for a peer: drop anything from the first '.' onward. */
export function peerDisplayName(name: string): string {
  const dot = name.indexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
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
  kind: "subsonic" | "proxy";
  username: string;
  trackId: string;
  trackTitle: string;
  artistName: string;
  clientName: string | null;
  clientVersion: string | null;
  peerId: string | null;
  sourceKind: "local" | "peer" | null;
  sourcePeerId: string | null;
  format: string | null;
  bitrate: number | null;
  transcoded: boolean;
  maxBitrate: number | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  bytesTransferred: number | null;
  error: string | null;
}

export interface ActiveStream extends Omit<StreamOperation, "finishedAt" | "durationMs" | "error"> {
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

export interface ActiveActivity {
  streams: ActiveStream[];
  syncs: SyncOperation[];
}

export interface ActivityHistory {
  streams: StreamOperation[];
  syncs: SyncOperation[];
}

export type ActivityHistoryKind = "stream" | "sync";

export function getActiveActivity() {
  return apiFetch<ActiveActivity>(`/admin/activity/active`);
}

export function getActivityHistory(kinds: ActivityHistoryKind[] = ["stream", "sync"], limit = 200) {
  const params = new URLSearchParams({
    kinds: kinds.join(","),
    limit: String(limit),
  });
  return apiFetch<ActivityHistory>(`/admin/activity/history?${params.toString()}`);
}

export function clearActivityHistory() {
  return apiFetch<{ cleared: boolean }>(`/admin/activity`, { method: "DELETE" });
}

export function getActivitySummary() {
  return apiFetch<ActivitySummary>(`/admin/activity/summary`);
}

export interface ActivitySettings {
  maxEvents: number;
}

export function getActivitySettings() {
  return apiFetch<ActivitySettings>(`/admin/settings/activity`);
}

export function updateActivitySettings(settings: { maxEvents: number }) {
  return apiFetch<ActivitySettings>(`/admin/settings/activity`, {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}


