import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PlayerBar } from "./PlayerBar";
import { usePlayer } from "@/stores/player";
import { setSubsonicCreds } from "@/lib/api";
import { streamUrl } from "@/lib/subsonic";
import type { SubsonicSong } from "@/lib/subsonic";

function track(id: string, coverArt?: string): SubsonicSong {
  return {
    id,
    title: "T",
    album: "A",
    albumId: "al-1",
    artist: "Ar",
    artistId: "ar-1",
    durationMs: 1000,
    coverArt,
  };
}

beforeEach(() => {
  // PlayerBar reads creds via streamUrl → authParams → getSubsonicCreds.
  setSubsonicCreds({ username: "u", password: "p" });
  // Reset the zustand store between tests.
  usePlayer.setState({
    queue: [],
    currentIndex: -1,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
  });
});

describe("PlayerBar render stability", () => {
  it("streamUrl() returns a different URL each call (premise: fresh salt per call)", () => {
    const a = streamUrl("trk-1");
    const b = streamUrl("trk-1");
    expect(a).not.toBe(b);
    // …but both must contain the same id.
    expect(a).toContain("id=trk-1");
    expect(b).toContain("id=trk-1");
  });

  it("does not infinite-loop when a track is loaded (regression: React #185)", () => {
    // If currentStreamUrl changes every render (because streamUrl() is salted
    // per call and not memoized), the [currentStreamUrl] effects fire
    // unboundedly and React throws "Maximum update depth exceeded".
    usePlayer.setState({ queue: [track("trk-1")], currentIndex: 0 });

    // Spy on console.error so we can detect the React warning even if React
    // recovers without throwing in the test renderer.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      render(
        <MemoryRouter>
          <PlayerBar />
        </MemoryRouter>,
      ),
    ).not.toThrow();

    const sawMaxUpdate = errorSpy.mock.calls.some((args) =>
      String(args[0] ?? "").includes("Maximum update depth"),
    );
    errorSpy.mockRestore();
    expect(sawMaxUpdate).toBe(false);
  });

  it("cover-art <img src> is stable across re-renders (regression: refetch loop)", () => {
    // artUrl() also generates a fresh u+t+s salt per call. If it isn't
    // memoized, every parent re-render (e.g. from currentTime updates) gives
    // the <img> a new src URL — the browser re-fetches getCoverArt
    // continuously. See PR #110 follow-up.
    usePlayer.setState({
      queue: [track("trk-1", "art-1")],
      currentIndex: 0,
    });

    const { container } = render(
      <MemoryRouter>
        <PlayerBar />
      </MemoryRouter>,
    );

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    const firstSrc = img!.getAttribute("src");
    expect(firstSrc).toContain("id=art-1");

    // Force a re-render by mutating unrelated player state.
    act(() => {
      usePlayer.setState({ currentTime: 1 });
    });
    act(() => {
      usePlayer.setState({ currentTime: 2 });
    });

    const sameImg = container.querySelector("img");
    expect(sameImg!.getAttribute("src")).toBe(firstSrc);
  });
});
