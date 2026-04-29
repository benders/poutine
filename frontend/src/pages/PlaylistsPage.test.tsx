import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PlaylistsPage } from "./PlaylistsPage";

vi.mock("@/lib/subsonic", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/subsonic")>("@/lib/subsonic");
  return {
    ...actual,
    getStarred2: vi.fn(),
  };
});

import { getStarred2 } from "@/lib/subsonic";

function renderAt(path: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/playlists/:view" element={<PlaylistsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getStarred2).mockReset();
});

describe("PlaylistsPage Favorites view (#104)", () => {
  it("renders starred songs from getStarred2", async () => {
    vi.mocked(getStarred2).mockResolvedValue({
      artists: [],
      albums: [],
      songs: [
        {
          id: "ttrk-1",
          title: "Idioteque",
          album: "Kid A",
          albumId: "alrg-1",
          artist: "Radiohead",
          artistId: "arar-1",
          durationMs: 240000,
          starred: "2026-04-28T00:00:00Z",
        },
      ],
    });

    renderAt("/playlists/favorites");

    expect(
      await screen.findByRole("heading", { name: "Favorites" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("Idioteque")).toBeInTheDocument(),
    );
    expect(screen.getByText("1 track")).toBeInTheDocument();
  });

  it("shows empty-state copy when no songs are starred", async () => {
    vi.mocked(getStarred2).mockResolvedValue({
      artists: [],
      albums: [],
      songs: [],
    });

    renderAt("/playlists/favorites");

    await waitFor(() =>
      expect(screen.getByText(/no favorites yet/i)).toBeInTheDocument(),
    );
  });
});
