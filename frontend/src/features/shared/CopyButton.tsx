import { useState } from "react";
import { Copy, Check } from "lucide-react";

/**
 * Shared admin UI control. Lives in `features/shared/` because both
 * hub-admin and player-admin sections use it. Pure presentation — no
 * API calls — so it does not violate the bounded directory rule.
 */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button
      onClick={handleCopy}
      title="Copy to clipboard"
      className="p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}
