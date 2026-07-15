import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ActivityPage } from "./ActivityPage";
import type { NowPlayingActivityEntry } from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getActiveActivity: vi.fn(),
    getActivityHistory: vi.fn(),
    getPeersSummary: vi.fn(),
  };
});

import { getActiveActivity, getActivityHistory, getPeersSummary } from "@/lib/api";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ActivityPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const NP_ENTRY: NowPlayingActivityEntry = {
  userId: "user-1",
  username: "nic",
  trackId: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
  trackTitle: "Idioteque",
  artistName: "Radiohead",
  clientName: "poutine/1.2.3",
  playerId: 1,
  startedAt: "2026-07-14 20:00:00",
  updatedAt: "2026-07-14 20:03:00",
  minutesAgo: 3,
};

beforeEach(() => {
  vi.mocked(getActiveActivity).mockReset();
  vi.mocked(getActivityHistory).mockReset();
  vi.mocked(getPeersSummary).mockReset();
  vi.mocked(getPeersSummary).mockResolvedValue([]);
  vi.mocked(getActivityHistory).mockResolvedValue({ streams: [], syncs: [] });
});

describe("ActivityPage now-playing (#237)", () => {
  it("renders now-playing entries in the Streams list", async () => {
    vi.mocked(getActiveActivity).mockResolvedValue({
      nowPlaying: [NP_ENTRY],
      streams: [],
      syncs: [],
    });
    renderPage();

    await waitFor(() => expect(screen.getByText("Idioteque")).toBeTruthy());
    expect(screen.getByText("Playing")).toBeTruthy();
    expect(screen.getByText("nic")).toBeTruthy();
    expect(screen.getByText("poutine/1.2.3")).toBeTruthy();
    expect(screen.getByText("3m ago")).toBeTruthy();
    // Streams counter includes the now-playing entry.
    expect(screen.getByText("(1)")).toBeTruthy();
  });

  it("shows the empty state when nothing is playing or transferring", async () => {
    vi.mocked(getActiveActivity).mockResolvedValue({
      nowPlaying: [],
      streams: [],
      syncs: [],
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("No active streams")).toBeTruthy(),
    );
  });
});
