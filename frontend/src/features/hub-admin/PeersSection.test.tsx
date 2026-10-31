import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PeersSection } from "./PeersSection";
import type { Peer } from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getPeers: vi.fn(),
    triggerSync: vi.fn(),
    deletePeerData: vi.fn(),
    disablePeer: vi.fn(),
    enablePeer: vi.fn(),
    removePeer: vi.fn(),
    acceptShrink: vi.fn(),
  };
});

import { getPeers, disablePeer, enablePeer, removePeer, acceptShrink, triggerSync } from "@/lib/api";

function basePeer(overrides: Partial<Peer> = {}): Peer {
  return {
    id: "peer-a",
    url: "http://peer-a.example.com",
    publicKey: "ed25519:abc",
    lifecycle: "active",
    status: "online",
    lastSeen: null,
    lastSynced: null,
    lastSyncOk: null,
    lastSyncMessage: null,
    shrinkHeldAt: null,
    trackCount: 0,
    artistCount: 0,
    albumCount: 0,
    appVersion: null,
    apiVersion: null,
    ...overrides,
  };
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PeersSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getPeers).mockReset();
  vi.mocked(disablePeer).mockReset();
  vi.mocked(enablePeer).mockReset();
  vi.mocked(removePeer).mockReset();
  vi.mocked(acceptShrink).mockReset();
  vi.mocked(triggerSync).mockReset();
});

describe("PeersSection lifecycle UI (#244 Phase 2)", () => {
  it("renders no lifecycle badge for an active peer, and shows a Disable + Remove action", async () => {
    vi.mocked(getPeers).mockResolvedValue([basePeer({ lifecycle: "active" })]);
    renderSection();

    await waitFor(() => expect(screen.getByText("peer-a")).toBeInTheDocument());
    expect(screen.queryByText("Disabled")).toBeNull();
    expect(screen.queryByText("Removed")).toBeNull();
    expect(screen.getByRole("button", { name: /disable/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^enable$/i })).toBeNull();
  });

  it("renders a Disabled badge and Enable action for a disabled peer", async () => {
    vi.mocked(getPeers).mockResolvedValue([basePeer({ lifecycle: "disabled" })]);
    renderSection();

    await waitFor(() => expect(screen.getByText("Disabled")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /enable/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /disable/i })).toBeNull();
  });

  it("renders a Removed badge and no actions for a tombstoned peer", async () => {
    vi.mocked(getPeers).mockResolvedValue([basePeer({ lifecycle: "tombstoned" })]);
    renderSection();

    await waitFor(() => expect(screen.getByText("Removed")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /disable/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /enable/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });

  it("clicking Disable calls the disablePeer api function with the peer id", async () => {
    vi.mocked(getPeers).mockResolvedValue([basePeer({ lifecycle: "active" })]);
    vi.mocked(disablePeer).mockResolvedValue({ id: "peer-a", lifecycle: "disabled" });
    renderSection();

    await waitFor(() => expect(screen.getByText("peer-a")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /disable/i }));

    await waitFor(() => expect(disablePeer).toHaveBeenCalledWith("peer-a"));
  });

  it("clicking Enable calls the enablePeer api function with the peer id", async () => {
    vi.mocked(getPeers).mockResolvedValue([basePeer({ lifecycle: "disabled" })]);
    vi.mocked(enablePeer).mockResolvedValue({ id: "peer-a", lifecycle: "active" });
    renderSection();

    await waitFor(() => expect(screen.getByText("peer-a")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /enable/i }));

    await waitFor(() => expect(enablePeer).toHaveBeenCalledWith("peer-a"));
  });

  it("clicking Remove confirms then calls the removePeer api function with the peer id", async () => {
    vi.mocked(getPeers).mockResolvedValue([basePeer({ lifecycle: "active" })]);
    vi.mocked(removePeer).mockResolvedValue({
      id: "peer-a",
      lifecycle: "tombstoned",
      tombstone: { removedBy: "local", reason: null, createdAt: "2026-01-01T00:00:00.000Z" },
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderSection();

    await waitFor(() => expect(screen.getByText("peer-a")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(removePeer).toHaveBeenCalledWith("peer-a"));
    confirmSpy.mockRestore();
  });

  it("clicking Remove and declining the confirm does not call removePeer", async () => {
    vi.mocked(getPeers).mockResolvedValue([basePeer({ lifecycle: "active" })]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderSection();

    await waitFor(() => expect(screen.getByText("peer-a")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(removePeer).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

describe("PeersSection library-shrink guard (#297)", () => {
  it("shows no banner while nothing is held", async () => {
    vi.mocked(getPeers).mockResolvedValue([basePeer()]);
    renderSection();

    await waitFor(() => expect(screen.getByText("peer-a")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("accepting a held shrink confirms, arms the override, then syncs", async () => {
    vi.mocked(getPeers).mockResolvedValue([
      basePeer({
        shrinkHeldAt: "2026-10-28T20:00:00Z",
        lastSyncOk: false,
        lastSyncMessage: "Shrink guard: library went from 500 tracks to 0",
      }),
    ]);
    vi.mocked(acceptShrink).mockResolvedValue({ id: "peer-a", acceptShrinkOnce: true });
    vi.mocked(triggerSync).mockResolvedValue({
      local: { instanceId: "local", artistCount: 0, albumCount: 0, trackCount: 0, errors: [] },
      peers: [],
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderSection();

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /accept removal/i }));

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(acceptShrink).toHaveBeenCalledWith("peer-a"));
    await waitFor(() => expect(triggerSync).toHaveBeenCalled());
    confirmSpy.mockRestore();
  });

  it("declining the confirm leaves the hold in place", async () => {
    vi.mocked(getPeers).mockResolvedValue([basePeer({ shrinkHeldAt: "2026-10-28T20:00:00Z" })]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderSection();

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /accept removal/i }));

    expect(acceptShrink).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

describe("PeersSection Last Seen vs Last Sync (#154)", () => {
  it("shows both timestamps independently", async () => {
    const now = Date.now();
    vi.mocked(getPeers).mockResolvedValue([
      basePeer({
        lastSeen: new Date(now - 5 * 60_000).toISOString(),
        lastSynced: new Date(now - 3 * 3_600_000).toISOString(),
      }),
    ]);
    renderSection();

    await waitFor(() => expect(screen.getByText("Last seen 5m ago")).toBeInTheDocument());
    expect(screen.getByText("Last sync 3h ago")).toBeInTheDocument();
  });

  it("a peer seen but never synced says so, instead of 'Never synced' for both", async () => {
    vi.mocked(getPeers).mockResolvedValue([
      basePeer({ lastSeen: new Date(Date.now() - 60_000).toISOString(), lastSynced: null }),
    ]);
    renderSection();

    await waitFor(() => expect(screen.getByText("Last seen 1m ago")).toBeInTheDocument());
    expect(screen.getByText("Last sync never")).toBeInTheDocument();
  });

  it("a never-contacted peer shows never for both", async () => {
    vi.mocked(getPeers).mockResolvedValue([basePeer()]);
    renderSection();

    await waitFor(() => expect(screen.getByText("Last seen never")).toBeInTheDocument());
    expect(screen.getByText("Last sync never")).toBeInTheDocument();
  });
});
