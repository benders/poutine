import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getInstanceInfo,
  triggerSync,
  triggerNavidromeScan,
} from "@/lib/api";
import { formatTimeAgo } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Server, Wifi, WifiOff, RefreshCw, Activity } from "lucide-react";
import { CopyButton } from "@/features/shared/CopyButton";

export function InstanceSection() {
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
      <div className="px-4 py-3 bg-surface border border-border rounded-lg">
        <div className="flex items-center gap-4">
          <Server className="w-5 h-5 text-text-muted shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-text-primary truncate">{info.instanceId || "(not set)"}</span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-success/10 text-success">
                <Wifi className="w-3 h-3" />
                Online
              </span>
            </div>
            <p className="text-xs text-text-muted truncate">
              v{info.appVersion} · api {info.apiVersion}
            </p>
          </div>
          {info.instanceId && <CopyButton text={info.instanceId} />}
        </div>
        <div className="mt-2 ml-9 flex gap-4 text-xs text-text-secondary">
          <span>{info.artistCount.toLocaleString()} artists</span>
          <span>{info.albumCount.toLocaleString()} albums</span>
          <span>{info.trackCount.toLocaleString()} tracks</span>
        </div>
      </div>

      <div className="space-y-2">
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
