import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getUsers,
  createUser,
  deleteUser,
  getPeers,
  triggerSync,
  deletePeerData,
  getCacheStats,
  updateCacheSettings,
  clearArtCache,
  getInstanceInfo,
  triggerNavidromeScan,
  getRecentSyncOperations,
  clearSyncHistory,
  getRecentStreamOperations,
  clearStreamHistory,
} from "@/lib/api";
import type { User, Peer, CacheStats, SyncOperation, StreamOperation } from "@/lib/api";
import { formatTimeAgo } from "@/lib/format";
import { cn } from "@/lib/cn";
import {
  Plus,
  Trash2,
  RefreshCw,
  Server,
  Wifi,
  WifiOff,
  ImageIcon,
  Users,
  Copy,
  Check,
  Activity,
} from "lucide-react";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button
      onClick={handleCopy}
      title="Copy to clipboard"
      className="p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function InstanceSection() {
  const queryClient = useQueryClient();

  const { data: info, isLoading } = useQuery({
    queryKey: ["admin-instance"],
    queryFn: getInstanceInfo,
    refetchInterval: 30_000,
  });

  const syncMutation = useMutation({
    mutationFn: triggerSync,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-instance"] });
      queryClient.invalidateQueries({ queryKey: ["admin-peers"] });
      queryClient.invalidateQueries({ queryKey: ["albumList2"] });
      queryClient.invalidateQueries({ queryKey: ["artists"] });
    },
  });

  const scanMutation = useMutation({
    mutationFn: triggerNavidromeScan,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-instance"] });
    },
  });

  if (isLoading || !info) {
    return (
      <div className="bg-surface border border-border rounded-lg px-4 py-3">
        <p className="text-sm text-text-muted">Loading instance info...</p>
      </div>
    );
  }

  const nd = info.navidrome;
  const isHealthy = nd.reachable && nd.status === "online";
  const statusLabel = !nd.reachable ? "Unreachable" : nd.status === "online" ? "Online" : nd.status;
  const statusClass = isHealthy
    ? "bg-success/10 text-success"
    : nd.reachable
    ? "bg-warning/10 text-warning"
    : "bg-error/10 text-error";

  return (
    <div className="bg-surface border border-border rounded-lg p-4 space-y-4">
      {/* Identity */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-text-muted shrink-0" />
          <span className="text-xs text-text-secondary uppercase tracking-wide font-medium">Instance ID</span>
        </div>
        <div className="flex items-center gap-2 pl-6">
          <code className="flex-1 text-sm text-text-primary font-mono bg-surface-hover px-2 py-1 rounded">{info.instanceId || "(not set)"}</code>
          {info.instanceId && <CopyButton text={info.instanceId} />}
        </div>

        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-text-muted shrink-0" />
          <span className="text-xs text-text-secondary uppercase tracking-wide font-medium">Public Key</span>
        </div>
        <div className="flex items-center gap-2 pl-6">
          <code className="flex-1 text-xs text-text-primary font-mono bg-surface-hover px-2 py-1.5 rounded break-all leading-relaxed">{info.publicKey}</code>
          <CopyButton text={info.publicKey} />
        </div>
      </div>

      <div className="border-t border-border" />

      {/* Navidrome status */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-text-primary">Local Navidrome</span>
          <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium", statusClass)}>
            {isHealthy ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            {nd.scanning ? "Scanning…" : statusLabel}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-text-muted mb-0.5">Tracks in index</p>
            <p className="text-text-primary font-medium">{nd.trackCount.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted mb-0.5">Music folders</p>
            <p className="text-text-primary">{nd.folderCount ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted mb-0.5">Last Navidrome scan</p>
            <p className="text-text-primary">{formatTimeAgo(nd.lastScan)}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted mb-0.5">Last synced</p>
            <p className="text-text-primary">{formatTimeAgo(nd.lastSynced)}</p>
          </div>
        </div>
      </div>

      {scanMutation.isSuccess && (
        <div className="p-3 bg-success/10 border border-success/20 rounded-lg text-sm text-success">
          Navidrome scan started.
        </div>
      )}

      {scanMutation.isError && (
        <p className="text-sm text-error">
          {scanMutation.error instanceof Error ? scanMutation.error.message : "Scan failed"}
        </p>
      )}

      {syncMutation.isSuccess && (
        <div className="p-3 bg-success/10 border border-success/20 rounded-lg text-sm text-success">
          Sync complete — {syncMutation.data.local.trackCount} local tracks indexed.
        </div>
      )}

      {syncMutation.isError && (
        <p className="text-sm text-error">
          {syncMutation.error instanceof Error ? syncMutation.error.message : "Sync failed"}
        </p>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => scanMutation.mutate()}
          disabled={scanMutation.isPending || nd.scanning || !nd.reachable}
          title="Tell Navidrome to re-scan its music folders"
          className="flex items-center gap-2 px-3 py-2 bg-surface border border-border hover:bg-surface-hover rounded-lg text-sm text-text-primary transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn("w-4 h-4", (scanMutation.isPending || nd.scanning) && "animate-spin")} />
          {nd.scanning ? "Scanning…" : "Scan Library"}
        </button>
        <button
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
          title="Re-index Navidrome's library into Poutine"
          className="flex items-center gap-2 px-3 py-2 bg-surface border border-border hover:bg-surface-hover rounded-lg text-sm text-text-primary transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn("w-4 h-4", syncMutation.isPending && "animate-spin")} />
          {syncMutation.isPending ? "Syncing…" : "Sync Now"}
        </button>
      </div>
    </div>
  );
}

function PeerRow({ peer }: { peer: Peer }) {
  const statusConfig =
    peer.status === "online"
      ? { className: "bg-success/10 text-success", icon: <Wifi className="w-3 h-3" />, label: "Online" }
      : { className: "bg-error/10 text-error", icon: <WifiOff className="w-3 h-3" />, label: peer.status };

  const hasCounts = peer.trackCount > 0 || peer.artistCount > 0 || peer.albumCount > 0;

  return (
    <div className="px-4 py-3 bg-surface border border-border rounded-lg">
      <div className="flex items-center gap-4">
        <Server className="w-5 h-5 text-text-muted shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary">{peer.id}</span>
            <span
              className={cn(
                "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium",
                statusConfig.className,
              )}
            >
              {statusConfig.icon}
              {statusConfig.label}
            </span>
          </div>
          <p className="text-xs text-text-muted truncate">{peer.url}</p>
        </div>
        <div className="hidden sm:block text-xs text-text-secondary shrink-0">
          {peer.lastSeen ? `Last seen ${formatTimeAgo(peer.lastSeen)}` : "Never synced"}
        </div>
      </div>
      {hasCounts && (
        <div className="mt-2 ml-9 flex gap-4 text-xs text-text-secondary">
          <span>{peer.artistCount.toLocaleString()} artists</span>
          <span>{peer.albumCount.toLocaleString()} albums</span>
          <span>{peer.trackCount.toLocaleString()} tracks</span>
        </div>
      )}
      {peer.lastSyncMessage && (
        <p className={cn(
          "mt-1.5 ml-9 text-xs",
          peer.lastSyncOk === false ? "text-error" : "text-text-muted",
        )}>
          {peer.lastSyncMessage}
        </p>
      )}
    </div>
  );
}

function AddUserForm({ onSuccess }: { onSuccess: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const mutation = useMutation({
    mutationFn: () => createUser(username, password),
    onSuccess: () => {
      setUsername("");
      setPassword("");
      setExpanded(false);
      onSuccess();
    },
  });

  return (
    <div className="bg-surface border border-border rounded-lg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium text-text-primary hover:bg-surface-hover transition-colors rounded-lg"
      >
        <Plus className="w-4 h-4" />
        Add Guest User
      </button>

      {expanded && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
          className="px-4 pb-4 space-y-3"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-text-secondary mb-1">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-text-secondary mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent"
                required
              />
            </div>
          </div>

          {mutation.isError && (
            <p className="text-sm text-error">
              {mutation.error instanceof Error ? mutation.error.message : "Failed to create user"}
            </p>
          )}

          <button
            type="submit"
            disabled={mutation.isPending}
            className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {mutation.isPending ? "Creating..." : "Create User"}
          </button>
        </form>
      )}
    </div>
  );
}

function UserRow({ user, currentUserId }: { user: User; currentUserId: string }) {
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: () => deleteUser(user.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });

  return (
    <div className="flex items-center gap-4 px-4 py-3 bg-surface border border-border rounded-lg">
      <Users className="w-5 h-5 text-text-muted shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary">{user.username}</span>
          {user.isAdmin && (
            <span className="px-2 py-0.5 bg-accent/10 text-accent rounded-full text-xs font-medium">
              admin
            </span>
          )}
        </div>
        <p className="text-xs text-text-muted">Joined {formatTimeAgo(user.createdAt)}</p>
      </div>
      {!user.isAdmin && user.id !== currentUserId && (
        <button
          onClick={() => {
            if (window.confirm(`Remove user "${user.username}"?`)) {
              deleteMutation.mutate();
            }
          }}
          disabled={deleteMutation.isPending}
          title="Remove user"
          className="p-2 text-text-muted hover:text-error hover:bg-error/10 rounded-lg transition-colors disabled:opacity-50"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function CacheSection() {
  const queryClient = useQueryClient();
  const { data: stats, isLoading } = useQuery({
    queryKey: ["admin-cache"],
    queryFn: getCacheStats,
  });

  const [maxMb, setMaxMb] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (stats && !dirty) {
      setMaxMb(String(Math.round(stats.artCacheMaxBytes / 1024 / 1024)));
    }
  }, [stats, dirty]);

  const saveMutation = useMutation({
    mutationFn: () =>
      updateCacheSettings({ artCacheMaxBytes: Math.round(parseFloat(maxMb) * 1024 * 1024) }),
    onSuccess: () => {
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ["admin-cache"] });
    },
  });

  const clearMutation = useMutation({
    mutationFn: clearArtCache,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-cache"] }),
  });

  if (isLoading || !stats) {
    return (
      <div className="bg-surface border border-border rounded-lg px-4 py-3">
        <p className="text-sm text-text-muted">Loading cache settings...</p>
      </div>
    );
  }

  const usagePercent =
    stats.artCacheMaxBytes > 0
      ? Math.min(100, (stats.artCacheCurrentBytes / stats.artCacheMaxBytes) * 100)
      : 0;

  return (
    <div className="bg-surface border border-border rounded-lg p-4 space-y-4">
      <div className="flex items-center gap-2">
        <ImageIcon className="w-4 h-4 text-text-muted" />
        <span className="text-sm font-medium text-text-primary">Album Art Cache</span>
      </div>

      <div>
        <div className="flex items-center justify-between text-xs text-text-secondary mb-1">
          <span>
            {formatBytes(stats.artCacheCurrentBytes)} / {formatBytes(stats.artCacheMaxBytes)}
          </span>
          <span>{stats.artCacheFileCount} images</span>
        </div>
        <div className="h-2 bg-border rounded-full overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              usagePercent > 90 ? "bg-error" : usagePercent > 70 ? "bg-warning" : "bg-accent",
            )}
            style={{ width: `${usagePercent}%` }}
          />
        </div>
      </div>

      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className="block text-sm text-text-secondary mb-1">Max Cache Size (MB)</label>
          <input
            type="number"
            min="1"
            step="1"
            value={maxMb}
            onChange={(e) => {
              setMaxMb(e.target.value);
              setDirty(true);
            }}
            className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent"
          />
        </div>
        <button
          onClick={() => saveMutation.mutate()}
          disabled={!dirty || saveMutation.isPending}
          className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
        >
          {saveMutation.isPending ? "Saving..." : "Save"}
        </button>
        <button
          onClick={() => {
            if (window.confirm("Clear the entire album art cache?")) {
              clearMutation.mutate();
            }
          }}
          disabled={clearMutation.isPending || stats.artCacheFileCount === 0}
          className="px-4 py-2 bg-surface border border-border hover:bg-surface-hover rounded-lg text-sm text-text-primary transition-colors disabled:opacity-50"
        >
          {clearMutation.isPending ? "Clearing..." : "Clear Cache"}
        </button>
      </div>

      {saveMutation.isError && (
        <p className="text-sm text-error">
          {saveMutation.error instanceof Error ? saveMutation.error.message : "Failed to save settings"}
        </p>
      )}
    </div>
  );
}

function ActivitySection() {
  const queryClient = useQueryClient();

  const { data: recentSyncs, isLoading: syncsLoading } = useQuery({
    queryKey: ["admin-recent-syncs"],
    queryFn: () => getRecentSyncOperations(20),
    refetchInterval: 15_000,
  });

  const { data: recentStreams, isLoading: recentStreamsLoading } = useQuery({
    queryKey: ["admin-recent-streams"],
    queryFn: () => getRecentStreamOperations(20),
    refetchInterval: 10_000,
  });

  const clearSyncMutation = useMutation({
    mutationFn: clearSyncHistory,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-recent-syncs"] });
    },
  });

  const clearStreamMutation = useMutation({
    mutationFn: clearStreamHistory,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-recent-streams"] });
    },
  });

  return (
    <div className="bg-surface border border-border rounded-lg p-4 space-y-4">
      {/* Stream History */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-text-muted" />
            <span className="text-sm font-medium text-text-primary">Stream History</span>
          </div>
          {recentStreams && recentStreams.length > 0 && (
            <button
              onClick={() => {
                if (window.confirm("Clear stream history?")) {
                  clearStreamMutation.mutate();
                }
              }}
              disabled={clearStreamMutation.isPending}
              className="px-2 py-1 text-xs bg-surface border border-border hover:bg-error/10 hover:border-error/40 hover:text-error rounded transition-colors disabled:opacity-50"
            >
              {clearStreamMutation.isPending ? "Clearing..." : "Clear"}
            </button>
          )}
        </div>

        <div className="overflow-y-auto max-h-64">
          {recentStreamsLoading ? (
            <p className="text-sm text-text-muted py-2">Loading stream history...</p>
          ) : recentStreams && recentStreams.length > 0 ? (
            <div className="space-y-2">
              {recentStreams.map((stream) => (
                <div key={stream.id} className="bg-surface-hover border border-border rounded-lg p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-text-primary truncate">{stream.trackTitle}</p>
                      <p className="text-xs text-text-muted truncate">{stream.artistName} • {stream.username}</p>
                      <p className="text-xs text-secondary mt-1">
                        {formatBytes(stream.bytesTransferred)} transferred
                      </p>
                    </div>
                    <span className="text-xs text-secondary shrink-0">
                      {formatDuration(stream.durationMs)}
                    </span>
                  </div>
                  <p className="text-xs text-text-muted mt-1">
                    Started {formatTimeAgo(stream.startedAt)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-text-muted py-2">No stream history</p>
          )}
        </div>
      </div>

      <div className="border-t border-border" />

      {/* Sync History */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <RefreshCw className="w-4 h-4 text-text-muted" />
            <span className="text-sm font-medium text-text-primary">Sync History</span>
          </div>
          {recentSyncs && recentSyncs.length > 0 && (
            <button
              onClick={() => {
                if (window.confirm("Clear sync history?")) {
                  clearSyncMutation.mutate();
                }
              }}
              disabled={clearSyncMutation.isPending}
              className="px-2 py-1 text-xs bg-surface border border-border hover:bg-error/10 hover:border-error/40 hover:text-error rounded transition-colors disabled:opacity-50"
            >
              {clearSyncMutation.isPending ? "Clearing..." : "Clear"}
            </button>
          )}
        </div>

        <div className="overflow-y-auto max-h-64">
          {syncsLoading ? (
            <p className="text-sm text-text-muted py-2">Loading sync history...</p>
          ) : recentSyncs && recentSyncs.length > 0 ? (
            <div className="space-y-2">
              {recentSyncs.map((sync) => {
                const statusConfig =
                  sync.status === "complete"
                    ? { class: "bg-success/10 text-success", label: "Complete" }
                    : sync.status === "failed"
                    ? { class: "bg-error/10 text-error", label: "Failed" }
                    : { class: "bg-warning/10 text-warning", label: "Running" };

                return (
                  <div key={sync.id} className="bg-surface-hover border border-border rounded-lg p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-text-primary">
                            {sync.type === "manual" ? "Manual" : "Auto"} {sync.scope === "peer" ? `Peer: ${sync.scopeId}` : "Local"}
                          </span>
                          <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium", statusConfig.class)}>
                            {statusConfig.label}
                          </span>
                        </div>
                        <p className="text-xs text-text-muted mt-1">
                          Started {formatTimeAgo(sync.startedAt)}
                        </p>
                        {sync.artistCount !== null && (
                          <p className="text-xs text-secondary mt-1">
                            {sync.artistCount} artists, {sync.albumCount} albums, {sync.trackCount} tracks
                          </p>
                        )}
                      </div>
                      <span className="text-xs text-secondary shrink-0">
                        {formatDuration(sync.durationMs)}
                      </span>
                    </div>
                    {sync.errors && sync.errors.length > 0 && (
                      <p className="text-xs text-error mt-2 truncate">{sync.errors[0]}</p>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-text-muted py-2">No sync history</p>
          )}
        </div>
      </div>
    </div>
  );
}

export function AdminPage() {
  const queryClient = useQueryClient();

  const { data: peers, isLoading: peersLoading } = useQuery({
    queryKey: ["admin-peers"],
    queryFn: getPeers,
  });

  const { data: users, isLoading: usersLoading } = useQuery({
    queryKey: ["admin-users"],
    queryFn: getUsers,
  });

  const syncMutation = useMutation({
    mutationFn: triggerSync,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-peers"] });
      queryClient.invalidateQueries({ queryKey: ["admin-instance"] });
      queryClient.invalidateQueries({ queryKey: ["albumList2"] });
      queryClient.invalidateQueries({ queryKey: ["artists"] });
    },
  });

  const deletePeerDataMutation = useMutation({
    mutationFn: deletePeerData,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-peers"] });
    },
  });

  const currentUserId = users?.find((u) => u.isAdmin)?.id ?? "";

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-10">
      {/* Instance */}
      <section>
        <h1 className="text-xl font-bold text-text-primary mb-4">This Instance</h1>
        <InstanceSection />
      </section>

      {/* Peers */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold text-text-primary">Federation Peers</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              className="flex items-center gap-2 px-3 py-2 bg-surface border border-border hover:bg-surface-hover rounded-lg text-sm text-text-primary transition-colors disabled:opacity-50"
            >
              <RefreshCw className={cn("w-4 h-4", syncMutation.isPending && "animate-spin")} />
              {syncMutation.isPending ? "Syncing..." : "Sync All"}
            </button>
            {peers && peers.length > 0 && (
              <button
                onClick={() => {
                  if (window.confirm("Delete all data fetched from peers? This will reset sync state.")) {
                    deletePeerDataMutation.mutate();
                  }
                }}
                disabled={deletePeerDataMutation.isPending}
                className="flex items-center gap-2 px-3 py-2 bg-surface border border-error/40 hover:bg-error/10 rounded-lg text-sm text-error transition-colors disabled:opacity-50"
              >
                <Trash2 className="w-4 h-4" />
                {deletePeerDataMutation.isPending ? "Deleting..." : "Delete Peer Data"}
              </button>
            )}
          </div>
        </div>

        {syncMutation.isSuccess && (() => {
          const failedPeers = syncMutation.data.peers.filter((p) => p.errors.length > 0);
          if (failedPeers.length > 0) {
            return (
              <div className="mb-4 p-3 bg-error/10 border border-error/20 rounded-lg text-sm text-error space-y-1">
                <p>Sync finished with errors — {failedPeers.length} peer(s) failed:</p>
                {failedPeers.map((p) => (
                  <p key={p.instanceId} className="ml-2">{p.instanceId}: {p.errors[0]}</p>
                ))}
              </div>
            );
          }
          return (
            <div className="mb-4 p-3 bg-success/10 border border-success/20 rounded-lg text-sm text-success">
              Sync complete — local: {syncMutation.data.local.trackCount} tracks,{" "}
              {syncMutation.data.peers.length} peer(s) synced.
            </div>
          );
        })()}

        {syncMutation.isError && (
          <p className="mb-4 text-sm text-error">
            {syncMutation.error instanceof Error ? syncMutation.error.message : "Sync failed"}
          </p>
        )}

        <div className="space-y-2">
          {peersLoading && <p className="text-sm text-text-muted py-4">Loading peers...</p>}
          {!peersLoading && peers?.length === 0 && (
            <p className="text-sm text-text-muted py-4">
              No peers configured. Add peers to <code className="text-xs">peers.yaml</code> and
              reload.
            </p>
          )}
          {peers?.map((peer) => <PeerRow key={peer.id} peer={peer} />)}
        </div>
      </section>

      {/* Users */}
      <section>
        <h2 className="text-xl font-bold text-text-primary mb-4">Users</h2>
        <div className="space-y-2">
          <AddUserForm onSuccess={() => queryClient.invalidateQueries({ queryKey: ["admin-users"] })} />
          {usersLoading && <p className="text-sm text-text-muted py-4">Loading users...</p>}
          {users?.map((user) => (
            <UserRow key={user.id} user={user} currentUserId={currentUserId} />
          ))}
        </div>
      </section>

      {/* Cache */}
      <section>
        <h2 className="text-xl font-bold text-text-primary mb-4">Cache</h2>
        <CacheSection />
      </section>

      {/* Activity */}
      <section>
        <h2 className="text-xl font-bold text-text-primary mb-4">Activity</h2>
        <ActivitySection />
      </section>
    </div>
  );
}
