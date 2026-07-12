import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getPeers, triggerSync, deletePeerData, disablePeer, enablePeer, removePeer } from "@/lib/api";
import type { Peer } from "@/lib/api";
import { formatTimeAgo } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Server, Wifi, WifiOff, RefreshCw, Trash2, Ban, Play, XCircle } from "lucide-react";

function LifecycleBadge({ peer }: { peer: Peer }) {
  if (peer.lifecycle === "disabled") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-warning/10 text-warning">
        <Ban className="w-3 h-3" />
        Disabled
      </span>
    );
  }
  if (peer.lifecycle === "tombstoned") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-error/10 text-error">
        <XCircle className="w-3 h-3" />
        Removed
      </span>
    );
  }
  return null;
}

function PeerRow({
  peer,
  onDisable,
  onEnable,
  onRemove,
  disablePending,
  enablePending,
  removePending,
}: {
  peer: Peer;
  onDisable: (id: string) => void;
  onEnable: (id: string) => void;
  onRemove: (id: string) => void;
  disablePending: boolean;
  enablePending: boolean;
  removePending: boolean;
}) {
  const statusConfig =
    peer.status === "online"
      ? { className: "bg-success/10 text-success", icon: <Wifi className="w-3 h-3" />, label: "Online" }
      : { className: "bg-error/10 text-error", icon: <WifiOff className="w-3 h-3" />, label: peer.status };

  const hasCounts = peer.trackCount > 0 || peer.artistCount > 0 || peer.albumCount > 0;
  const tombstoned = peer.lifecycle === "tombstoned";

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
            <LifecycleBadge peer={peer} />
          </div>
          <p className="text-xs text-text-muted truncate">{peer.url}</p>
          {(peer.appVersion || peer.apiVersion) && (
            <p className="text-xs text-text-muted truncate">
              {peer.appVersion ? `v${peer.appVersion}` : "unknown version"}
              {peer.apiVersion !== null ? ` · api ${peer.apiVersion}` : ""}
            </p>
          )}
        </div>
        <div className="hidden sm:block text-xs text-text-secondary shrink-0">
          {peer.lastSeen ? `Last seen ${formatTimeAgo(peer.lastSeen)}` : "Never synced"}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!tombstoned && peer.lifecycle === "active" && (
            <button
              onClick={() => onDisable(peer.id)}
              disabled={disablePending}
              className="flex items-center gap-1 px-2 py-1.5 bg-surface border border-border hover:bg-surface-hover rounded-lg text-xs text-text-primary transition-colors disabled:opacity-50"
              title="Stop syncing from and proxying to this peer"
            >
              <Ban className="w-3.5 h-3.5" />
              Disable
            </button>
          )}
          {!tombstoned && peer.lifecycle === "disabled" && (
            <button
              onClick={() => onEnable(peer.id)}
              disabled={enablePending}
              className="flex items-center gap-1 px-2 py-1.5 bg-surface border border-border hover:bg-surface-hover rounded-lg text-xs text-text-primary transition-colors disabled:opacity-50"
              title="Resume syncing and proxying to this peer"
            >
              <Play className="w-3.5 h-3.5" />
              Enable
            </button>
          )}
          {!tombstoned && (
            <button
              onClick={() => {
                if (
                  window.confirm(
                    `Remove peer "${peer.id}"? This is irreversible — the peer will need a new invitation to rejoin.`,
                  )
                ) {
                  onRemove(peer.id);
                }
              }}
              disabled={removePending}
              className="flex items-center gap-1 px-2 py-1.5 bg-surface border border-error/40 hover:bg-error/10 rounded-lg text-xs text-error transition-colors disabled:opacity-50"
              title="Evict this peer permanently"
            >
              <XCircle className="w-3.5 h-3.5" />
              Remove
            </button>
          )}
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

export function PeersSection() {
  const queryClient = useQueryClient();

  const { data: peers, isLoading: peersLoading } = useQuery({
    queryKey: ["admin-peers"],
    queryFn: getPeers,
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

  const invalidatePeers = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-peers"] });
    queryClient.invalidateQueries({ queryKey: ["albumList2"] });
    queryClient.invalidateQueries({ queryKey: ["artists"] });
  };

  const disableMutation = useMutation({
    mutationFn: (id: string) => disablePeer(id),
    onSuccess: invalidatePeers,
  });
  const enableMutation = useMutation({
    mutationFn: (id: string) => enablePeer(id),
    onSuccess: invalidatePeers,
  });
  const removeMutation = useMutation({
    mutationFn: (id: string) => removePeer(id),
    onSuccess: invalidatePeers,
  });

  return (
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
            No peers yet. Generate an invite above and send it to the other operator,
            or paste one you've received.
          </p>
        )}
        {peers?.map((peer) => (
          <PeerRow
            key={peer.id}
            peer={peer}
            onDisable={(id) => disableMutation.mutate(id)}
            onEnable={(id) => enableMutation.mutate(id)}
            onRemove={(id) => removeMutation.mutate(id)}
            disablePending={disableMutation.isPending && disableMutation.variables === peer.id}
            enablePending={enableMutation.isPending && enableMutation.variables === peer.id}
            removePending={removeMutation.isPending && removeMutation.variables === peer.id}
          />
        ))}
      </div>
    </section>
  );
}
