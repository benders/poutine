import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { SearchPage } from "./SearchPage";
import type {
  SubsonicAlbum,
  SubsonicArtist,
  SubsonicSearchResults,
} from "@/lib/subsonic";

vi.mock("@/lib/subsonic", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/subsonic")>("@/lib/subsonic");
  return {
    ...actual,
    search3: vi.fn(),
    artUrl: (id: string, size?: number) =>
      `/art/${id}${size ? `?size=${size}` : ""}`,
  };
});

import { search3 } from "@/lib/subsonic";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SearchPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function album(overrides: Partial<SubsonicAlbum>): SubsonicAlbum {
  return {
    id: "al1",
    name: "Kid A",
    artist: "Radiohead",
    artistId: "ar1",
    songCount: 11,
    ...overrides,
  };
}

function artist(overrides: Partial<SubsonicArtist>): SubsonicArtist {
  return {
    id: "ar1",
    name: "Radiohead",
    albumCount: 9,
    ...overrides,
  };
}

const EMPTY: SubsonicSearchResults = { artists: [], albums: [], songs: [] };

function typeQuery(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/search for artists/i), {
    target: { value: text },
  });
}

beforeEach(() => {
  vi.mocked(search3).mockReset();
});

describe("SearchPage album cover art (#211)", () => {
  it("renders a cover-art thumbnail for albums that have one", async () => {
    vi.mocked(search3).mockResolvedValue({
      ...EMPTY,
      albums: [album({ coverArt: "al1" })],
    });

    renderPage();
    typeQuery("kid a");

    const cover = await screen.findByRole("img", { name: "Kid A" });
    expect(cover.getAttribute("src")).toBe("/art/al1?size=80");
  });

  it("falls back to the placeholder icon when an album has no cover art", async () => {
    vi.mocked(search3).mockResolvedValue({
      ...EMPTY,
      albums: [album({ id: "al2", name: "No Art", coverArt: undefined })],
    });

    renderPage();
    typeQuery("no art");

    expect(
      await screen.findByText("No Art", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "No Art" })).toBeNull();
  });
});

describe("SearchPage artist cover art (#211)", () => {
  it("renders a cover-art thumbnail for artists that have one", async () => {
    vi.mocked(search3).mockResolvedValue({
      ...EMPTY,
      artists: [artist({ coverArt: "ar1" })],
    });

    renderPage();
    typeQuery("radiohead");

    const cover = await screen.findByRole("img", { name: "Radiohead" });
    expect(cover.getAttribute("src")).toBe("/art/ar1?size=80");
  });

  it("falls back to the initials placeholder when an artist has no cover art", async () => {
    vi.mocked(search3).mockResolvedValue({
      ...EMPTY,
      artists: [artist({ id: "ar2", name: "No Art", coverArt: undefined })],
    });

    renderPage();
    typeQuery("no art");

    expect(
      await screen.findByText("No Art", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "No Art" })).toBeNull();
  });
});
