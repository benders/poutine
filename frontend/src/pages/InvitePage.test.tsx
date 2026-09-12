import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { InvitePage } from "./InvitePage";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, previewInvite: vi.fn(), redeemInvite: vi.fn() };
});

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
});

const setUser = vi.fn();
vi.mock("@/stores/auth", () => ({
  useAuth: () => ({ setUser }),
}));

import { previewInvite, redeemInvite } from "@/lib/api";

function renderPage(hash: string) {
  window.history.replaceState(null, "", `/invite${hash}`);
  return render(
    <MemoryRouter>
      <InvitePage />
    </MemoryRouter>,
  );
}

const goodPreview = {
  valid: true as const,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  suggestedUsername: "dana",
  isAdmin: false,
  hubName: "Basement Hub",
};

beforeEach(() => {
  vi.mocked(previewInvite).mockReset();
  vi.mocked(redeemInvite).mockReset();
  navigate.mockReset();
  setUser.mockReset();
});

describe("InvitePage (#272)", () => {
  it("reads the token from the fragment and clears it from the URL", async () => {
    vi.mocked(previewInvite).mockResolvedValue(goodPreview);
    renderPage("#tok-123");

    await waitFor(() => expect(previewInvite).toHaveBeenCalledWith("tok-123"));
    // The token must not linger in the address bar or history entry.
    expect(window.location.hash).toBe("");
  });

  it("prefills the suggested username", async () => {
    vi.mocked(previewInvite).mockResolvedValue(goodPreview);
    renderPage("#tok-123");

    await waitFor(() =>
      expect(screen.getByLabelText("Username")).toHaveValue("dana"),
    );
    expect(screen.getByText("Basement Hub")).toBeInTheDocument();
  });

  it("explains an invalid invite instead of offering the form", async () => {
    vi.mocked(previewInvite).mockRejectedValue(new Error("Invitation is not valid"));
    renderPage("#dead");

    await waitFor(() =>
      expect(screen.getByText("Invitation is not valid")).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("Username")).toBeNull();
  });

  it("rejects a link with no token without calling the API", async () => {
    renderPage("");

    await waitFor(() =>
      expect(screen.getByText("This invitation link is incomplete.")).toBeInTheDocument(),
    );
    expect(previewInvite).not.toHaveBeenCalled();
  });

  it("redeems and signs the new account in", async () => {
    vi.mocked(previewInvite).mockResolvedValue(goodPreview);
    vi.mocked(redeemInvite).mockResolvedValue({
      id: "u-1",
      username: "dana",
      isAdmin: false,
    });
    renderPage("#tok-123");

    await waitFor(() => expect(screen.getByLabelText("Username")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "hunter2hunter2" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "hunter2hunter2" },
    });
    fireEvent.click(screen.getByText("Create Account"));

    await waitFor(() =>
      expect(redeemInvite).toHaveBeenCalledWith({
        token: "tok-123",
        username: "dana",
        password: "hunter2hunter2",
      }),
    );
    expect(setUser).toHaveBeenCalledWith({
      id: "u-1",
      username: "dana",
      isAdmin: false,
    });
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("blocks mismatched passwords before hitting the API", async () => {
    vi.mocked(previewInvite).mockResolvedValue(goodPreview);
    renderPage("#tok-123");

    await waitFor(() => expect(screen.getByLabelText("Username")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "hunter2hunter2" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "hunter2hunter3" },
    });
    fireEvent.click(screen.getByText("Create Account"));

    await waitFor(() =>
      expect(screen.getByText("Passwords do not match.")).toBeInTheDocument(),
    );
    expect(redeemInvite).not.toHaveBeenCalled();
  });
});
