import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getCacheStats, updateCacheSettings, clearArtCache } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ImageIcon } from "lucide-react";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function CacheSection() {
  const queryClient = useQueryClient();
  const { data: stats, isLoading } = useQuery({
    queryKey: ["admin-cache"],
    queryFn: getCacheStats,
  });

  const [maxMb, setMaxMb] = useState("");
  const [dirty, setDirty] = useState(false);
  const [syncedFrom, setSyncedFrom] = useState(stats);

  if (stats !== syncedFrom && !dirty) {
    setSyncedFrom(stats);
    if (stats) setMaxMb(String(Math.round(stats.artCacheMaxBytes / 1024 / 1024)));
  }

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
