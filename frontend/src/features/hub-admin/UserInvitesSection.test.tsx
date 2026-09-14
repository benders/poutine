import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UserInvitesSection } from "./UserInvitesSection";
import type { UserInvite } from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getUserInvites: vi.fn(),
    createUserInvite: vi.fn(),
    revokeUserInvite: vi.fn(),
  };
});

import { getUserInvites, createUserInvite, revokeUserInvite } from "@/lib/api";

function baseInvite(overrides: Partial<UserInvite> = {}): UserInvite {
  return {
    id: "inv-1",
    state: "pending",
    suggestedUsername: "dana",
    isAdmin: false,
    note: null,
    createdBy: "owner",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    consumedAt: null,
    consumedBy: null,
    revokedAt: null,
    ...overrides,
  };
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <UserInvitesSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getUserInvites).mockReset();
  vi.mocked(createUserInvite).mockReset();
  vi.mocked(revokeUserInvite).mockReset();
  vi.mocked(getUserInvites).mockResolvedValue([]);
});

describe("UserInvitesSection (#272)", () => {
  it("lists invitations with their state", async () => {
    vi.mocked(getUserInvites).mockResolvedValue([
      baseInvite(),
      baseInvite({
        id: "inv-2",
        state: "consumed",
        suggestedUsername: null,
        note: "the drummer",
        consumedBy: "kim",
        consumedAt: "2026-01-02T00:00:00.000Z",
      }),
    ]);
    renderSection();

    await waitFor(() => expect(screen.getByText("dana")).toBeInTheDocument());
    expect(screen.getByText("pending")).toBeInTheDocument();
    expect(screen.getByText("the drummer")).toBeInTheDocument();
    expect(screen.getByText("consumed")).toBeInTheDocument();
    expect(screen.getByText(/Redeemed by kim/)).toBeInTheDocument();
  });

  it("shows the issued link once, and sends the browser origin as baseUrl", async () => {
    vi.mocked(createUserInvite).mockResolvedValue({
      id: "inv-9",
      url: "https://hub.example/invite#tok",
      token: "tok",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      isAdmin: false,
      suggestedUsername: null,
    });
    renderSection();

    fireEvent.click(screen.getByText("Invite Someone"));
    fireEvent.click(screen.getByText("Create Invite Link"));

    await waitFor(() =>
      expect(screen.getByText("https://hub.example/invite#tok")).toBeInTheDocument(),
    );
    expect(vi.mocked(createUserInvite).mock.calls[0][0]).toMatchObject({
      baseUrl: window.location.origin,
    });

    fireEvent.click(screen.getByText("Dismiss"));
    expect(screen.queryByText("https://hub.example/invite#tok")).toBeNull();
  });

  it("offers revoke only on pending invitations", async () => {
    vi.mocked(getUserInvites).mockResolvedValue([
      baseInvite({ id: "inv-3", state: "expired", suggestedUsername: "stale" }),
    ]);
    renderSection();

    await waitFor(() => expect(screen.getByText("stale")).toBeInTheDocument());
    expect(screen.queryByTitle("Revoke invitation")).toBeNull();
  });

  it("revokes after confirmation", async () => {
    vi.mocked(getUserInvites).mockResolvedValue([baseInvite()]);
    vi.mocked(revokeUserInvite).mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderSection();

    await waitFor(() => expect(screen.getByText("dana")).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("Revoke invitation"));
    await waitFor(() => expect(revokeUserInvite).toHaveBeenCalledWith("inv-1"));
  });
});
