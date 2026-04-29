import { useState } from "react";
import { Copy, Check } from "lucide-react";

export function ShareIdButton({ shareId, label = "Share" }: { shareId: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(shareId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this ID:", shareId);
    }
  };

  return (
    <button
      onClick={onClick}
      title="Copy sharing ID — paste into Search on any peer hub that syncs the same library."
      className="inline-flex items-center gap-2 px-4 py-2 bg-surface-hover hover:bg-surface text-text-primary rounded-full text-sm font-medium transition-colors cursor-pointer"
    >
      {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
      {copied ? "Copied!" : label}
    </button>
  );
}
