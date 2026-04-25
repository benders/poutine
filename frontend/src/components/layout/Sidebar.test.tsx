import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Sidebar } from "./Sidebar";

vi.mock("@/stores/auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "tester", isAdmin: true },
    logout: vi.fn(),
  }),
}));

vi.mock("@/lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getPeersSummary: vi.fn(),
  };
});

import { getPeersSummary } from "@/lib/api";

function renderSidebar() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(getPeersSummary).mockReset();
});

describe("Sidebar Albums group", () => {
  it("renders one entry per peer plus All/Random/Local", async () => {
    vi.mocked(getPeersSummary).mockResolvedValue([
      { id: "p1", name: "Alice's Hub", status: "online", albumCount: 3 },
      { id: "p2", name: "Bob's Hub", status: "offline", albumCount: 7 },
    ]);
    renderSidebar();

    expect(screen.getByText("Albums")).toBeInTheDocument();
    expect(screen.getByText("All")).toBeInTheDocument();
    expect(screen.getByText("Random")).toBeInTheDocument();
    expect(screen.getByText("Local")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Alice's Hub")).toBeInTheDocument();
    });
    expect(screen.getByText("Bob's Hub")).toBeInTheDocument();

    const aliceLink = screen.getByText("Alice's Hub").closest("a");
    expect(aliceLink).toHaveAttribute("href", "/library/peer-p1");
  });

  it("collapse/expand persists in localStorage", async () => {
    vi.mocked(getPeersSummary).mockResolvedValue([]);
    renderSidebar();

    // Children visible by default.
    expect(screen.getByText("All")).toBeVisible();
    const toggle = screen.getByRole("button", { name: /Collapse Albums/i });
    fireEvent.click(toggle);
    expect(screen.queryByText("All")).toBeNull();
    expect(localStorage.getItem("sidebar:albums:open")).toBe("0");

    fireEvent.click(
      screen.getByRole("button", { name: /Expand Albums/i }),
    );
    expect(screen.getByText("All")).toBeVisible();
    expect(localStorage.getItem("sidebar:albums:open")).toBe("1");
  });
});
