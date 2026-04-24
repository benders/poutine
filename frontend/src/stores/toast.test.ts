import { describe, it, expect, beforeEach, vi } from "vitest";
import { useToasts } from "./toast";

beforeEach(() => {
  useToasts.setState({ toasts: [] });
  vi.useFakeTimers();
});

describe("toast store", () => {
  it("pushes and dismisses toasts manually", () => {
    useToasts.getState().push({ kind: "error", title: "Playback failed" });
    const [t] = useToasts.getState().toasts;
    expect(t.title).toBe("Playback failed");
    useToasts.getState().dismiss(t.id);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("auto-dismisses after 6 seconds", () => {
    useToasts.getState().push({ kind: "error", title: "Network error" });
    expect(useToasts.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(6000);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });
});
