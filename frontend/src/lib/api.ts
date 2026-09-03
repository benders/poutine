
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
      // Never bounce the unauthenticated routes back to /login — that is the
      // 401 self-redirect loop (docs/pitfalls.md, Auth).
      if (!["/login", "/invite"].includes(window.location.pathname)) {
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

export type PeerLifecycle = "active" | "disabled" | "tombstoned";

export interface Peer {
  id: string;
  url: string;
  publicKey: string;
  lifecycle: PeerLifecycle;
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

// Hub-admin API surface (#220 / #226, Phase 6 of #212): users, peers,
// sync, cache, instance, activity. Routed at `/api/admin/hub/*`. The
// `/admin/*` mount only serves auth endpoints (login/refresh/logout/me);
// Hub admin handlers are no longer reachable there.

export function getInstanceInfo() {
  return apiFetch<InstanceInfo>("/api/admin/hub/instance");
}

export function triggerNavidromeScan() {
  return apiFetch<{ scanning: boolean; count: number; folderCount: number; lastScan: string | null }>(
    "/api/admin/hub/instance/scan",
    { method: "POST" },
  );
}

export function getUsers() {
  return apiFetch<User[]>("/api/admin/hub/users");
}

export function createUser(username: string, password: string) {
  return apiFetch<User>("/api/admin/hub/users", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function deleteUser(id: string) {
  return apiFetch(`/api/admin/hub/users/${id}`, { method: "DELETE" });
}

export function updateUserPassword(id: string, password: string) {
  return apiFetch(`/api/admin/hub/users/${id}/password`, {
    method: "PUT",
    body: JSON.stringify({ password }),
  });
}

// ── User invitations (#272) ───────────────────────────────────────────────────

export interface UserInvite {
  id: string;
  state: "pending" | "consumed" | "expired" | "revoked";
  suggestedUsername: string | null;
  isAdmin: boolean;
  note: string | null;
  createdBy: string | null;
  issuedAt: string;
  expiresAt: string;
  consumedAt: string | null;
  consumedBy: string | null;
  revokedAt: string | null;
}

export interface IssuedUserInvite {
  id: string;
  url: string;
  token: string;
  expiresAt: string;
  isAdmin: boolean;
  suggestedUsername: string | null;
}

export function getUserInvites() {
  return apiFetch<UserInvite[]>("/api/admin/hub/user-invites");
}

export function createUserInvite(opts: {
  expiresInSec?: number;
  suggestedUsername?: string;
  isAdmin?: boolean;
  note?: string;
  baseUrl?: string;
}) {
  return apiFetch<IssuedUserInvite>("/api/admin/hub/user-invites", {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

export function revokeUserInvite(id: string) {
  return apiFetch(`/api/admin/hub/user-invites/${id}`, { method: "DELETE" });
}

export interface InvitePreview {
  valid: true;
  expiresAt: string;
  suggestedUsername: string | null;
  isAdmin: boolean;
  hubName: string;
}

/**
 * Public invite endpoints. Plain `fetch`, never `apiFetch`: the redeem page is
 * unauthenticated, and a 401-triggered refresh/redirect there is the classic
 * self-redirect loop (see docs/pitfalls.md, Auth).
 */
async function publicPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new ApiError(res.status, payload.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export function previewInvite(token: string) {
  return publicPost<InvitePreview>("/api/invites/preview", { token });
}

/** Redeems the invite and signs the new account in, exactly like `login`. */
export async function redeemInvite(opts: {
  token: string;
  username: string;
  password: string;
}) {
  const data = await publicPost<{
    user: { id: string; username: string; isAdmin: boolean };
    accessToken: string;
    subsonicCredentials: SubsonicCreds | null;
  }>("/api/invites/redeem", opts);
  setToken(data.accessToken);
  setSubsonicCreds(data.subsonicCredentials);
  return data.user;
}

export function getPeers() {
  return apiFetch<Peer[]>("/api/admin/hub/peers");
}

export interface PeerSummary {
  id: string;
  name: string;
  status: string;
  albumCount: number;
}

export function getPeersSummary() {
  return apiFetch<PeerSummary[]>("/api/admin/hub/peers/summary");
}

/** Display name for a peer: drop anything from the first '.' onward. */
export function peerDisplayName(name: string): string {
  const dot = name.indexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}

export function triggerSync() {
  return apiFetch<{ local: SyncResult; peers: SyncResult[] }>("/api/admin/hub/sync", {
    method: "POST",
  });
}

export async function deletePeerData(): Promise<void> {
  await apiFetch("/api/admin/hub/peers/data", { method: "DELETE" });
}

export function disablePeer(id: string) {
  return apiFetch<{ id: string; lifecycle: PeerLifecycle }>(
    `/api/admin/hub/peers/${id}/disable`,
    { method: "POST" },
  );
}

export function enablePeer(id: string) {
  return apiFetch<{ id: string; lifecycle: PeerLifecycle }>(
    `/api/admin/hub/peers/${id}/enable`,
    { method: "POST" },
  );
}

export function removePeer(id: string, reason?: string) {
  return apiFetch<{
    id: string;
    lifecycle: PeerLifecycle;
    tombstone: { removedBy: string; reason: string | null; createdAt: string };
  }>(`/api/admin/hub/peers/${id}`, {
    method: "DELETE",
    body: reason ? JSON.stringify({ reason }) : undefined,
  });
}

export function generateInvitation(opts: {
  ourUrl: string;
  inviteeUrl?: string;
  expiresInSec?: number;
}): Promise<{ invitation: string }> {
  return apiFetch<{ invitation: string }>("/api/admin/hub/peers/invite", {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

export function acceptInvitation(opts: {
  invitation: string;
  ourUrl: string;
}): Promise<{ ok: true; peerId: string; peerUrl: string }> {
  return apiFetch<{ ok: true; peerId: string; peerUrl: string }>(
    "/api/admin/hub/peers/accept",
    {
      method: "POST",
      body: JSON.stringify(opts),
    },
  );
}

export function getCacheStats() {
  return apiFetch<CacheStats>("/api/admin/hub/cache");
}

export function updateCacheSettings(data: { artCacheMaxBytes?: number }) {
  return apiFetch<CacheStats>("/api/admin/hub/cache", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function clearArtCache() {
  return apiFetch("/api/admin/hub/cache", { method: "DELETE" });
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
  albumId: string | null;
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

// Live playback entry (#237) — fed by scrobble?submission=false pings, one per
// (user, client) player. Distinct from ActiveStream: a stream row is an
// in-flight HTTP transfer (gone in seconds for a buffering client), while a
// now-playing entry tracks actual listening until its ping TTL lapses.
export interface NowPlayingActivityEntry {
  userId: string;
  username: string;
  trackId: string;
  trackTitle: string;
  artistName: string;
  albumId: string | null;
  clientName: string | null;
  // Preferred-source snapshot resolved at ping time (source file, not the
  // per-request transcode the client may actually receive).
  sourceKind: "local" | "peer" | null;
  sourcePeerId: string | null;
  format: string | null;
  bitrate: number | null;
  playerId: number;
  startedAt: string;
  updatedAt: string;
  minutesAgo: number;
}

export interface ActiveActivity {
  nowPlaying: NowPlayingActivityEntry[];
  streams: ActiveStream[];
  syncs: SyncOperation[];
}

export interface ActivityHistory {
  streams: StreamOperation[];
  syncs: SyncOperation[];
}

export type ActivityHistoryKind = "stream" | "sync";

export function getActiveActivity() {
  return apiFetch<ActiveActivity>(`/api/admin/hub/activity/active`);
}

export function getActivityHistory(kinds: ActivityHistoryKind[] = ["stream", "sync"], limit = 200) {
  const params = new URLSearchParams({
    kinds: kinds.join(","),
    limit: String(limit),
  });
  return apiFetch<ActivityHistory>(`/api/admin/hub/activity/history?${params.toString()}`);
}

export function clearActivityHistory() {
  return apiFetch<{ cleared: boolean }>(`/api/admin/hub/activity`, { method: "DELETE" });
}

export function getActivitySummary() {
  return apiFetch<ActivitySummary>(`/api/admin/hub/activity/summary`);
}

export interface ActivitySettings {
  maxEvents: number;
}

export function getActivitySettings() {
  return apiFetch<ActivitySettings>(`/api/admin/hub/settings/activity`);
}

export function updateActivitySettings(settings: { maxEvents: number }) {
  return apiFetch<ActivitySettings>(`/api/admin/hub/settings/activity`, {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export interface SonosSettings {
  enabled: boolean;
  volumeCap: number;
  /** Absolute http(s) base URL devices use to fetch streams. Empty when
   *  unset (Sonos casting + DLNA won't work until set). Shared with DLNA
   *  (#209). */
  lanUrl: string;
  /** #232: when true, non-admin users can drive `/api/sonos/*` (and see the
   *  device picker in the SPA). Default false — admin-only. */
  allowNonAdmin: boolean;
}

// Player-admin API surface (#220): Sonos / LAN URL settings live under
// `/api/admin/player/*`. Hub admin code never reads these; the SPA's
// `features/player-admin/` section is the only consumer.

export function getSonosSettings() {
  return apiFetch<SonosSettings>(`/api/admin/player/settings/sonos`);
}

export function updateSonosSettings(settings: Partial<SonosSettings>) {
  return apiFetch<SonosSettings>(`/api/admin/player/settings/sonos`, {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

// ── Capabilities + Sonos ────────────────────────────────────────────────────

export interface Capabilities {
  sonos: boolean;
  /** #232: when false, the SPA hides the Sonos device picker for non-admin
   *  users. Admins always see it (subject to `sonos`). */
  sonosAllowNonAdmin: boolean;
}

export function getCapabilities() {
  return apiFetch<Capabilities>(`/api/capabilities`);
}

// ── Player health probe (issue #216) ────────────────────────────────────────
//
// Drives the SPA's /admin/player route gate. Today the Player code runs in
// the same process as the Hub, so this always returns 200. Once Phase 5
// (#220) lifts Player into its own plugin/deploy, a 404 here means the
// route renders a "Player not deployed on this host" placeholder instead.
//
// Unlike `/api/health` this is a no-auth probe (matches the Hub-side
// implementation in `hub/src/server.ts`); we wrap it in `fetch` directly
// to avoid the JWT refresh dance on a route the user may not be logged
// in to use yet.

export interface PlayerHealth {
  status: "ok";
  appVersion: string;
}

export async function getPlayerHealth(): Promise<PlayerHealth | null> {
  try {
    const res = await fetch("/player/health");
    if (!res.ok) return null;
    return (await res.json()) as PlayerHealth;
  } catch {
    return null;
  }
}

export interface SonosDevice {
  id: string;
  room: string;
  model: string;
}

export interface SonosState {
  state: string;
  position: number;
  duration: number;
  volume: number;
  /** Hard ceiling enforced server-side on every SetVolume. */
  volumeCap: number;
  /**
   * Current TrackURI from `GetPositionInfo`. The player uses changes
   * between non-empty values across polls to detect Sonos auto-advancing
   * onto a pre-loaded next track (#202).
   */
  trackUri: string;
}

export function getSonosDevices() {
  return apiFetch<{ devices: SonosDevice[] }>(`/api/sonos/devices`);
}

export function getSonosState(deviceId: string) {
  return apiFetch<SonosState>(
    `/api/sonos/devices/${encodeURIComponent(deviceId)}/state`,
  );
}

export function sonosPlay(
  deviceId: string,
  trackId: string,
  opts: { position?: number; autoplay?: boolean } = {},
) {
  return apiFetch<{ ok: true; transcoded: boolean }>(
    `/api/sonos/devices/${encodeURIComponent(deviceId)}/play`,
    {
      method: "POST",
      body: JSON.stringify({
        trackId,
        position: opts.position,
        autoplay: opts.autoplay ?? true,
      }),
    },
  );
}

export function sonosCommand(
  deviceId: string,
  action: "pause" | "resume" | "stop",
) {
  return apiFetch(
    `/api/sonos/devices/${encodeURIComponent(deviceId)}/${action}`,
    { method: "POST" },
  );
}

export function sonosSeek(deviceId: string, position: number) {
  return apiFetch(
    `/api/sonos/devices/${encodeURIComponent(deviceId)}/seek`,
    { method: "POST", body: JSON.stringify({ position }) },
  );
}

/**
 * Pre-load the next track for gapless Sonos auto-advance (#202). Pass
 * `null` to clear the slot — required on sink switch, stop, or when the
 * queue is exhausted with repeat off. `ttlSec` should cover the combined
 * duration of the currently-playing track plus this track plus a buffer,
 * so a long pause across the boundary doesn't expire the queued stream.
 */
export function sonosSetNext(
  deviceId: string,
  trackId: string | null,
  ttlSec?: number,
) {
  return apiFetch(
    `/api/sonos/devices/${encodeURIComponent(deviceId)}/next`,
    { method: "POST", body: JSON.stringify({ trackId, ttlSec }) },
  );
}

export function sonosSetVolume(deviceId: string, level: number) {
  return apiFetch(
    `/api/sonos/devices/${encodeURIComponent(deviceId)}/volume`,
    { method: "POST", body: JSON.stringify({ level }) },
  );
}


