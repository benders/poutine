import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ArtistsPage } from "./ArtistsPage";
import { SubsonicError } from "@/lib/subsonic";

vi.mock("@/lib/subsonic", async () => {
  const actual = await vi.importActual<typeof import("@/lib/subsonic")>("@/lib/subsonic");
  return {
    ...actual,
    getArtists: vi.fn(),
    artUrl: (id: string) => `/art/${id}`,
  };
});

import { getArtists } from "@/lib/subsonic";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ArtistsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getArtists).mockReset();
});

describe("ArtistsPage error surfacing", () => {
  it("renders the SubSonic error code and message on failure", async () => {
    vi.mocked(getArtists).mockRejectedValueOnce(
      new SubsonicError("Required parameter missing", 10),
    );
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("Required parameter missing")).toBeInTheDocument();
    expect(screen.getByText(/code 10/)).toBeInTheDocument();
  });

  it("renders artists on success", async () => {
    vi.mocked(getArtists).mockResolvedValueOnce([
      { id: "a1", name: "Radiohead", albumCount: 9 },
    ]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Radiohead")).toBeInTheDocument();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
