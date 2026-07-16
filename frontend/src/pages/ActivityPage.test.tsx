import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ActivityPage } from "./ActivityPage";
import type { NowPlayingActivityEntry, StreamOperation } from "@/lib/api";

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

const RG_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

const NP_ENTRY: NowPlayingActivityEntry = {
  userId: "user-1",
  username: "nic",
  trackId: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
  trackTitle: "Idioteque",
  artistName: "Radiohead",
  albumId: RG_ID,
  clientName: "poutine/1.2.3",
  sourceKind: "local",
  sourcePeerId: null,
  format: "flac",
  bitrate: 1411,
  playerId: 1,
  startedAt: "2026-07-14 20:00:00",
  updatedAt: "2026-07-14 20:03:00",
  minutesAgo: 3,
};

function streamOp(overrides: Partial<StreamOperation> = {}): StreamOperation {
  return {
    id: "op-1",
    kind: "subsonic",
    username: "nic",
    trackId: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
    trackTitle: "Idioteque",
    artistName: "Radiohead",
    albumId: RG_ID,
    clientName: "poutine/1.2.3",
    clientVersion: "1.16.1",
    peerId: null,
    sourceKind: "local",
    sourcePeerId: null,
    format: "flac",
    bitrate: 1411,
    transcoded: false,
    maxBitrate: null,
    startedAt: "2026-07-14 20:00:00",
    finishedAt: "2026-07-14 20:00:05",
    durationMs: 5000,
    bytesTransferred: 1024,
    error: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(getActiveActivity).mockReset();
  vi.mocked(getActivityHistory).mockReset();
  vi.mocked(getPeersSummary).mockReset();
  vi.mocked(getPeersSummary).mockResolvedValue([]);
  vi.mocked(getActivityHistory).mockResolvedValue({ streams: [], syncs: [] });
});

describe("ActivityPage now-playing (#237)", () => {
  it("renders now-playing entries in their own Now Playing section", async () => {
    vi.mocked(getActiveActivity).mockResolvedValue({
      nowPlaying: [NP_ENTRY],
      streams: [],
      syncs: [],
    });
    renderPage();

    await waitFor(() => expect(screen.getByText("Idioteque")).toBeTruthy());
    expect(screen.getByText("Now Playing")).toBeTruthy();
    expect(screen.getByText("nic")).toBeTruthy();
    expect(screen.getByText("poutine/1.2.3")).toBeTruthy();
    expect(screen.getByText("3m ago")).toBeTruthy();
    // Source snapshot (#263): format · bitrate + source.
    expect(screen.getByText("flac · 1411kbps")).toBeTruthy();
    expect(screen.getByText("Local")).toBeTruthy();
    // Track title links to its album.
    const link = screen.getByRole("link", { name: "Idioteque" });
    expect(link.getAttribute("href")).toBe(`/albums/al${RG_ID}`);
  });

  it("shows empty states for both Now Playing and Transfers", async () => {
    vi.mocked(getActiveActivity).mockResolvedValue({
      nowPlaying: [],
      streams: [],
      syncs: [],
    });
    renderPage();

    await waitFor(() => expect(screen.getByText("Nothing playing")).toBeTruthy());
    expect(screen.getByText("No active transfers")).toBeTruthy();
  });
});

describe("ActivityPage history coalescing (#263)", () => {
  it("collapses consecutive same-listen transfers into one ×N row", async () => {
    vi.mocked(getActiveActivity).mockResolvedValue({
      nowPlaying: [],
      streams: [],
      syncs: [],
    });
    vi.mocked(getActivityHistory).mockResolvedValue({
      streams: [
        streamOp({ id: "op-3", startedAt: "2026-07-14 20:00:02", bytesTransferred: 300 }),
        streamOp({ id: "op-2", startedAt: "2026-07-14 20:00:01", bytesTransferred: 200 }),
        streamOp({ id: "op-1", startedAt: "2026-07-14 20:00:00", bytesTransferred: 100 }),
      ],
      syncs: [],
    });
    renderPage();

    await waitFor(() => expect(screen.getByText("Idioteque")).toBeTruthy());
    // One row, not three; bytes are summed.
    expect(screen.getAllByText("Idioteque")).toHaveLength(1);
    expect(screen.getByText(/×3/)).toBeTruthy();
    expect(screen.getByText(/600 B/)).toBeTruthy();
  });

  it("does not collapse transfers from different clients", async () => {
    vi.mocked(getActiveActivity).mockResolvedValue({
      nowPlaying: [],
      streams: [],
      syncs: [],
    });
    vi.mocked(getActivityHistory).mockResolvedValue({
      streams: [
        streamOp({ id: "op-2", clientName: "Amperfy" }),
        streamOp({ id: "op-1" }),
      ],
      syncs: [],
    });
    renderPage();

    await waitFor(() => expect(screen.getAllByText("Idioteque")).toHaveLength(2));
    expect(screen.queryByText(/×2/)).toBeNull();
  });
});
