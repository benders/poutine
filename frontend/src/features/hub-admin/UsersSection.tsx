import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getUsers, createUser, deleteUser } from "@/lib/api";
import type { User } from "@/lib/api";
import { formatTimeAgo } from "@/lib/format";
import { Plus, Trash2, Users } from "lucide-react";

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

function UserRow({ user, currentUserId }: { user: User; currentUserId: string }) {
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: () => deleteUser(user.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });

  return (
    <div className="flex items-center gap-4 px-4 py-3 bg-surface border border-border rounded-lg">
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
      {!user.isAdmin && user.id !== currentUserId && (
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
  );
}

export function UsersSection() {
  const queryClient = useQueryClient();

  const { data: users, isLoading: usersLoading } = useQuery({
    queryKey: ["admin-users"],
    queryFn: getUsers,
  });

  const currentUserId = users?.find((u) => u.isAdmin)?.id ?? "";

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
