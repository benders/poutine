import { AlertCircle } from "lucide-react";
import { formatError } from "./formatError";

export function ErrorMessage({ error }: { error: unknown }) {
  const { title, code } = formatError(error);
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200"
    >
      <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
      <div>
        <p className="font-medium">{title}</p>
        {code != null && code !== 0 && (
          <p className="text-xs text-red-300/80">Subsonic error code {code}</p>
        )}
      </div>
    </div>
  );
}
