import { useQuery } from "@tanstack/react-query";
import { getPlayerHealth } from "@/lib/api";
import { SonosSection } from "./SonosSection";
import { Speaker } from "lucide-react";

/**
 * Player admin destination — owns Player-side concerns: LAN URL, Sonos
 * casting, DLNA toggles. Gated on a `/player/health` probe: if the host
 * doesn't expose a Player (a future deploy-split outcome of #220), the
 * route renders a placeholder and makes no further admin calls.
 *
 * Sibling: `features/hub-admin/HubAdminPage`. The two pages must never
 * co-exist on the same view — see #212.
 */
export function PlayerAdminPage() {
  const { data: health, isLoading } = useQuery({
    queryKey: ["player-health"],
    queryFn: getPlayerHealth,
    // No retries — we want the "absent" state to surface fast.
    retry: false,
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <p className="text-sm text-text-muted">Checking for Player…</p>
      </div>
    );
  }

  if (!health) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div
          role="status"
          className="bg-surface border border-border rounded-lg p-6 text-center space-y-3"
        >
          <Speaker className="w-8 h-8 text-text-muted mx-auto" />
          <h1 className="text-lg font-semibold text-text-primary">
            Player not deployed on this host
          </h1>
          <p className="text-sm text-text-muted max-w-prose mx-auto">
            This Poutine instance is running Hub-only. Player features
            (Sonos casting, DLNA MediaServer, LAN URL) live on a separate
            deployment. Deploy the Player on a host with LAN access to
            manage these settings.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-10">
      <section>
        <h1 className="text-xl font-bold text-text-primary mb-4">Sonos</h1>
        <SonosSection />
      </section>
    </div>
  );
}
