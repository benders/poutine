import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { previewInvite, redeemInvite, type InvitePreview } from "@/lib/api";
import { useAuth } from "@/stores/auth";
import { Disc3 } from "lucide-react";

/**
 * Invite redemption (#272). Unauthenticated by design, and deliberately outside
 * `features/hub-admin/` and `features/player-admin/` — it belongs to neither
 * bounded destination.
 *
 * Two rules this page must keep:
 *
 * 1. **No authenticated fetches.** Only the two public `/api/invites/*` POSTs.
 *    An `apiFetch` here would 401 → redirect → mount → 401, the loop that bit
 *    `/login` (docs/pitfalls.md, Auth).
 * 2. **The token lives in the fragment**, never the path or query, so it stays
 *    out of server logs and Referer headers. We read it once and clear the hash
 *    so it doesn't linger in browser history.
 */
export function InvitePage() {
  const [token, setToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { setUser } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const raw = window.location.hash.replace(/^#/, "").trim();
    if (raw) {
      // Drop the token from the address bar and history entry.
      window.history.replaceState(null, "", window.location.pathname);
    }
    if (!raw) {
      setError("This invitation link is incomplete.");
      setChecking(false);
      return;
    }
    setToken(raw);
    previewInvite(raw)
      .then((p) => {
        setPreview(p);
        setUsername(p.suggestedUsername ?? "");
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Invitation is not valid"),
      )
      .finally(() => setChecking(false));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      const user = await redeemInvite({ token, username, password });
      setUser(user);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="w-full max-w-sm p-8">
        <div className="flex items-center justify-center gap-2 mb-8">
          <Disc3 className="w-8 h-8 text-accent" />
          <h1 className="text-2xl font-bold">Poutine</h1>
        </div>

        {checking && <p className="text-sm text-text-muted text-center">Checking invitation...</p>}

        {!checking && !preview && (
          <div className="space-y-4 text-center">
            <p className="text-sm text-error">{error || "Invitation is not valid"}</p>
            <p className="text-sm text-text-muted">
              Invitations expire and can only be used once. Ask whoever invited
              you for a fresh link.
            </p>
            <button
              onClick={() => navigate("/login")}
              className="text-sm text-accent hover:underline"
            >
              Go to sign in
            </button>
          </div>
        )}

        {!checking && preview && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-sm text-text-secondary text-center">
              You've been invited to <strong>{preview.hubName}</strong>. Pick a
              username and password.
            </p>

            <div>
              <label htmlFor="invite-name" className="block text-sm text-text-secondary mb-1">
                Username
              </label>
              <input
                id="invite-name"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent"
                required
              />
            </div>

            <div>
              <label htmlFor="invite-password" className="block text-sm text-text-secondary mb-1">
                Password
              </label>
              <input
                id="invite-password"
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
              <label htmlFor="invite-confirm" className="block text-sm text-text-secondary mb-1">
                Confirm password
              </label>
              <input
                id="invite-confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                minLength={8}
                autoComplete="new-password"
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent"
                required
              />
            </div>

            {error && <p className="text-sm text-error">{error}</p>}

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              {submitting ? "..." : "Create Account"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
