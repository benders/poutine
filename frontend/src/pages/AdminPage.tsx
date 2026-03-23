import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getInstances,
  addInstance,
  removeInstance,
  syncInstance,
  syncAll,
  getSettings,
  updateSettings,
  clearArtCache,
} from "@/lib/api";
import type { Instance } from "@/lib/api";
import { formatTimeAgo } from "@/lib/format";
import { cn } from "@/lib/cn";
import {
  Plus,
  Trash2,
  RefreshCw,
  Server,
  Wifi,
  WifiOff,
  ChevronDown,
  ChevronUp,
  HardDrive,
  ImageIcon,
} from "lucide-react";

function StatusBadge({ status }: { status: string }) {
  const config = {
    online: {
      className: "bg-success/10 text-success",
      icon: <Wifi className="w-3 h-3" />,
      label: "Online",
    },
    offline: {
      className: "bg-error/10 text-error",
      icon: <WifiOff className="w-3 h-3" />,
      label: "Offline",
    },
    degraded: {
      className: "bg-warning/10 text-warning",
      icon: <Wifi className="w-3 h-3" />,
      label: "Degraded",
    },
  }[status] ?? {
    className: "bg-text-muted/10 text-text-muted",
    icon: <Server className="w-3 h-3" />,
    label: status,
  };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium",
        config.className,
      )}
    >
      {config.icon}
      {config.label}
    </span>
  );
}

