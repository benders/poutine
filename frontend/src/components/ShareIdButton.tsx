import { useState } from "react";
import { Copy, Check } from "lucide-react";

export function ShareIdButton({ id, label = "Share ID" }: { id: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can fail in non-secure contexts; fall back to prompt.
      window.prompt("Copy this ID:", id);
    }
  };

  return (
    <button
      onClick={onClick}
      title="Copy this ID to share with a peer. They can paste it into Search to find the same item."
      className="inline-flex items-center gap-2 px-4 py-1.5 bg-surface-hover hover:bg-surface text-text-primary rounded-full text-sm font-medium transition-colors cursor-pointer"
    >
      {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
      {copied ? "Copied!" : label}
    </button>
  );
}
