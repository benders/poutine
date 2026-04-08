import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getUsers,
  createUser,
  deleteUser,
  getPeers,
  triggerSync,
  getCacheStats,
  updateCacheSettings,
  clearArtCache,
} from "@/lib/api";
import type { User, Peer, CacheStats } from "@/lib/api";
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
} from "lucide-react";

function PeerRow({ peer }: { peer: Peer }) {
  const statusConfig =
    peer.status === "online"
      ? { className: "bg-success/10 text-success", icon: <Wifi className="w-3 h-3" />, label: "Online" }
      : { className: "bg-error/10 text-error", icon: <WifiOff className="w-3 h-3" />, label: peer.status };

  return (
    <div className="flex items-center gap-4 px-4 py-3 bg-surface border border-border rounded-lg">
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
    },
  });

  const currentUserId = users?.find((u) => u.isAdmin)?.id ?? "";

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-10">
      {/* Peers */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold text-text-primary">Federation Peers</h1>
          <button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            className="flex items-center gap-2 px-3 py-2 bg-surface border border-border hover:bg-surface-hover rounded-lg text-sm text-text-primary transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn("w-4 h-4", syncMutation.isPending && "animate-spin")} />
            {syncMutation.isPending ? "Syncing..." : "Sync All"}
          </button>
        </div>

        {syncMutation.isSuccess && (
          <div className="mb-4 p-3 bg-success/10 border border-success/20 rounded-lg text-sm text-success">
            Sync complete — local: {syncMutation.data.local.trackCount} tracks,{" "}
            {syncMutation.data.peers.length} peer(s) synced.
          </div>
        )}

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
    </div>
  );
}
