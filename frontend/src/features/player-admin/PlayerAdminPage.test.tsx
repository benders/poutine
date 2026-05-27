import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { PlayerAdminPage } from "./PlayerAdminPage";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getPlayerHealth: vi.fn(),
    getSonosSettings: vi.fn(),
  };
});

import { getPlayerHealth, getSonosSettings } from "@/lib/api";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PlayerAdminPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getPlayerHealth).mockReset();
  vi.mocked(getSonosSettings).mockReset();
});

describe("PlayerAdminPage gate (#216)", () => {
  it("renders Player settings when /player/health responds", async () => {
    vi.mocked(getPlayerHealth).mockResolvedValue({
      status: "ok",
      appVersion: "test",
    });
    vi.mocked(getSonosSettings).mockResolvedValue({
      enabled: false,
      volumeCap: 80,
      lanUrl: "",
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Sonos Casting")).toBeInTheDocument();
    });
    expect(screen.queryByText(/not deployed on this host/i)).toBeNull();
  });

  it("renders 'not deployed' placeholder when /player/health is absent", async () => {
    vi.mocked(getPlayerHealth).mockResolvedValue(null);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/Player not deployed on this host/i)).toBeInTheDocument();
    });
    // Explanation copy mentions deploying a Player.
    expect(
      screen.getByText(/Player features.*live on a separate deployment/i),
    ).toBeInTheDocument();
    // No Sonos settings rendered — and the Sonos settings fetcher was
    // never called because the gate short-circuits.
    expect(screen.queryByText("Sonos Casting")).toBeNull();
    expect(vi.mocked(getSonosSettings)).not.toHaveBeenCalled();
  });
});
