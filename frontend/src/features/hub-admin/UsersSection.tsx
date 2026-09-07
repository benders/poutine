import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getUsers, createUser, deleteUser, updateUserPassword, setUserAdmin } from "@/lib/api";
import type { User } from "@/lib/api";
import { useAuth } from "@/stores/auth";
import { formatTimeAgo } from "@/lib/format";
import { KeyRound, Plus, ShieldMinus, ShieldPlus, Trash2, Users } from "lucide-react";

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

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["admin-users"] });

  const deleteMutation = useMutation({
    mutationFn: () => deleteUser(user.id),
    onSuccess: invalidate,
  });

  const adminMutation = useMutation({
    mutationFn: () => setUserAdmin(user.id, !user.isAdmin),
    onSuccess: invalidate,
  });

  // An admin can promote/demote and delete anyone but themselves (#274). The
  // backend enforces the same rule; hiding the controls just avoids offering
  // an action that is guaranteed to 400.
  const adminActionTitle = user.isAdmin
    ? `Revoke admin rights from ${user.username}`
    : `Grant ${user.username} full admin rights over this hub`;

  const deleteConfirmMessage = user.isAdmin
    ? `Remove admin user "${user.username}"? They lose all access to this hub, and any peer records they own are reassigned to you. This cannot be undone.`
    : `Remove user "${user.username}"? This cannot be undone.`;

  const actionError = deleteMutation.error ?? adminMutation.error;

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
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setShowPasswordForm((v) => !v)}
            title={`Set a new password for ${user.username}`}
            className="flex items-center gap-1 px-2 py-1.5 bg-surface border border-border hover:bg-surface-hover rounded-lg text-xs text-text-primary transition-colors"
          >
            <KeyRound className="w-3.5 h-3.5" />
            Password
          </button>
          {!isSelf && (
            <>
              <button
                onClick={() => adminMutation.mutate()}
                disabled={adminMutation.isPending}
                title={adminActionTitle}
                className="flex items-center gap-1 px-2 py-1.5 bg-surface border border-border hover:bg-surface-hover rounded-lg text-xs text-text-primary transition-colors disabled:opacity-50"
              >
                {user.isAdmin ? (
                  <ShieldMinus className="w-3.5 h-3.5" />
                ) : (
                  <ShieldPlus className="w-3.5 h-3.5" />
                )}
                {user.isAdmin ? "Revoke admin" : "Make admin"}
              </button>
              <button
                onClick={() => {
                  if (window.confirm(deleteConfirmMessage)) {
                    deleteMutation.mutate();
                  }
                }}
                disabled={deleteMutation.isPending}
                title={`Delete ${user.username} and all their stars, playlists, and play history`}
                className="flex items-center gap-1 px-2 py-1.5 bg-surface border border-error/40 hover:bg-error/10 rounded-lg text-xs text-error transition-colors disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Remove
              </button>
            </>
          )}
        </div>
      </div>
      {actionError && (
        <p className="px-4 pb-3 text-sm text-error">
          {actionError instanceof Error ? actionError.message : "Action failed"}
        </p>
      )}
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
