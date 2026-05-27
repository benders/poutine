import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { generateInvitation, acceptInvitation } from "@/lib/api";
import { cn } from "@/lib/cn";
import { CopyButton } from "@/features/shared/CopyButton";

/**
 * v5 invitation flow: generate a signed invite, or paste one received
 * out-of-band to admit the inviter as a peer. Discovered peers (via gossip)
 * appear in the peers list automatically after the next sync round.
 */
export function InvitationsSection() {
  const queryClient = useQueryClient();
  const onPeerAdded = () =>
    queryClient.invalidateQueries({ queryKey: ["admin-peers"] });

  const [ourUrl, setOurUrl] = useState<string>(
    typeof window !== "undefined" ? window.location.origin : "",
  );
  const [inviteeUrl, setInviteeUrl] = useState("");
  const [generated, setGenerated] = useState<string>("");
  const [pasted, setPasted] = useState("");
  const [acceptResult, setAcceptResult] = useState<string>("");

  const generate = useMutation({
    mutationFn: () =>
      generateInvitation({
        ourUrl,
        inviteeUrl: inviteeUrl || undefined,
      }),
    onSuccess: (data) => setGenerated(data.invitation),
  });

  const accept = useMutation({
    mutationFn: () => acceptInvitation({ invitation: pasted.trim(), ourUrl }),
    onSuccess: (data) => {
      setAcceptResult(`Admitted peer: ${data.peerId} (${data.peerUrl})`);
      setPasted("");
      onPeerAdded();
    },
    onError: (err) =>
      setAcceptResult(err instanceof Error ? err.message : String(err)),
  });

  return (
    <div className="space-y-4 mb-6 p-4 rounded-lg border border-border bg-surface">
      <div>
        <label className="block text-sm text-text-muted mb-1">
          This hub's public URL
        </label>
        <input
          type="text"
          value={ourUrl}
          onChange={(e) => setOurUrl(e.target.value)}
          placeholder="https://my-hub.example"
          className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-text-primary"
        />
        <p className="mt-1 text-xs text-text-muted">
          Used in both flows: when generating an invite it's embedded so the
          invitee knows where to handshake back; when accepting one it's the
          URL we send to the inviter so they know how to reach us.
          Defaults to this browser's origin — override if peers reach this
          hub at a different address.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-text-primary">Generate invite</h3>
          <input
            type="text"
            value={inviteeUrl}
            onChange={(e) => setInviteeUrl(e.target.value)}
            placeholder="Invitee URL (optional — leave blank for open invite)"
            className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-text-primary"
          />
          <button
            onClick={() => generate.mutate()}
            disabled={generate.isPending || !ourUrl}
            className="px-3 py-2 bg-surface-hover border border-border rounded text-sm text-text-primary disabled:opacity-50"
          >
            {generate.isPending ? "Signing..." : "Generate"}
          </button>
          {generated && (
            <div className="relative">
              <textarea
                readOnly
                value={generated}
                onClick={(e) => (e.target as HTMLTextAreaElement).select()}
                rows={4}
                className="w-full px-3 py-2 pr-10 bg-background border border-border rounded text-xs font-mono text-text-primary"
              />
              <div className="absolute top-1.5 right-1.5">
                <CopyButton text={generated} />
              </div>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-text-primary">Accept invite</h3>
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder="Paste invitation here"
            rows={4}
            className="w-full px-3 py-2 bg-background border border-border rounded text-xs font-mono text-text-primary"
          />
          <button
            onClick={() => accept.mutate()}
            disabled={accept.isPending || !pasted.trim() || !ourUrl}
            className="px-3 py-2 bg-surface-hover border border-border rounded text-sm text-text-primary disabled:opacity-50"
          >
            {accept.isPending ? "Verifying..." : "Accept"}
          </button>
          {acceptResult && (
            <p
              className={cn(
                "text-xs",
                accept.isError ? "text-error" : "text-success",
              )}
            >
              {acceptResult}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
