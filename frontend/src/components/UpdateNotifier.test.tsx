/**
 * Tests for the SPA auto-update flow (issue #196): poll /api/version,
 * auto-reload when safe, defer with a manual banner while playing locally,
 * and never reload-loop on a persistent mismatch.
 *
 * `@/lib/reload` is mocked (jsdom can't navigate); short poll/recheck
 * intervals + real timers keep react-query's polling machinery happy.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UpdateNotifier } from "./UpdateNotifier";
import { usePlayer } from "@/stores/player";
import type { SubsonicSong } from "@/lib/subsonic";
import { reloadPage } from "@/lib/reload";

vi.mock("@/lib/reload", () => ({ reloadPage: vi.fn() }));

const RELOADED_FOR_KEY = "updateReloadedForBuild";

function track(id: string): SubsonicSong {
  return {
    id,
    title: "T",
    album: "A",
    albumId: "al-1",
    artist: "Ar",
    artistId: "ar-1",
    durationMs: 180_000,
  };
}

/** Stub fetch to serve buildIds in sequence; the last one repeats forever. */
function mockVersionSequence(...buildIds: string[]) {
  let call = 0;
  const fn = vi.fn(async () => {
    const buildId = buildIds[Math.min(call, buildIds.length - 1)];
    call++;
    return {
      ok: true,
      json: async () => ({ appVersion: "0.5.5", buildId }),
    } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function renderNotifier() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UpdateNotifier pollIntervalMs={25} recheckIntervalMs={25} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  usePlayer.setState({
    queue: [],
    currentIndex: -1,
    isPlaying: false,
    currentTime: 0,
    sink: "local",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("UpdateNotifier", () => {
  it("shows nothing while the server buildId matches the baseline", async () => {
    const fetchMock = mockVersionSequence("aaaa");
    renderNotifier();
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    expect(screen.queryByRole("status")).toBeNull();
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it("auto-reloads when playback is paused, saving a snapshot + loop guard", async () => {
    mockVersionSequence("aaaa", "bbbb");
    usePlayer.setState({ queue: [track("t1")], currentIndex: 0, isPlaying: false });
    renderNotifier();

    await waitFor(() => expect(reloadPage).toHaveBeenCalled());
    expect(sessionStorage.getItem(RELOADED_FOR_KEY)).toBe("bbbb");
    const snapshot = sessionStorage.getItem("playerSnapshot");
    expect(snapshot).not.toBeNull();
    expect(JSON.parse(snapshot!).queue[0].id).toBe("t1");
  });

  it("auto-reloads mid-play when the sink is Sonos — the device keeps playing", async () => {
    mockVersionSequence("aaaa", "bbbb");
    usePlayer.setState({
      queue: [track("t1")],
      currentIndex: 0,
      isPlaying: true,
      sink: { type: "sonos", deviceId: "dev-1", deviceName: "Kitchen" },
    });
    renderNotifier();
    await waitFor(() => expect(reloadPage).toHaveBeenCalled());
  });

  it("defers while playing locally and offers a manual Reload button", async () => {
    mockVersionSequence("aaaa", "bbbb");
    usePlayer.setState({ queue: [track("t1")], currentIndex: 0, isPlaying: true, sink: "local" });
    renderNotifier();

    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("Update available");
    // Give the recheck interval a few beats: still no auto reload.
    await new Promise((r) => setTimeout(r, 80));
    expect(reloadPage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("playerSnapshot")).not.toBeNull();
  });

  it("fires the deferred reload once local playback pauses", async () => {
    mockVersionSequence("aaaa", "bbbb");
    usePlayer.setState({ queue: [track("t1")], currentIndex: 0, isPlaying: true, sink: "local" });
    renderNotifier();

    await screen.findByRole("status");
    expect(reloadPage).not.toHaveBeenCalled();

    act(() => {
      usePlayer.setState({ isPlaying: false });
    });
    await waitFor(() => expect(reloadPage).toHaveBeenCalled());
  });

  it("never auto-reloads twice for the same buildId (loop guard)", async () => {
    // Simulate the post-reload state where the mismatch persists (e.g. a
    // cached index.html): we already reloaded for "bbbb".
    sessionStorage.setItem(RELOADED_FOR_KEY, "bbbb");
    mockVersionSequence("aaaa", "bbbb");
    renderNotifier();

    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("Update available");
    await new Promise((r) => setTimeout(r, 80));
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it("ignores 'dev' and 'unknown' buildIds — states, not builds", async () => {
    const fetchMock = mockVersionSequence("aaaa", "unknown", "dev");
    renderNotifier();
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(2));
    expect(screen.queryByRole("status")).toBeNull();
    expect(reloadPage).not.toHaveBeenCalled();
  });
});
