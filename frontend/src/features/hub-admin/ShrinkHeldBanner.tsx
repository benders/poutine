import { useMutation, useQueryClient } from "@tanstack/react-query";
import { acceptShrink, triggerSync } from "@/lib/api";
import { formatTimeAgo } from "@/lib/format";
import { AlertTriangle } from "lucide-react";

/**
 * Library-shrink guard notice (#297). Shown while a sync's deletions are held
 * because the library shrank too far — usually an unmounted share, which
 * clears itself on the next good sync. "Accept removal" is for a genuine
 * large deletion: it arms the one-shot override, then runs the sync.
 */
export function ShrinkHeldBanner({
  instanceId,
  heldSince,
  message,
}: {
  instanceId: string;
  heldSince: string;
  message?: string | null;
}) {
  const queryClient = useQueryClient();
  const acceptMutation = useMutation({
    mutationFn: async () => {
      await acceptShrink(instanceId);
      return triggerSync();
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-instance"] });
      queryClient.invalidateQueries({ queryKey: ["admin-peers"] });
      queryClient.invalidateQueries({ queryKey: ["albumList2"] });
      queryClient.invalidateQueries({ queryKey: ["artists"] });
    },
  });

  return (
    <div role="alert" className="p-3 bg-warning/10 border border-warning/20 rounded-lg text-sm space-y-2">
      <div className="flex items-start gap-2 text-warning">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="font-medium">Library sync held since {formatTimeAgo(heldSince)}</p>
          {message && <p className="text-xs">{message}</p>}
          <p className="text-xs text-text-secondary">
            The catalog was kept because the library shrank too far. If a music share is
            unmounted, fix it — the next scan and sync clear this. If the music really was
            removed, accept the removal.
          </p>
        </div>
      </div>
      {acceptMutation.isError && (
        <p className="text-xs text-error">
          {acceptMutation.error instanceof Error ? acceptMutation.error.message : "Accept failed"}
        </p>
      )}
      <button
        onClick={() => {
          if (window.confirm("Remove the missing tracks from the catalog? Use this only if the music was deleted on purpose.")) {
            acceptMutation.mutate();
          }
        }}
        disabled={acceptMutation.isPending}
        className="ml-6 px-3 py-1.5 bg-surface border border-warning/40 hover:bg-warning/10 rounded-lg text-xs text-warning transition-colors disabled:opacity-50"
      >
        {acceptMutation.isPending ? "Applying…" : "Accept removal"}
      </button>
    </div>
  );
}
