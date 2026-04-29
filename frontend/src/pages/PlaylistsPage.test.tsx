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
    getAlbum: vi.fn(),
  };
});

import { getAlbum, getStarred2 } from "@/lib/subsonic";

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
  vi.mocked(getAlbum).mockReset();
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

  it("merges tracks from starred albums and flags album-only tracks", async () => {
    vi.mocked(getStarred2).mockResolvedValue({
      artists: [],
      albums: [
        {
          id: "alrg-1",
          name: "Kid A",
          artist: "Radiohead",
          artistId: "arar-1",
          songCount: 2,
        },
      ],
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
    vi.mocked(getAlbum).mockResolvedValue({
      id: "alrg-1",
      name: "Kid A",
      artist: "Radiohead",
      artistId: "arar-1",
      songCount: 2,
      songs: [
        {
          id: "ttrk-1", // duplicate of the directly-starred track — must dedupe
          title: "Idioteque",
          album: "Kid A",
          albumId: "alrg-1",
          artist: "Radiohead",
          artistId: "arar-1",
          durationMs: 240000,
          starred: "2026-04-28T00:00:00Z",
        },
        {
          id: "ttrk-2",
          title: "Everything In Its Right Place",
          album: "Kid A",
          albumId: "alrg-1",
          artist: "Radiohead",
          artistId: "arar-1",
          durationMs: 250000,
        },
      ],
    });

    renderAt("/playlists/favorites");

    await waitFor(() =>
      expect(
        screen.getByText("Everything In Its Right Place"),
      ).toBeInTheDocument(),
    );
    // Idioteque is rendered exactly once (directly-starred wins; album dupe dropped)
    expect(screen.getAllByText("Idioteque")).toHaveLength(1);
    expect(screen.getByText("2 tracks")).toBeInTheDocument();
    // The album-only track gets the immutable star (Album is starred);
    // the directly-starred track does not.
    expect(screen.getAllByLabelText(/album is starred/i)).toHaveLength(1);
  });
});
