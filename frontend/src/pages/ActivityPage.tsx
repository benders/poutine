import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getActiveActivity,
  getActivityHistory,
  clearActivityHistory,
  getPeersSummary,
  peerDisplayName,
} from "@/lib/api";
import type {
  ActiveStream,
  StreamOperation,
  SyncOperation,
  ActivityHistoryKind,
} from "@/lib/api";
import { cn } from "@/lib/cn";
import { Activity, Radio, RefreshCw, AlertCircle } from "lucide-react";

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatTs(iso: string | null): string {
  if (!iso) return "—";
  // Server returns "YYYY-MM-DD HH:MM:SS" UTC. Render as local ISO short.
  const normalized = iso.includes("T") ? iso : iso.replace(" ", "T") + "Z";
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function streamFormatLine(s: StreamOperation | ActiveStream): string {
  if (s.transcoded) {
    return s.maxBitrate ? `transcoding · max ${s.maxBitrate}kbps` : "transcoding";
  }
  const fmt = s.format ?? "?";
  const br = s.bitrate ? `${s.bitrate}kbps` : "";
  return [fmt, br].filter(Boolean).join(" · ");
}

function streamSourceLabel(
  s: StreamOperation | ActiveStream,
  peerName: (id: string) => string,
): string {
  if (s.sourceKind === "local") return "Local";
  if (s.sourceKind === "peer" && s.sourcePeerId) return peerName(s.sourcePeerId);
  return "—";
}

function streamClientLabel(
  s: StreamOperation | ActiveStream,
  peerName: (id: string) => string,
): string {
  if (s.kind === "proxy") {
    return s.peerId ? peerName(s.peerId) : "peer";
  }
  if (!s.clientName) return "—";
  return s.clientVersion ? `${s.clientName} v${s.clientVersion}` : s.clientName;
}

function streamUserLabel(s: StreamOperation | ActiveStream): string {
  return s.username || "—";
}

function ActiveStreamRow({
  s,
  peerName,
}: {
  s: ActiveStream;
  peerName: (id: string) => string;
}) {
  return (
    <div className="grid grid-cols-12 gap-2 px-3 py-2 text-xs items-center bg-surface-hover border border-border rounded">
      <span className="col-span-2 font-mono text-text-muted">{formatTs(s.startedAt)}</span>
      <span className="col-span-3 truncate text-text-primary" title={`${s.trackTitle} — ${s.artistName}`}>
        <span className="font-medium">{s.trackTitle}</span>
        <span className="text-text-muted"> · {s.artistName}</span>
      </span>
      <span className="col-span-2 truncate text-text-secondary">{streamFormatLine(s)}</span>
      <span className="col-span-1 truncate text-text-secondary">{streamSourceLabel(s, peerName)}</span>
      <span className="col-span-1 truncate text-text-secondary">{streamUserLabel(s)}</span>
      <span className="col-span-2 truncate text-text-secondary">{streamClientLabel(s, peerName)}</span>
      <span className="col-span-1 text-right tabular-nums text-text-secondary">{formatBytes(s.bytesTransferred)}</span>
    </div>
  );
}

function HistoryStreamRow({
  s,
  peerName,
}: {
  s: StreamOperation;
  peerName: (id: string) => string;
}) {
  return (
    <div className="grid grid-cols-12 gap-2 px-3 py-2 text-xs items-center bg-surface-hover border border-border rounded">
      <span className="col-span-1 font-mono text-text-muted">{formatTs(s.startedAt)}</span>
      <span className="col-span-1 font-mono text-text-muted">{formatTs(s.finishedAt)}</span>
      <span className="col-span-3 truncate text-text-primary" title={`${s.trackTitle} — ${s.artistName}`}>
        <span className="font-medium">{s.trackTitle}</span>
        <span className="text-text-muted"> · {s.artistName}</span>
      </span>
      <span className="col-span-2 truncate text-text-secondary">{streamFormatLine(s)}</span>
      <span className="col-span-1 truncate text-text-secondary">{streamSourceLabel(s, peerName)}</span>
      <span className="col-span-1 truncate text-text-secondary">{streamUserLabel(s)}</span>
      <span className="col-span-2 truncate text-text-secondary">{streamClientLabel(s, peerName)}</span>
      <span className="col-span-1 text-right tabular-nums text-text-secondary">
        {formatBytes(s.bytesTransferred)}
        {s.error && <AlertCircle className="inline w-3 h-3 text-error ml-1" aria-label={s.error} />}
      </span>
    </div>
  );
}

function syncTargetLabel(s: SyncOperation, peerName: (id: string) => string): string {
  if (s.scope === "local") return "Local Navidrome";
  if (s.scope === "peer" && s.scopeId) return peerName(s.scopeId);
  return "—";
}

function ActiveSyncRow({
  s,
  peerName,
}: {
  s: SyncOperation;
  peerName: (id: string) => string;
}) {
  return (
    <div className="grid grid-cols-12 gap-2 px-3 py-2 text-xs items-center bg-surface-hover border border-border rounded">
      <span className="col-span-2 font-mono text-text-muted">{formatTs(s.startedAt)}</span>
      <span className="col-span-2 truncate text-text-secondary">
        {s.type === "manual" ? "Manual" : "Auto"}
      </span>
      <span className="col-span-3 truncate text-text-primary">{syncTargetLabel(s, peerName)}</span>
      <span className="col-span-5 text-text-secondary tabular-nums">
        Artists: {s.artistCount ?? 0} · Albums: {s.albumCount ?? 0} · Tracks: {s.trackCount ?? 0}
      </span>
    </div>
  );
}

function HistorySyncRow({
  s,
  peerName,
}: {
  s: SyncOperation;
  peerName: (id: string) => string;
}) {
  const failed = s.status === "failed" || (s.errors && s.errors.length > 0);
  return (
    <div className="grid grid-cols-12 gap-2 px-3 py-2 text-xs items-center bg-surface-hover border border-border rounded">
      <span className="col-span-1 font-mono text-text-muted">{formatTs(s.startedAt)}</span>
      <span className="col-span-1 font-mono text-text-muted">{formatTs(s.finishedAt)}</span>
      <span className="col-span-2 truncate text-text-secondary">
        {s.type === "manual" ? "Manual" : "Auto"} · {s.status}
      </span>
      <span className="col-span-3 truncate text-text-primary">{syncTargetLabel(s, peerName)}</span>
      <span className="col-span-5 text-text-secondary tabular-nums">
        Artists: {s.artistCount ?? 0} · Albums: {s.albumCount ?? 0} · Tracks: {s.trackCount ?? 0}
        {failed && s.errors && s.errors.length > 0 && (
          <span className="text-error ml-2 truncate">· {s.errors[0]}</span>
        )}
      </span>
    </div>
  );
}

interface MergedHistoryItem {
  ts: string;
  kind: "stream" | "sync";
  stream?: StreamOperation;
  sync?: SyncOperation;
}

const ACTIVE_PAGE_SIZE = 10;
const HISTORY_PAGE_SIZE = 50;

function Pager({
  page,
  pageCount,
  onChange,
}: {
  page: number;
  pageCount: number;
  onChange: (p: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-2 mt-2 text-xs text-text-secondary">
      <button
        onClick={() => onChange(Math.max(0, page - 1))}
        disabled={page === 0}
        className="px-2 py-0.5 border border-border rounded disabled:opacity-40 hover:bg-surface-hover"
      >
        Prev
      </button>
      <span className="tabular-nums">
        Page {page + 1} of {pageCount}
      </span>
      <button
        onClick={() => onChange(Math.min(pageCount - 1, page + 1))}
        disabled={page >= pageCount - 1}
        className="px-2 py-0.5 border border-border rounded disabled:opacity-40 hover:bg-surface-hover"
      >
        Next
      </button>
    </div>
  );
}

export function ActivityPage() {
  const queryClient = useQueryClient();
  const [showStream, setShowStream] = useState(true);
  const [showSync, setShowSync] = useState(true);
  const [activeStreamPage, setActiveStreamPage] = useState(0);
  const [activeSyncPage, setActiveSyncPage] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);

  const { data: peers } = useQuery({
    queryKey: ["peers-summary"],
    queryFn: getPeersSummary,
    staleTime: 60_000,
  });

  const peerName = (id: string): string => {
    const peer = peers?.find((p) => p.id === id);
    return peerDisplayName(peer?.name ?? id);
  };

  const { data: active } = useQuery({
    queryKey: ["activity-active"],
    queryFn: getActiveActivity,
    refetchInterval: 3000,
  });

  const kinds: ActivityHistoryKind[] = [];
  if (showStream) kinds.push("stream");
  if (showSync) kinds.push("sync");

  const { data: history } = useQuery({
    queryKey: ["activity-history", kinds.join(",")],
    queryFn: () => getActivityHistory(kinds, 1000),
    refetchInterval: 15000,
    enabled: kinds.length > 0,
  });

  const clearMutation = useMutation({
    mutationFn: clearActivityHistory,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["activity-history"] });
    },
  });

  const merged: MergedHistoryItem[] = [];
  if (history) {
    for (const s of history.streams) merged.push({ ts: s.startedAt, kind: "stream", stream: s });
    for (const s of history.syncs) merged.push({ ts: s.startedAt, kind: "sync", sync: s });
    merged.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  }

  const activeStreams = active?.streams ?? [];
  const activeSyncs = active?.syncs ?? [];
  const activeStreamPageCount = Math.max(1, Math.ceil(activeStreams.length / ACTIVE_PAGE_SIZE));
  const activeSyncPageCount = Math.max(1, Math.ceil(activeSyncs.length / ACTIVE_PAGE_SIZE));
  const historyPageCount = Math.max(1, Math.ceil(merged.length / HISTORY_PAGE_SIZE));
  const clampedActiveStreamPage = Math.min(activeStreamPage, activeStreamPageCount - 1);
  const clampedActiveSyncPage = Math.min(activeSyncPage, activeSyncPageCount - 1);
  const clampedHistoryPage = Math.min(historyPage, historyPageCount - 1);
  const visibleActiveStreams = activeStreams.slice(
    clampedActiveStreamPage * ACTIVE_PAGE_SIZE,
    (clampedActiveStreamPage + 1) * ACTIVE_PAGE_SIZE,
  );
  const visibleActiveSyncs = activeSyncs.slice(
    clampedActiveSyncPage * ACTIVE_PAGE_SIZE,
    (clampedActiveSyncPage + 1) * ACTIVE_PAGE_SIZE,
  );
  const visibleHistory = merged.slice(
    clampedHistoryPage * HISTORY_PAGE_SIZE,
    (clampedHistoryPage + 1) * HISTORY_PAGE_SIZE,
  );

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
      {/* Active */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Radio className="w-5 h-5 text-accent" />
          <h1 className="text-xl font-bold text-text-primary">Active</h1>
        </div>

        <div className="space-y-3">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <Activity className="w-4 h-4 text-text-muted" />
              <span className="text-sm font-medium text-text-secondary">Streams</span>
              <span className="text-xs text-text-muted">({activeStreams.length})</span>
            </div>
            {visibleActiveStreams.length > 0 ? (
              <>
                <div className="space-y-1">
                  {visibleActiveStreams.map((s) => (
                    <ActiveStreamRow key={s.id} s={s} peerName={peerName} />
                  ))}
                </div>
                <Pager
                  page={clampedActiveStreamPage}
                  pageCount={activeStreamPageCount}
                  onChange={setActiveStreamPage}
                />
              </>
            ) : (
              <p className="text-xs text-text-muted px-3 py-2">No active streams</p>
            )}
          </div>

          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <RefreshCw className="w-4 h-4 text-text-muted" />
              <span className="text-sm font-medium text-text-secondary">Syncs</span>
              <span className="text-xs text-text-muted">({activeSyncs.length})</span>
            </div>
            {visibleActiveSyncs.length > 0 ? (
              <>
                <div className="space-y-1">
                  {visibleActiveSyncs.map((s) => (
                    <ActiveSyncRow key={s.id} s={s} peerName={peerName} />
                  ))}
                </div>
                <Pager
                  page={clampedActiveSyncPage}
                  pageCount={activeSyncPageCount}
                  onChange={setActiveSyncPage}
                />
              </>
            ) : (
              <p className="text-xs text-text-muted px-3 py-2">No active syncs</p>
            )}
          </div>
        </div>
      </section>

      {/* History */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold text-text-primary">History</h2>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-text-secondary">
              <input
                type="checkbox"
                checked={showStream}
                onChange={(e) => setShowStream(e.target.checked)}
              />
              Streams
            </label>
            <label className="flex items-center gap-1.5 text-xs text-text-secondary">
              <input
                type="checkbox"
                checked={showSync}
                onChange={(e) => setShowSync(e.target.checked)}
              />
              Syncs
            </label>
            <button
              onClick={() => {
                if (window.confirm("Clear all activity history?")) clearMutation.mutate();
              }}
              disabled={clearMutation.isPending}
              className={cn(
                "px-2 py-1 text-xs bg-surface border border-border rounded hover:bg-error/10 hover:border-error/40 hover:text-error transition-colors disabled:opacity-50",
              )}
            >
              {clearMutation.isPending ? "Clearing…" : "Clear"}
            </button>
          </div>
        </div>

        {merged.length === 0 ? (
          <p className="text-sm text-text-muted px-3 py-4">No history</p>
        ) : (
          <>
            <div className="space-y-1">
              {visibleHistory.map((m) =>
                m.kind === "stream" && m.stream ? (
                  <HistoryStreamRow key={`s-${m.stream.id}`} s={m.stream} peerName={peerName} />
                ) : m.sync ? (
                  <HistorySyncRow key={`y-${m.sync.id}`} s={m.sync} peerName={peerName} />
                ) : null,
              )}
            </div>
            <Pager
              page={clampedHistoryPage}
              pageCount={historyPageCount}
              onChange={setHistoryPage}
            />
          </>
        )}
      </section>
    </div>
  );
}
