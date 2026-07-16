/**
 * SPA auto-update (issue #196).
 *
 * Polls the hub's lightweight `GET /api/version` and compares the reported
 * `buildId` (a hash of the on-disk SPA index.html — see
 * hub/src/services/spa-build-id.ts) against the one this tab booted with.
 * Any difference means a new build is deployed:
 *
 * - Auto-reload when it can't interrupt anything: playback paused, or the
 *   sink is a Sonos device (the speaker keeps playing; this tab is just a
 *   remote), and no text input is focused. Player state is snapshotted to
 *   sessionStorage first and restored on boot (lib/player-snapshot.ts).
 * - While playing locally (a reload would cut the audio) or mid-input, show
 *   a subtle banner with a manual Reload button and re-check periodically —
 *   the reload happens once the user pauses or the queue ends.
 * - Loop guard: the buildId we already reloaded for is remembered in
 *   sessionStorage. If the mismatch persists after that reload (e.g. a
 *   cached index.html), we never auto-reload again for the same id — the
 *   banner stays as the manual path instead of reload-looping the tab.
 *
 * The baseline is the first successful poll after boot rather than a
 * build-time constant, so nothing needs to be baked into the bundle. A
 * deploy landing in the window between page load and that first poll goes
 * unnoticed until the next deploy — acceptable, and the loop guard covers
 * the odd cases.
 */

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { usePlayer } from "@/stores/player";
import { savePlayerSnapshot } from "@/lib/player-snapshot";
import { reloadPage } from "@/lib/reload";

const RELOADED_FOR_KEY = "updateReloadedForBuild";
/** Mirrors DEV_BUILD_ID / UNKNOWN_BUILD_ID in hub/src/services/spa-build-id.ts. */
const NON_BUILD_IDS = new Set(["dev", "unknown"]);

interface VersionInfo {
  appVersion: string;
  buildId: string;
}

async function fetchVersion(): Promise<VersionInfo> {
  // Plain fetch — the endpoint is unauthenticated, so no JWT refresh dance.
  const res = await fetch("/api/version");
  if (!res.ok) throw new Error(`version probe failed: ${res.status}`);
  return (await res.json()) as VersionInfo;
}

function isTextInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    (el as HTMLElement).isContentEditable
  );
}

/** Safe to reload out from under the user right now? */
function reloadIsSafe(): boolean {
  const { isPlaying, sink } = usePlayer.getState();
  if (isPlaying && sink === "local") return false;
  if (isTextInputFocused()) return false;
  return true;
}

function saveAndReload(buildId: string): void {
  savePlayerSnapshot();
  try {
    sessionStorage.setItem(RELOADED_FOR_KEY, buildId);
  } catch {
    // Storage failure just weakens the loop guard; still reload.
  }
  reloadPage();
}

export function UpdateNotifier({
  pollIntervalMs = 60_000,
  recheckIntervalMs = 5_000,
}: {
  pollIntervalMs?: number;
  recheckIntervalMs?: number;
} = {}) {
  // The buildId this tab booted with = first successful poll. Captured in
  // the queryFn (not render — react-hooks/refs) and echoed back alongside
  // each response so render works from plain data.
  const baselineRef = useRef<string | null>(null);
  const { data } = useQuery({
    queryKey: ["app-version"],
    queryFn: async () => {
      const info = await fetchVersion();
      baselineRef.current ??= info.buildId;
      return { ...info, baseline: baselineRef.current };
    },
    refetchInterval: pollIntervalMs,
    // A hidden tab doesn't need to chase updates; the focus refetch
    // (react-query default) catches up the moment the user returns.
    refetchIntervalInBackground: false,
    staleTime: 0,
    retry: false,
  });

  const serverBuildId = data?.buildId ?? null;
  const updateAvailable = Boolean(
    data &&
      serverBuildId &&
      serverBuildId !== data.baseline &&
      // "dev" (Vite owns updates) and "unknown" (index.html unreadable,
      // e.g. mid-deploy) are states, not builds — never reload onto them.
      !NON_BUILD_IDS.has(serverBuildId),
  );

  // Auto-reload as soon as it's safe. Re-check on an interval so a deferred
  // reload fires when local playback pauses/ends or the input blurs.
  useEffect(() => {
    if (!updateAvailable || !serverBuildId) return;
    let alreadyReloaded = false;
    try {
      alreadyReloaded = sessionStorage.getItem(RELOADED_FOR_KEY) === serverBuildId;
    } catch {
      // Treat unreadable storage as not-yet-reloaded; the guard write in
      // saveAndReload will fail the same way, but a single extra reload
      // attempt is harmless.
    }
    if (alreadyReloaded) return;

    const tryReload = () => {
      if (reloadIsSafe()) saveAndReload(serverBuildId);
    };
    tryReload();
    const timer = window.setInterval(tryReload, recheckIntervalMs);
    return () => window.clearInterval(timer);
  }, [updateAvailable, serverBuildId, recheckIntervalMs]);

  if (!updateAvailable || !serverBuildId) return null;

  return (
    <div
      role="status"
      className="fixed bottom-24 left-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-player p-3 text-sm shadow-lg"
    >
      <RefreshCw className="w-4 h-4 shrink-0 text-text-muted" />
      <div className="min-w-0">
        <p className="font-medium text-text-primary">Update available</p>
        <p className="text-xs text-text-muted mt-0.5">
          A new version of Poutine is ready.
        </p>
      </div>
      <button
        onClick={() => saveAndReload(serverBuildId)}
        className="shrink-0 rounded px-3 py-1.5 bg-text-primary text-background text-xs font-medium hover:opacity-90 transition-opacity"
      >
        Reload
      </button>
    </div>
  );
}
