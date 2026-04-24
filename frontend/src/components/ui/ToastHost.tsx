import { AlertCircle, X } from "lucide-react";
import { useToasts } from "@/stores/toast";

export function ToastHost() {
  const { toasts, dismiss } = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Notifications"
      className="fixed bottom-24 right-4 z-50 flex flex-col gap-2 max-w-sm"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-950/90 backdrop-blur p-3 text-sm text-red-100 shadow-lg"
        >
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-medium">{t.title}</p>
            {t.detail && <p className="text-xs text-red-300/80 mt-0.5">{t.detail}</p>}
          </div>
          <button
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
            className="text-red-300/60 hover:text-red-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
