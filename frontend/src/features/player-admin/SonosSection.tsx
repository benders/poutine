import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getSonosSettings, updateSonosSettings } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Speaker } from "lucide-react";

export function SonosSection() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ["admin-sonos-settings"],
    queryFn: getSonosSettings,
  });

  const [volumeCap, setVolumeCap] = useState("");
  const [dirtyCap, setDirtyCap] = useState(false);
  const [lanUrl, setLanUrl] = useState("");
  const [dirtyLan, setDirtyLan] = useState(false);
  const [capSyncedFrom, setCapSyncedFrom] = useState(settings);
  const [lanSyncedFrom, setLanSyncedFrom] = useState(settings);

  if (settings !== capSyncedFrom && !dirtyCap) {
    setCapSyncedFrom(settings);
    if (settings) setVolumeCap(String(settings.volumeCap));
  }
  if (settings !== lanSyncedFrom && !dirtyLan) {
    setLanSyncedFrom(settings);
    if (settings) setLanUrl(settings.lanUrl);
  }

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => updateSonosSettings({ enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-sonos-settings"] });
      // Capabilities probe drives DevicePicker visibility — refresh so the
      // PlayerBar reflects the new state on the next render.
      queryClient.invalidateQueries({ queryKey: ["capabilities"] });
    },
  });

  const capMutation = useMutation({
    mutationFn: (cap: number) => updateSonosSettings({ volumeCap: cap }),
    onSuccess: () => {
      setDirtyCap(false);
      queryClient.invalidateQueries({ queryKey: ["admin-sonos-settings"] });
    },
  });

  const lanMutation = useMutation({
    mutationFn: (value: string) => updateSonosSettings({ lanUrl: value }),
    onSuccess: () => {
      setDirtyLan(false);
      queryClient.invalidateQueries({ queryKey: ["admin-sonos-settings"] });
    },
  });

  if (isLoading || !settings) {
    return (
      <div className="bg-surface border border-border rounded-lg px-4 py-3">
        <p className="text-sm text-text-muted">Loading Sonos settings...</p>
      </div>
    );
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Speaker className="w-4 h-4 text-text-muted" />
        <span className="text-sm font-medium text-text-primary">Sonos Casting</span>
      </div>
      <p className="text-xs text-text-muted">
        When enabled, the hub discovers Sonos zones on the LAN and the player
        gains a device picker. Requires <code>network_mode: host</code> and a
        LAN URL reachable from Sonos devices (set below — Sonos cannot be
        enabled until it is). Disabling stops discovery and stops any
        in-flight casts immediately.
      </p>

      {/* LAN URL leads — every other Player feature depends on it. */}
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className="block text-sm text-text-secondary mb-1">
            LAN URL
          </label>
          <input
            type="url"
            placeholder="http://192.168.1.10:3000"
            value={lanUrl}
            onChange={(e) => {
              setLanUrl(e.target.value);
              setDirtyLan(true);
            }}
            className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent"
          />
          <p className="mt-1 text-xs text-text-muted">
            Absolute base URL Sonos + DLNA devices use to fetch streams from
            this hub. Must be reachable on the LAN (a public hostname or LAN
            IP, not <code>localhost</code>). Shared with the DLNA MediaServer.
            Leave empty to disable.
          </p>
        </div>
        <button
          onClick={() => lanMutation.mutate(lanUrl.trim())}
          disabled={!dirtyLan || lanMutation.isPending}
          className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
        >
          {lanMutation.isPending ? "Saving..." : "Save"}
        </button>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-text-primary">
            Status:{" "}
            <span className={cn(settings.enabled ? "text-success" : "text-text-muted")}>
              {settings.enabled ? "Enabled" : "Disabled"}
            </span>
          </p>
        </div>
        <button
          onClick={() => toggleMutation.mutate(!settings.enabled)}
          disabled={
            toggleMutation.isPending ||
            (!settings.enabled && !settings.lanUrl)
          }
          title={
            !settings.enabled && !settings.lanUrl
              ? "Set a LAN URL above before enabling Sonos"
              : undefined
          }
          className={cn(
            "px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
            settings.enabled
              ? "bg-surface border border-border hover:bg-surface-hover text-text-primary"
              : "bg-accent hover:bg-accent-hover text-white",
          )}
        >
          {toggleMutation.isPending
            ? "Saving..."
            : settings.enabled
            ? "Disable"
            : "Enable"}
        </button>
      </div>

      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className="block text-sm text-text-secondary mb-1">
            Volume Cap (0–100)
          </label>
          <input
            type="number"
            min="0"
            max="100"
            step="1"
            value={volumeCap}
            onChange={(e) => {
              setVolumeCap(e.target.value);
              setDirtyCap(true);
            }}
            className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent"
          />
          <p className="mt-1 text-xs text-text-muted">
            Hard ceiling applied to every SetVolume the hub issues. Sonos
            volume above this is silently clamped.
          </p>
        </div>
        <button
          onClick={() => capMutation.mutate(parseInt(volumeCap, 10))}
          disabled={!dirtyCap || capMutation.isPending}
          className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
        >
          {capMutation.isPending ? "Saving..." : "Save"}
        </button>
      </div>

      {(toggleMutation.isError || capMutation.isError || lanMutation.isError) && (
        <p className="text-sm text-error">
          {(toggleMutation.error || capMutation.error || lanMutation.error) instanceof Error
            ? (toggleMutation.error || capMutation.error || lanMutation.error)!.message
            : "Failed to save"}
        </p>
      )}
    </div>
  );
}
