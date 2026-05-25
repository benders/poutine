import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getActivitySettings, updateActivitySettings } from "@/lib/api";
import { Activity } from "lucide-react";

export function ActivitySection() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ["admin-activity-settings"],
    queryFn: getActivitySettings,
  });

  const [maxEvents, setMaxEvents] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (settings && !dirty) {
      setMaxEvents(String(settings.maxEvents));
    }
  }, [settings, dirty]);

  const saveMutation = useMutation({
    mutationFn: () => updateActivitySettings({ maxEvents: parseInt(maxEvents, 10) }),
    onSuccess: () => {
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ["admin-activity-settings"] });
    },
  });

  if (isLoading || !settings) {
    return (
      <div className="bg-surface border border-border rounded-lg px-4 py-3">
        <p className="text-sm text-text-muted">Loading activity settings...</p>
      </div>
    );
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Activity className="w-4 h-4 text-text-muted" />
        <span className="text-sm font-medium text-text-primary">Activity History</span>
      </div>
      <p className="text-xs text-text-muted">
        Maximum number of stored events (streams and syncs each capped independently).
        Pruned to the most recent N rows when exceeded.
      </p>
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className="block text-sm text-text-secondary mb-1">Max Events</label>
          <input
            type="number"
            min="0"
            step="1"
            value={maxEvents}
            onChange={(e) => {
              setMaxEvents(e.target.value);
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
      </div>
      {saveMutation.isError && (
        <p className="text-sm text-error">
          {saveMutation.error instanceof Error ? saveMutation.error.message : "Failed to save"}
        </p>
      )}
    </div>
  );
}
