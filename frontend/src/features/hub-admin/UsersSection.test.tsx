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
    setUserAdmin: vi.fn(),
  };
});

vi.mock("@/stores/auth", () => ({
  useAuth: vi.fn(),
}));

import { getUsers, updateUserPassword, deleteUser, setUserAdmin } from "@/lib/api";
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
  vi.mocked(deleteUser).mockReset();
  vi.mocked(setUserAdmin).mockReset();
  vi.mocked(useAuth).mockReset();
  mockCurrentUserId("user-a");
});

describe("UsersSection change-password form (#115)", () => {
  it("toggles the password form open and closed via the key icon", async () => {
    vi.mocked(getUsers).mockResolvedValue([baseUser()]);
    renderSection();

    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    expect(screen.queryByLabelText("New password")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Password" }));
    expect(screen.getByLabelText("New password")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Password" }));
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  it("shows a mismatch error and does not call updateUserPassword when password/confirm differ", async () => {
    vi.mocked(getUsers).mockResolvedValue([baseUser()]);
    renderSection();

    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Password" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Password" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Password" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Password" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Password" }));

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "password1" } });
    fireEvent.change(screen.getByLabelText("Confirm"), { target: { value: "password1" } });
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));

    expect(await screen.findByText("Server exploded")).toBeInTheDocument();
  });
});

describe("UsersSection admin status + deletion (#274)", () => {
  it("offers promote on a non-admin row and calls setUserAdmin with true", async () => {
    vi.mocked(getUsers).mockResolvedValue([baseUser({ id: "user-b", username: "bob" })]);
    vi.mocked(setUserAdmin).mockResolvedValue(undefined);
    mockCurrentUserId("user-a");
    renderSection();

    await waitFor(() => expect(screen.getByText("bob")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /make admin/i }));

    await waitFor(() => expect(setUserAdmin).toHaveBeenCalledWith("user-b", true));
  });

  it("offers revoke on an admin row and calls setUserAdmin with false", async () => {
    vi.mocked(getUsers).mockResolvedValue([
      baseUser({ id: "user-b", username: "bob", isAdmin: true }),
    ]);
    vi.mocked(setUserAdmin).mockResolvedValue(undefined);
    mockCurrentUserId("user-a");
    renderSection();

    await waitFor(() => expect(screen.getByText("bob")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /revoke admin/i }));

    await waitFor(() => expect(setUserAdmin).toHaveBeenCalledWith("user-b", false));
  });

  it("hides the admin toggle and the delete button on the current user's own row", async () => {
    vi.mocked(getUsers).mockResolvedValue([
      baseUser({ id: "user-a", username: "alice", isAdmin: true }),
    ]);
    mockCurrentUserId("user-a");
    renderSection();

    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /revoke admin/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /make admin/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });

  it("shows the delete button on another admin's row", async () => {
    vi.mocked(getUsers).mockResolvedValue([
      baseUser({ id: "user-b", username: "bob", isAdmin: true }),
    ]);
    mockCurrentUserId("user-a");
    renderSection();

    await waitFor(() => expect(screen.getByText("bob")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /remove/i })).toBeInTheDocument();
  });

  it("confirms before deleting and calls deleteUser with the row's id", async () => {
    vi.mocked(getUsers).mockResolvedValue([baseUser({ id: "user-b", username: "bob" })]);
    vi.mocked(deleteUser).mockResolvedValue(undefined);
    mockCurrentUserId("user-a");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderSection();

    await waitFor(() => expect(screen.getByText("bob")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('"bob"'));
    await waitFor(() => expect(deleteUser).toHaveBeenCalledWith("user-b"));
    confirmSpy.mockRestore();
  });

  it("does not call deleteUser when the confirmation is declined", async () => {
    vi.mocked(getUsers).mockResolvedValue([baseUser({ id: "user-b", username: "bob" })]);
    mockCurrentUserId("user-a");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderSection();

    await waitFor(() => expect(screen.getByText("bob")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("warns that the target is an admin in the delete confirmation", async () => {
    vi.mocked(getUsers).mockResolvedValue([
      baseUser({ id: "user-b", username: "bob", isAdmin: true }),
    ]);
    vi.mocked(deleteUser).mockResolvedValue(undefined);
    mockCurrentUserId("user-a");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderSection();

    await waitFor(() => expect(screen.getByText("bob")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("admin user"));
    confirmSpy.mockRestore();
  });

  it("warns about peer reassignment when deleting a non-admin too", async () => {
    // `instances.owner_id` rows are held by an arbitrary user, guests
    // included, so the warning must not be gated on `isAdmin` (#274).
    vi.mocked(getUsers).mockResolvedValue([baseUser({ id: "user-b", username: "bob" })]);
    vi.mocked(deleteUser).mockResolvedValue(undefined);
    mockCurrentUserId("user-a");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderSection();

    await waitFor(() => expect(screen.getByText("bob")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));

    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining("peer records they own are reassigned to you"),
    );
    confirmSpy.mockRestore();
  });

  it("surfaces a failed admin-status change", async () => {
    vi.mocked(getUsers).mockResolvedValue([baseUser({ id: "user-b", username: "bob" })]);
    vi.mocked(setUserAdmin).mockRejectedValue(
      new Error("Cannot change your own admin status"),
    );
    mockCurrentUserId("user-a");
    renderSection();

    await waitFor(() => expect(screen.getByText("bob")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /make admin/i }));

    expect(
      await screen.findByText("Cannot change your own admin status"),
    ).toBeInTheDocument();
  });

  it("surfaces a failed deletion", async () => {
    vi.mocked(getUsers).mockResolvedValue([baseUser({ id: "user-b", username: "bob" })]);
    vi.mocked(deleteUser).mockRejectedValue(new Error("User not found"));
    mockCurrentUserId("user-a");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderSection();

    await waitFor(() => expect(screen.getByText("bob")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));

    expect(await screen.findByText("User not found")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("replaces a stale delete error with the later admin-toggle error", async () => {
    vi.mocked(getUsers).mockResolvedValue([baseUser({ id: "user-b", username: "bob" })]);
    vi.mocked(deleteUser).mockRejectedValue(new Error("Delete failed"));
    vi.mocked(setUserAdmin).mockRejectedValue(new Error("Promote failed"));
    mockCurrentUserId("user-a");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderSection();

    await waitFor(() => expect(screen.getByText("bob")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    expect(await screen.findByText("Delete failed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /make admin/i }));

    expect(await screen.findByText("Promote failed")).toBeInTheDocument();
    expect(screen.queryByText("Delete failed")).toBeNull();
    confirmSpy.mockRestore();
  });
});