function AddInstanceForm({ onSuccess }: { onSuccess: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const mutation = useMutation({
    mutationFn: addInstance,
    onSuccess: () => {
      setName("");
      setUrl("");
      setUsername("");
      setPassword("");
      setExpanded(false);
      onSuccess();
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate({ name, url, username, password });
  };

  return (
    <div className="bg-surface border border-border rounded-lg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-text-primary hover:bg-surface-hover transition-colors rounded-lg"
      >
        <span className="flex items-center gap-2">
          <Plus className="w-4 h-4" />
          Add Instance
        </span>
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-text-muted" />
        ) : (
          <ChevronDown className="w-4 h-4 text-text-muted" />
        )}
      </button>

      {expanded && (
        <form onSubmit={handleSubmit} className="px-4 pb-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-text-secondary mb-1">
                Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Navidrome"
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-text-secondary mb-1">
                URL
              </label>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://music.example.com"
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-text-secondary mb-1">
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-text-secondary mb-1">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent"
                required
              />
            </div>
          </div>

          {mutation.isError && (
            <p className="text-sm text-error">
              {mutation.error instanceof Error
                ? mutation.error.message
                : "Failed to add instance"}
            </p>
          )}

          <button
            type="submit"
            disabled={mutation.isPending}
            className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {mutation.isPending ? "Testing connection..." : "Add Instance"}
          </button>
        </form>
      )}
    </div>
  );
}

function InstanceRow({ instance }: { instance: Instance }) {
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: () => removeInstance(instance.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["instances"] });
    },
  });

  const syncMutation = useMutation({
    mutationFn: () => syncInstance(instance.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["instances"] });
    },
  });

  const handleDelete = () => {
    if (window.confirm(`Remove instance "${instance.name}"? This will remove all tracks synced from this instance.`)) {
      deleteMutation.mutate();
    }
  };

  return (
    <div className="flex items-center gap-4 px-4 py-3 bg-surface border border-border rounded-lg">
      <Server className="w-5 h-5 text-text-muted shrink-0" />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary truncate">
            {instance.name}
          </span>
          <StatusBadge status={instance.status} />
        </div>
        <p className="text-xs text-text-muted truncate">{instance.url}</p>
      </div>

      <div className="hidden sm:flex items-center gap-6 text-xs text-text-secondary shrink-0">
        <span title="Tracks">{instance.trackCount.toLocaleString()} tracks</span>
        {instance.lastSyncedAt && (
          <span title="Last synced">
            Synced {formatTimeAgo(instance.lastSyncedAt)}
          </span>
        )}
        {instance.serverVersion && (
          <span title="Server version">v{instance.serverVersion}</span>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
          title="Sync instance"
          className="p-2 text-text-muted hover:text-text-primary hover:bg-surface-hover rounded-lg transition-colors disabled:opacity-50"
        >
          <RefreshCw
            className={cn("w-4 h-4", syncMutation.isPending && "animate-spin")}
          />
        </button>
        <button
          onClick={handleDelete}
          disabled={deleteMutation.isPending}
          title="Remove instance"
          className="p-2 text-text-muted hover:text-error hover:bg-error/10 rounded-lg transition-colors disabled:opacity-50"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function CacheSettings() {
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
  });

  const [maxMb, setMaxMb] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (settings && !dirty) {
      setMaxMb(String(Math.round(settings.artCacheMaxBytes / 1024 / 1024)));
    }
  }, [settings, dirty]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const bytes = Math.round(parseFloat(maxMb) * 1024 * 1024);
      return updateSettings({ artCacheMaxBytes: bytes });
    },
    onSuccess: () => {
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const clearMutation = useMutation({
    mutationFn: clearArtCache,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  if (isLoading || !settings) {
    return (
      <div className="bg-surface border border-border rounded-lg px-4 py-3">
        <p className="text-sm text-text-muted">Loading cache settings...</p>
      </div>
    );
  }

  const usagePercent =
    settings.artCacheMaxBytes > 0
      ? Math.min(100, (settings.artCacheCurrentBytes / settings.artCacheMaxBytes) * 100)
      : 0;

  return (
    <div className="bg-surface border border-border rounded-lg p-4 space-y-4">
      <div className="flex items-center gap-2">
        <ImageIcon className="w-4 h-4 text-text-muted" />
        <span className="text-sm font-medium text-text-primary">
          Album Art Cache
        </span>
      </div>

      {/* Usage bar */}
      <div>
        <div className="flex items-center justify-between text-xs text-text-secondary mb-1">
          <span>
            {formatBytes(settings.artCacheCurrentBytes)} / {formatBytes(settings.artCacheMaxBytes)}
          </span>
          <span>{settings.artCacheFileCount} images</span>
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

      {/* Max size input */}
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className="block text-sm text-text-secondary mb-1">
            Max Cache Size (MB)
          </label>
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
          disabled={clearMutation.isPending || settings.artCacheFileCount === 0}
          className="px-4 py-2 bg-surface border border-border hover:bg-surface-hover rounded-lg text-sm text-text-primary transition-colors disabled:opacity-50"
        >
          {clearMutation.isPending ? "Clearing..." : "Clear Cache"}
        </button>
      </div>

      {saveMutation.isError && (
        <p className="text-sm text-error">
          {saveMutation.error instanceof Error
            ? saveMutation.error.message
            : "Failed to save settings"}
        </p>
      )}
    </div>
  );
}

export function AdminPage() {
  const queryClient = useQueryClient();

  const {
    data: instances,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["instances"],
    queryFn: getInstances,
  });

  const syncAllMutation = useMutation({
    mutationFn: syncAll,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["instances"] });
    },
  });

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-text-primary">Instances</h1>
        <button
          onClick={() => syncAllMutation.mutate()}
          disabled={syncAllMutation.isPending}
          className="flex items-center gap-2 px-3 py-2 bg-surface border border-border hover:bg-surface-hover rounded-lg text-sm text-text-primary transition-colors disabled:opacity-50"
        >
          <RefreshCw
            className={cn(
              "w-4 h-4",
              syncAllMutation.isPending && "animate-spin",
            )}
          />
          {syncAllMutation.isPending ? "Syncing..." : "Sync All"}
        </button>
      </div>

      <div className="space-y-4">
        <AddInstanceForm
          onSuccess={() =>
            queryClient.invalidateQueries({ queryKey: ["instances"] })
          }
        />

        {isLoading && (
          <p className="text-sm text-text-muted text-center py-8">
            Loading instances...
          </p>
        )}

        {isError && (
          <p className="text-sm text-error text-center py-8">
            Failed to load instances.
          </p>
        )}

        {instances && instances.length === 0 && (
          <p className="text-sm text-text-muted text-center py-8">
            No instances configured. Add one above to get started.
          </p>
        )}

        {instances?.map((instance) => (
          <InstanceRow key={instance.id} instance={instance} />
        ))}
      </div>

      {/* Cache Settings */}
      <div className="mt-10">
        <h2 className="text-xl font-bold text-text-primary mb-4">Cache</h2>
        <CacheSettings />
      </div>
    </div>
  );
}
