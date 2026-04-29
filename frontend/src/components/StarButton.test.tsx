import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StarButton } from "./StarButton";

vi.mock("@/lib/subsonic", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/subsonic")>("@/lib/subsonic");
  return {
    ...actual,
    star: vi.fn().mockResolvedValue(undefined),
    unstar: vi.fn().mockResolvedValue(undefined),
  };
});

import { star, unstar } from "@/lib/subsonic";

function withQc(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  vi.mocked(star).mockClear();
  vi.mocked(unstar).mockClear();
});

describe("StarButton (#104)", () => {
  it("calls star when not starred", async () => {
    render(withQc(<StarButton id="ttrk-1" starred={undefined} />));
    const btn = screen.getByRole("button", { name: /add to favorites/i });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(btn);
    await waitFor(() => expect(star).toHaveBeenCalledWith({ id: "ttrk-1" }));
    expect(unstar).not.toHaveBeenCalled();
  });

  it("calls unstar when already starred", async () => {
    render(
      withQc(
        <StarButton id="ttrk-1" starred="2026-04-28T00:00:00Z" />,
      ),
    );
    const btn = screen.getByRole("button", { name: /remove from favorites/i });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(btn);
    await waitFor(() => expect(unstar).toHaveBeenCalledWith({ id: "ttrk-1" }));
    expect(star).not.toHaveBeenCalled();
  });

  it("flips icon optimistically before the request resolves", async () => {
    let resolveStar: (() => void) | undefined;
    vi.mocked(star).mockImplementationOnce(
      () => new Promise<void>((res) => (resolveStar = () => res())),
    );

    render(withQc(<StarButton id="ttrk-1" starred={undefined} />));
    const btn = screen.getByRole("button", { name: /add to favorites/i });
    expect(btn).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(btn);

    // Optimistic flip happens synchronously via onMutate, before star() resolves.
    await waitFor(() =>
      expect(btn).toHaveAttribute("aria-pressed", "true"),
    );
    expect(btn).toHaveAccessibleName(/remove from favorites/i);

    resolveStar?.();
    await waitFor(() => expect(star).toHaveBeenCalledWith({ id: "ttrk-1" }));
  });

  it("rolls back the optimistic flip when the request fails", async () => {
    vi.mocked(star).mockRejectedValueOnce(new Error("boom"));

    render(withQc(<StarButton id="ttrk-1" starred={undefined} />));
    const btn = screen.getByRole("button", { name: /add to favorites/i });

    fireEvent.click(btn);

    // After the rejection settles, optimistic state clears and we revert.
    await waitFor(() =>
      expect(btn).toHaveAttribute("aria-pressed", "false"),
    );
    expect(btn).toHaveAccessibleName(/add to favorites/i);
  });
});
