import { SubsonicError } from "@/lib/subsonic";

export function formatError(err: unknown): { title: string; code?: number } {
  if (err instanceof SubsonicError) {
    return { title: err.message || "Request failed", code: err.code };
  }
  if (err instanceof Error) return { title: err.message };
  return { title: "Unknown error" };
}
