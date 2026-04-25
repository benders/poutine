import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AlbumsPage } from "./AlbumsPage";

vi.mock("@/lib/subsonic", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/subsonic")>("@/lib/subsonic");
  return {
    ...actual,
    getAlbumList2: vi.fn(),
    artUrl: (id: string) => `/art/${id}`,
  };
});

vi.mock("@/lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getPeersSummary: vi.fn(),
  };
});

import { getAlbumList2 } from "@/lib/subsonic";
import { getPeersSummary } from "@/lib/api";

function renderAt(path: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/library/:view" element={<AlbumsPage />} />
          <Route path="/library/all" element={<AlbumsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const ALBUM = {
  id: "al1",
  name: "Kid A",
  artist: "Radiohead",
  artistId: "ar1",
  songCount: 11,
};

beforeEach(() => {
  vi.mocked(getAlbumList2).mockReset();
  vi.mocked(getPeersSummary).mockReset();
  vi.mocked(getPeersSummary).mockResolvedValue([
    { id: "abc", name: "Friend's Hub", status: "online", albumCount: 5 },
  ]);
});

describe("AlbumsPage view routing", () => {
  it("/library/all calls getAlbumList2 without instanceId", async () => {
    vi.mocked(getAlbumList2).mockResolvedValue([ALBUM]);
    renderAt("/library/all");
    await waitFor(() => expect(getAlbumList2).toHaveBeenCalled());
    const args = vi.mocked(getAlbumList2).mock.calls[0]?.[0];
    expect(args?.instanceId).toBeUndefined();
    expect(args?.type).toBe("alphabeticalByName");
    expect(await screen.findByText("All Albums")).toBeInTheDocument();
    expect(await screen.findByText("Kid A")).toBeInTheDocument();
  });

  it("/library/random requests random type", async () => {
    vi.mocked(getAlbumList2).mockResolvedValue([ALBUM]);
    renderAt("/library/random");
    await waitFor(() => expect(getAlbumList2).toHaveBeenCalled());
    const args = vi.mocked(getAlbumList2).mock.calls[0]?.[0];
    expect(args?.type).toBe("random");
    expect(args?.instanceId).toBeUndefined();
  });

  it("/library/local sets instanceId=local", async () => {
    vi.mocked(getAlbumList2).mockResolvedValue([ALBUM]);
    renderAt("/library/local");
    await waitFor(() => expect(getAlbumList2).toHaveBeenCalled());
    expect(vi.mocked(getAlbumList2).mock.calls[0]?.[0]?.instanceId).toBe(
      "local",
    );
  });

  it("/library/peer-abc sets instanceId to the peer id", async () => {
    vi.mocked(getAlbumList2).mockResolvedValue([ALBUM]);
    renderAt("/library/peer-abc");
    await waitFor(() => expect(getAlbumList2).toHaveBeenCalled());
    expect(vi.mocked(getAlbumList2).mock.calls[0]?.[0]?.instanceId).toBe("abc");
    // Title resolves to the peer's display name when summary is loaded.
    expect(await screen.findByText("Friend's Hub")).toBeInTheDocument();
  });

  it("unknown view slug redirects to /library/all", async () => {
    vi.mocked(getAlbumList2).mockResolvedValue([ALBUM]);
    renderAt("/library/bogus");
    await waitFor(() => expect(getAlbumList2).toHaveBeenCalled());
    // After redirect we land on All Albums.
    expect(await screen.findByText("All Albums")).toBeInTheDocument();
  });
});
