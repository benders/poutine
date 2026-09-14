import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getUserInvites,
  createUserInvite,
  revokeUserInvite,
  type IssuedUserInvite,
  type UserInvite,
} from "@/lib/api";
import { formatTimeAgo, formatTimeUntil } from "@/lib/format";
import { CopyButton } from "@/features/shared/CopyButton";
import { Link2, Plus, Trash2 } from "lucide-react";

/**
 * User invitations (#272) — the account-creation mirror of the peer flow in
 * `InvitationsSection`. The admin issues a signed, expiring, single-use link
 * and sends it on; the invitee picks their own username and password at
 * `/invite`, so no password ever passes through the admin's hands.
 *
 * The issued URL is shown exactly once: only `sha256(token)` is stored, so the
 * server cannot re-display it later.
 */

const TTL_OPTIONS = [
  { label: "1 hour", value: 60 * 60 },
  { label: "24 hours", value: 24 * 60 * 60 },
  { label: "48 hours", value: 48 * 60 * 60 },
  { label: "7 days", value: 7 * 24 * 60 * 60 },
];

const STATE_STYLES: Record<UserInvite["state"], string> = {
  pending: "bg-accent/10 text-accent",
  consumed: "bg-success/10 text-success",
  expired: "bg-surface-hover text-text-muted",
  revoked: "bg-surface-hover text-text-muted",
};

function IssueInviteForm({ onIssued }: { onIssued: (i: IssuedUserInvite) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [suggestedUsername, setSuggestedUsername] = useState("");
  const [note, setNote] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [expiresInSec, setExpiresInSec] = useState(TTL_OPTIONS[2].value);

  const mutation = useMutation({
    mutationFn: () =>
      createUserInvite({
        suggestedUsername: suggestedUsername.trim() || undefined,
        note: note.trim() || undefined,
        isAdmin,
        expiresInSec,
        // The hub can only guess its public origin from proxy headers; the
        // browser knows the URL the invitee will actually be able to open.
        baseUrl: window.location.origin,
      }),
    onSuccess: (invite) => {
      setSuggestedUsername("");
      setNote("");
      setIsAdmin(false);
      setExpanded(false);
      onIssued(invite);
    },
  });

  return (
    <div className="bg-surface border border-border rounded-lg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium text-text-primary hover:bg-surface-hover transition-colors rounded-lg"
      >
        <Plus className="w-4 h-4" />
        Invite Someone
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
              <label
                htmlFor="invite-username"
                className="block text-sm text-text-secondary mb-1"
              >
                Suggested username (optional)
              </label>
              <input
                id="invite-username"
                type="text"
                value={suggestedUsername}
                onChange={(e) => setSuggestedUsername(e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent"
              />
            </div>
            <div>
              <label
                htmlFor="invite-expiry"
                className="block text-sm text-text-secondary mb-1"
              >
                Expires
              </label>
              <select
                id="invite-expiry"
                value={expiresInSec}
                onChange={(e) => setExpiresInSec(Number(e.target.value))}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent"
              >
                {TTL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="invite-note" className="block text-sm text-text-secondary mb-1">
              Note (optional — for your own list)
            </label>
            <input
              id="invite-note"
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={isAdmin}
              onChange={(e) => setIsAdmin(e.target.checked)}
            />
            Grant admin rights
          </label>

          {mutation.isError && (
            <p className="text-sm text-error">
              {mutation.error instanceof Error
                ? mutation.error.message
                : "Failed to create invitation"}
            </p>
          )}

          <button
            type="submit"
            disabled={mutation.isPending}
            className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {mutation.isPending ? "Creating..." : "Create Invite Link"}
          </button>
        </form>
      )}
    </div>
  );
}

function InviteRow({ invite }: { invite: UserInvite }) {
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => revokeUserInvite(invite.id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["admin-user-invites"] }),
  });

  const label =
    invite.suggestedUsername ?? invite.note ?? "Anyone with the link";

  return (
    <div className="flex items-center gap-4 px-4 py-3 bg-surface border border-border rounded-lg">
      <Link2 className="w-5 h-5 text-text-muted shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary truncate">{label}</span>
          <span
            className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATE_STYLES[invite.state]}`}
          >
            {invite.state}
          </span>
          {invite.isAdmin && (
            <span className="px-2 py-0.5 bg-accent/10 text-accent rounded-full text-xs font-medium">
              admin
            </span>
          )}
        </div>
        <p className="text-xs text-text-muted">
          {invite.state === "consumed" && invite.consumedBy
            ? `Redeemed by ${invite.consumedBy} ${formatTimeAgo(invite.consumedAt ?? invite.issuedAt)}`
            : invite.state === "pending"
              ? `Expires ${formatTimeUntil(invite.expiresAt)}`
              : `Issued ${formatTimeAgo(invite.issuedAt)}`}
        </p>
      </div>
      {invite.state === "pending" && (
        <button
          onClick={() => {
            if (window.confirm("Revoke this invitation? The link stops working.")) {
              revoke.mutate();
            }
          }}
          disabled={revoke.isPending}
          title="Revoke invitation"
          className="p-2 text-text-muted hover:text-error hover:bg-error/10 rounded-lg transition-colors disabled:opacity-50"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

export function UserInvitesSection() {
  const queryClient = useQueryClient();
  const [issued, setIssued] = useState<IssuedUserInvite | null>(null);

  const { data: invites, isLoading } = useQuery({
    queryKey: ["admin-user-invites"],
    queryFn: getUserInvites,
  });

  return (
    <section>
      <h2 className="text-xl font-bold text-text-primary mb-4">Invitations</h2>
      <div className="space-y-2">
        <IssueInviteForm
          onIssued={(invite) => {
            setIssued(invite);
            queryClient.invalidateQueries({ queryKey: ["admin-user-invites"] });
          }}
        />

        {issued && (
          <div className="p-4 bg-success/10 border border-success/20 rounded-lg space-y-2">
            <p className="text-sm text-success">
              Send this link to the invitee. It works once, and it is shown only
              now — the hub stores a hash, not the link.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 px-3 py-2 bg-background border border-border rounded text-xs text-text-primary break-all">
                {issued.url}
              </code>
              <CopyButton text={issued.url} />
            </div>
            <button
              onClick={() => setIssued(null)}
              className="text-xs text-text-muted hover:text-text-primary"
            >
              Dismiss
            </button>
          </div>
        )}

        {isLoading && <p className="text-sm text-text-muted py-4">Loading invitations...</p>}
        {invites?.length === 0 && !isLoading && (
          <p className="text-sm text-text-muted py-4">No invitations yet.</p>
        )}
        {invites?.map((invite) => (
          <InviteRow key={invite.id} invite={invite} />
        ))}
      </div>
    </section>
  );
}
