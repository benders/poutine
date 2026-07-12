import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UsersSection } from "./UsersSection";
import type { User } from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getUsers: vi.fn(),
    createUser: vi.fn(),
    deleteUser: vi.fn(),
    updateUserPassword: vi.fn(),
  };
});

vi.mock("@/stores/auth", () => ({
  useAuth: vi.fn(),
}));

import { getUsers, updateUserPassword } from "@/lib/api";
import { useAuth } from "@/stores/auth";

function baseUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-a",
    username: "alice",
    isAdmin: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function mockCurrentUserId(id: string) {
  vi.mocked(useAuth).mockImplementation((selector) =>
    selector({
      user: { id, username: "alice", isAdmin: true },
      loading: false,
      checkAuth: vi.fn(),
      setUser: vi.fn(),
      logout: vi.fn(),
    }),
  );
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <UsersSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getUsers).mockReset();
  vi.mocked(updateUserPassword).mockReset();
  vi.mocked(useAuth).mockReset();
  mockCurrentUserId("user-a");
});

describe("UsersSection change-password form (#115)", () => {
  it("toggles the password form open and closed via the key icon", async () => {
    vi.mocked(getUsers).mockResolvedValue([baseUser()]);
    renderSection();

    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    expect(screen.queryByLabelText("New password")).toBeNull();

    fireEvent.click(screen.getByTitle("Change password"));
    expect(screen.getByLabelText("New password")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Change password"));
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  it("shows a mismatch error and does not call updateUserPassword when password/confirm differ", async () => {
    vi.mocked(getUsers).mockResolvedValue([baseUser()]);
    renderSection();

    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("Change password"));

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "password1" } });
    fireEvent.change(screen.getByLabelText("Confirm"), { target: { value: "password2" } });
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));

    expect(await screen.findByText("Passwords do not match.")).toBeInTheDocument();
    expect(updateUserPassword).not.toHaveBeenCalled();
  });

  it("calls updateUserPassword with the row's user id and new password when they match", async () => {
    vi.mocked(getUsers).mockResolvedValue([baseUser()]);
    vi.mocked(updateUserPassword).mockResolvedValue(undefined);
    renderSection();

    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("Change password"));

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "password1" } });
    fireEvent.change(screen.getByLabelText("Confirm"), { target: { value: "password1" } });
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));

    await waitFor(() =>
      expect(updateUserPassword).toHaveBeenCalledWith("user-a", "password1"),
    );
  });

  it("shows the stale-credentials notice when the changed row is the current user's own", async () => {
    vi.mocked(getUsers).mockResolvedValue([baseUser({ id: "user-a" })]);
    vi.mocked(updateUserPassword).mockResolvedValue(undefined);
    mockCurrentUserId("user-a");
    renderSection();

    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("Change password"));

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "password1" } });
    fireEvent.change(screen.getByLabelText("Confirm"), { target: { value: "password1" } });
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));

    expect(
      await screen.findByText("Password updated.", { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByText(/log out and back in/i)).toBeInTheDocument();
  });

  it("does not show the stale-credentials notice when changing a different user's password", async () => {
    vi.mocked(getUsers).mockResolvedValue([baseUser({ id: "user-b" })]);
    vi.mocked(updateUserPassword).mockResolvedValue(undefined);
    mockCurrentUserId("user-a");
    renderSection();

    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("Change password"));

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "password1" } });
    fireEvent.change(screen.getByLabelText("Confirm"), { target: { value: "password1" } });
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));

    expect(
      await screen.findByText("Password updated.", { exact: false }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/log out and back in/i)).toBeNull();
  });

  it("renders the error message when the API call fails", async () => {
    vi.mocked(getUsers).mockResolvedValue([baseUser()]);
    vi.mocked(updateUserPassword).mockRejectedValue(new Error("Server exploded"));
    renderSection();

    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("Change password"));

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "password1" } });
    fireEvent.change(screen.getByLabelText("Confirm"), { target: { value: "password1" } });
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));

    expect(await screen.findByText("Server exploded")).toBeInTheDocument();
  });
});
