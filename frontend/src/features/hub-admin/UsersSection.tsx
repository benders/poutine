import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getUsers, createUser, deleteUser, updateUserPassword } from "@/lib/api";
import type { User } from "@/lib/api";
import { useAuth } from "@/stores/auth";
import { formatTimeAgo } from "@/lib/format";
import { KeyRound, Plus, Trash2, Users } from "lucide-react";

function AddUserForm({ onSuccess }: { onSuccess: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const mutation = useMutation({
    mutationFn: () => createUser(username, password),
    onSuccess: () => {
      setUsername("");
      setPassword("");
      setExpanded(false);
      onSuccess();
    },
  });

  return (
    <div className="bg-surface border border-border rounded-lg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium text-text-primary hover:bg-surface-hover transition-colors rounded-lg"
      >
        <Plus className="w-4 h-4" />
        Add Guest User
      </button>

      {expanded && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
          className="px-4 pb-4 space-y-3"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-text-secondary mb-1">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-text-secondary mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent"
                required
              />
            </div>
          </div>

          {mutation.isError && (
            <p className="text-sm text-error">
              {mutation.error instanceof Error ? mutation.error.message : "Failed to create user"}
            </p>
          )}

          <button
            type="submit"
            disabled={mutation.isPending}
            className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {mutation.isPending ? "Creating..." : "Create User"}
          </button>
        </form>
      )}
    </div>
  );
}

function ChangePasswordForm({
  user,
  isSelf,
  onClose,
}: {
  user: User;
  isSelf: boolean;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);

  const mutation = useMutation({
    mutationFn: () => updateUserPassword(user.id, password),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (password !== confirm) {
          setMismatch(true);
          return;
        }
        setMismatch(false);
        mutation.mutate();
      }}
      className="px-4 pb-4 space-y-3"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label
            htmlFor={`new-password-${user.id}`}
            className="block text-sm text-text-secondary mb-1"
          >
            New password
          </label>
          <input
            id={`new-password-${user.id}`}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            autoComplete="new-password"
            className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent"
            required
          />
        </div>
        <div>
          <label
            htmlFor={`confirm-password-${user.id}`}
            className="block text-sm text-text-secondary mb-1"
          >
            Confirm
          </label>
          <input
            id={`confirm-password-${user.id}`}
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            minLength={8}
            autoComplete="new-password"
            className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent"
            required
          />
        </div>
      </div>

      {mismatch && (
        <p className="text-sm text-error">Passwords do not match.</p>
      )}

      {mutation.isError && (
        <p className="text-sm text-error">
          {mutation.error instanceof Error ? mutation.error.message : "Failed to update password"}
        </p>
      )}

      {mutation.isSuccess && (
        <div className="p-3 bg-success/10 border border-success/20 rounded-lg text-sm text-success">
          Password updated.
          {isSelf && (
            <> Your stored Subsonic credentials are now stale — log out and back in to refresh them.</>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={mutation.isPending}
          className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
        >
          {mutation.isPending ? "Saving..." : "Update Password"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 bg-surface border border-border hover:bg-surface-hover rounded-lg text-sm text-text-primary transition-colors"
        >
          {mutation.isSuccess ? "Close" : "Cancel"}
        </button>
      </div>
    </form>
  );
}

function UserRow({ user, currentUserId }: { user: User; currentUserId: string }) {
  const queryClient = useQueryClient();
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const isSelf = user.id === currentUserId;

  const deleteMutation = useMutation({
    mutationFn: () => deleteUser(user.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });

  return (
    <div className="bg-surface border border-border rounded-lg">
      <div className="flex items-center gap-4 px-4 py-3">
        <Users className="w-5 h-5 text-text-muted shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary">{user.username}</span>
            {user.isAdmin && (
              <span className="px-2 py-0.5 bg-accent/10 text-accent rounded-full text-xs font-medium">
                admin
              </span>
            )}
          </div>
          <p className="text-xs text-text-muted">Joined {formatTimeAgo(user.createdAt)}</p>
        </div>
        <button
          onClick={() => setShowPasswordForm((v) => !v)}
          title="Change password"
          className="p-2 text-text-muted hover:text-text-primary hover:bg-surface-hover rounded-lg transition-colors"
        >
          <KeyRound className="w-4 h-4" />
        </button>
        {!user.isAdmin && !isSelf && (
          <button
            onClick={() => {
              if (window.confirm(`Remove user "${user.username}"?`)) {
                deleteMutation.mutate();
              }
            }}
            disabled={deleteMutation.isPending}
            title="Remove user"
            className="p-2 text-text-muted hover:text-error hover:bg-error/10 rounded-lg transition-colors disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>
      {showPasswordForm && (
        <ChangePasswordForm
          user={user}
          isSelf={isSelf}
          onClose={() => setShowPasswordForm(false)}
        />
      )}
    </div>
  );
}

export function UsersSection() {
  const queryClient = useQueryClient();

  const { data: users, isLoading: usersLoading } = useQuery({
    queryKey: ["admin-users"],
    queryFn: getUsers,
  });

  const currentUserId = useAuth((s) => s.user?.id) ?? "";

  return (
    <section>
      <h2 className="text-xl font-bold text-text-primary mb-4">Users</h2>
      <div className="space-y-2">
        <AddUserForm onSuccess={() => queryClient.invalidateQueries({ queryKey: ["admin-users"] })} />
        {usersLoading && <p className="text-sm text-text-muted py-4">Loading users...</p>}
        {users?.map((user) => (
          <UserRow key={user.id} user={user} currentUserId={currentUserId} />
        ))}
      </div>
    </section>
  );
}
