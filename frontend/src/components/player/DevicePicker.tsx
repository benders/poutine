import { useRef, useState } from "react";
import { Cast, MonitorSpeaker } from "lucide-react";
import { usePlayer } from "@/stores/player";
import { getSonosDevices, type SonosDevice } from "@/lib/api";
import { cn } from "@/lib/cn";

/**
 * Switches the player between local browser audio and a Sonos device.
 * Fetches the device list when opened (not on every render). Hidden by
 * PlayerBar when the backend capabilities probe says sonos is off.
 */
export function DevicePicker() {
  const sink = usePlayer((s) => s.sink);
  const setSink = usePlayer((s) => s.setSink);
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<SonosDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bump on each open; in-flight fetches with a stale id discard their result.
  const requestId = useRef(0);

  function toggle() {
    if (open) {
      setOpen(false);
      requestId.current++;
      return;
    }
    setOpen(true);
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    getSonosDevices()
      .then((res) => {
        if (id !== requestId.current) return;
        setDevices(res.devices);
      })
      .catch((err) => {
        if (id !== requestId.current) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }

  const active = sink !== "local";
  const label = sink === "local" ? "This browser" : sink.deviceName;

  return (
    <div className="relative">
      <button
        onClick={toggle}
        title={`Playing on: ${label}`}
        className={cn(
          "p-1 transition-colors",
          active ? "text-accent" : "text-text-muted hover:text-text-primary",
        )}
      >
        <Cast className="w-4 h-4" />
      </button>
      {open && (
        <div className="absolute bottom-8 right-0 w-56 bg-surface border border-border rounded shadow-lg z-50 py-1 text-sm">
          <button
            onClick={() => {
              setSink("local");
              setOpen(false);
            }}
            className={cn(
              "w-full text-left px-3 py-2 hover:bg-surface-active flex items-center gap-2",
              sink === "local" && "text-accent",
            )}
          >
            <MonitorSpeaker className="w-4 h-4" />
            This browser
          </button>
          <div className="my-1 border-t border-border" />
          {loading && (
            <div className="px-3 py-2 text-text-muted">Searching…</div>
          )}
          {error && <div className="px-3 py-2 text-red-400">{error}</div>}
          {!loading && !error && devices.length === 0 && (
            <div className="px-3 py-2 text-text-muted">
              No Sonos devices found
            </div>
          )}
          {devices.map((d) => {
            const selected = sink !== "local" && sink.deviceId === d.id;
            return (
              <button
                key={d.id}
                onClick={() => {
                  setSink({
                    type: "sonos",
                    deviceId: d.id,
                    deviceName: d.room,
                  });
                  setOpen(false);
                }}
                className={cn(
                  "w-full text-left px-3 py-2 hover:bg-surface-active flex items-center gap-2",
                  selected && "text-accent",
                )}
              >
                <Cast className="w-4 h-4" />
                <div>
                  <div>{d.room}</div>
                  <div className="text-xs text-text-muted">{d.model}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
