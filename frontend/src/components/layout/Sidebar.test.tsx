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

vi.mock("@/lib/subsonic", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/subsonic")>("@/lib/subsonic");
  return {
    ...actual,
    getMusicFolders: vi.fn(),
  };
});

import { getMusicFolders } from "@/lib/subsonic";

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
  vi.mocked(getMusicFolders).mockReset();
});

describe("Sidebar Albums group", () => {
  it("renders one entry per MusicFolder plus All/Random", async () => {
    vi.mocked(getMusicFolders).mockResolvedValue([
      { id: 1, name: "Local" },
      { id: 2, name: "Alice's Hub" },
      { id: 3, name: "Bob's Hub" },
    ]);
    renderSidebar();

    expect(screen.getByText("Albums")).toBeInTheDocument();
    expect(screen.getByText("All")).toBeInTheDocument();
    expect(screen.getByText("Random")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Alice's Hub")).toBeInTheDocument();
    });
    expect(screen.getByText("Bob's Hub")).toBeInTheDocument();
    expect(screen.getByText("Local")).toBeInTheDocument();

    const aliceLink = screen.getByText("Alice's Hub").closest("a");
    expect(aliceLink).toHaveAttribute("href", "/library/folder-2");
  });

  it("collapse/expand persists in localStorage", async () => {
    vi.mocked(getMusicFolders).mockResolvedValue([]);
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
