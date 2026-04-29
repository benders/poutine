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
    getMusicFolders: vi.fn(),
    artUrl: (id: string) => `/art/${id}`,
  };
});

import { getAlbumList2, getMusicFolders } from "@/lib/subsonic";

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
  vi.mocked(getMusicFolders).mockReset();
  vi.mocked(getMusicFolders).mockResolvedValue([
    { id: 1, name: "Local" },
    { id: 7, name: "Friend's Hub" },
  ]);
});

describe("AlbumsPage view routing", () => {
  it("/library/all calls getAlbumList2 without musicFolderId", async () => {
    vi.mocked(getAlbumList2).mockResolvedValue([ALBUM]);
    renderAt("/library/all");
    await waitFor(() => expect(getAlbumList2).toHaveBeenCalled());
    const args = vi.mocked(getAlbumList2).mock.calls[0]?.[0];
    expect(args?.musicFolderId).toBeUndefined();
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
    expect(args?.musicFolderId).toBeUndefined();
  });

  it("/library/folder-7 sets musicFolderId to the folder id", async () => {
    vi.mocked(getAlbumList2).mockResolvedValue([ALBUM]);
    renderAt("/library/folder-7");
    await waitFor(() => expect(getAlbumList2).toHaveBeenCalled());
    expect(vi.mocked(getAlbumList2).mock.calls[0]?.[0]?.musicFolderId).toBe(7);
    // Title resolves to the folder's display name when getMusicFolders loads.
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
