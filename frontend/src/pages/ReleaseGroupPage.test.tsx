import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ReleaseGroupPage } from "./ReleaseGroupPage";
import type { SubsonicAlbumDetail } from "@/lib/subsonic";

vi.mock("@/lib/subsonic", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/subsonic")>("@/lib/subsonic");
  return {
    ...actual,
    getAlbum: vi.fn(),
    artUrl: (id: string) => `/art/${id}`,
    downloadUrl: (id: string) => `/rest/download?id=${id}`,
  };
});

import { getAlbum } from "@/lib/subsonic";

function renderAt(albumId: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/albums/${albumId}`]}>
        <Routes>
          <Route path="/albums/:id" element={<ReleaseGroupPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function makeAlbum(): SubsonicAlbumDetail {
  return {
    id: "al-1",
    name: "Comp Album",
    artist: "Album Artist",
    artistId: "ar-album",
    songCount: 2,
    songs: [
      {
        id: "tr-1",
        title: "Same Artist Track",
        album: "Comp Album",
        albumId: "al-1",
        artist: "Album Artist",
        artistId: "ar-album",
        durationMs: 180000,
      },
      {
        id: "tr-2",
        title: "Featured Track",
        album: "Comp Album",
        albumId: "al-1",
        artist: "Featured Artist",
        artistId: "ar-feat",
        durationMs: 240000,
      },
    ],
  };
}

beforeEach(() => {
  vi.mocked(getAlbum).mockReset();
});

describe("ReleaseGroupPage track artist (#138)", () => {
  it("shows track artist only on rows where artistId differs from album artist", async () => {
    vi.mocked(getAlbum).mockResolvedValue(makeAlbum());
    renderAt("al-1");

    await waitFor(() =>
      expect(screen.getByText("Featured Track")).toBeInTheDocument(),
    );

    // Row whose artist matches the album artist should NOT render the
    // per-track artist line. The album header itself contains "Album Artist"
    // exactly once — querying scoped to a link with the *track* artist URL is
    // the cleanest assertion.
    expect(
      screen.queryByRole("link", { name: "Featured Artist" }),
    ).toBeInTheDocument();
    // No second "Album Artist" link beyond the album header link.
    const albumArtistLinks = screen.getAllByRole("link", {
      name: "Album Artist",
    });
    expect(albumArtistLinks).toHaveLength(1);
  });

  it("hides per-row artist when every track matches the album artist", async () => {
    const album = makeAlbum();
    album.songs = album.songs.filter((s) => s.artistId === "ar-album");
    vi.mocked(getAlbum).mockResolvedValue(album);
    renderAt("al-1");

    await waitFor(() =>
      expect(screen.getByText("Same Artist Track")).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("link", { name: "Featured Artist" }),
    ).not.toBeInTheDocument();
    // Only one "Album Artist" link — from the header.
    expect(
      screen.getAllByRole("link", { name: "Album Artist" }),
    ).toHaveLength(1);
  });
});

describe("ReleaseGroupPage cover art lightbox (#200)", () => {
  it("opens a lightbox with the full-size cover when the art is clicked", async () => {
    const album = makeAlbum();
    album.coverArt = "cover-1";
    vi.mocked(getAlbum).mockResolvedValue(album);
    renderAt("al-1");

    await waitFor(() =>
      expect(screen.getByText("Featured Track")).toBeInTheDocument(),
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /view full-size cover art/i }),
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(
      within(dialog).getByRole("img", { name: "Comp Album" }),
    ).toHaveAttribute("src", "/art/cover-1");
  });

  it("closes the lightbox on backdrop click but not on image click", async () => {
    const album = makeAlbum();
    album.coverArt = "cover-1";
    vi.mocked(getAlbum).mockResolvedValue(album);
    renderAt("al-1");

    await waitFor(() =>
      expect(screen.getByText("Featured Track")).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /view full-size cover art/i }),
    );

    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("img", { name: "Comp Album" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the lightbox on Escape", async () => {
    const album = makeAlbum();
    album.coverArt = "cover-1";
    vi.mocked(getAlbum).mockResolvedValue(album);
    renderAt("al-1");

    await waitFor(() =>
      expect(screen.getByText("Featured Track")).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /view full-size cover art/i }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("ReleaseGroupPage downloads (#35)", () => {
  it("renders an album Download button linking to /rest/download with the album id", async () => {
    vi.mocked(getAlbum).mockResolvedValue(makeAlbum());
    renderAt("al-1");

    await waitFor(() =>
      expect(screen.getByText("Featured Track")).toBeInTheDocument(),
    );

    const albumLink = screen.getByTitle("Download album as ZIP");
    expect(albumLink).toHaveAttribute("href", "/rest/download?id=al-1");
  });

  it("renders a per-track download link for each song row", async () => {
    vi.mocked(getAlbum).mockResolvedValue(makeAlbum());
    renderAt("al-1");

    await waitFor(() =>
      expect(screen.getByText("Featured Track")).toBeInTheDocument(),
    );

    const trackLinks = screen.getAllByTitle("Download");
    expect(trackLinks).toHaveLength(2);
    expect(trackLinks[0]).toHaveAttribute("href", "/rest/download?id=tr-1");
    expect(trackLinks[1]).toHaveAttribute("href", "/rest/download?id=tr-2");
  });
});
