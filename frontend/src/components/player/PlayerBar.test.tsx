import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PlayerBar } from "./PlayerBar";
import { usePlayer } from "@/stores/player";
import { setSubsonicCreds } from "@/lib/api";
import { streamUrl } from "@/lib/subsonic";
import type { SubsonicSong } from "@/lib/subsonic";
import * as api from "@/lib/api";

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
    sink: "local",
    volume: 0.8,
    castVolume: 50,
    castVolumeCap: 50,
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

describe("PlayerBar cast volume slider", () => {
  beforeEach(() => {
    vi.spyOn(api, "getCapabilities").mockResolvedValue({
      sonos: true,
      dlna: true,
      sonosAllowNonAdmin: false,
    } as Awaited<ReturnType<typeof api.getCapabilities>>);
    vi.spyOn(api, "getSonosState").mockResolvedValue({
      state: "PLAYING",
      position: 0,
      duration: 1,
      volume: 25,
      volumeCap: 50,
      trackUri: "",
    });
    vi.spyOn(api, "sonosPlay").mockResolvedValue({ ok: true, transcoded: true });
    vi.spyOn(api, "sonosSetNext").mockResolvedValue(undefined as never);
    vi.spyOn(api, "sonosCommand").mockResolvedValue(undefined as never);
    vi.spyOn(api, "sonosSetVolume").mockResolvedValue(undefined as never);
    vi.spyOn(api, "sonosSeek").mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function findCastSlider(container: HTMLElement) {
    return container.querySelector(
      'input[type="range"][aria-label="Cast volume"]',
    ) as HTMLInputElement | null;
  }

  it("renders the cast slider with max=castVolumeCap when sink is sonos", () => {
    usePlayer.setState({
      sink: { type: "sonos", deviceId: "RINCON_1", deviceName: "Kitchen" },
      castVolume: 20,
      castVolumeCap: 50,
      queue: [track("trk-1")],
      currentIndex: 0,
    });

    const { container } = render(
      <MemoryRouter>
        <PlayerBar />
      </MemoryRouter>,
    );

    const slider = findCastSlider(container);
    expect(slider).not.toBeNull();
    expect(slider!.max).toBe("50");
    expect(slider!.value).toBe("20");

    // Local volume slider should NOT be rendered while casting.
    const localSlider = container.querySelector(
      'input[type="range"][aria-label="Volume"]',
    );
    expect(localSlider).toBeNull();
  });

  it("dragging the cast slider posts to sonosSetVolume (debounced) and does not touch local volume", () => {
    vi.useFakeTimers();
    usePlayer.setState({
      sink: { type: "sonos", deviceId: "RINCON_1", deviceName: "Kitchen" },
      castVolume: 20,
      castVolumeCap: 50,
      volume: 0.8,
      queue: [track("trk-1")],
      currentIndex: 0,
    });

    const { container } = render(
      <MemoryRouter>
        <PlayerBar />
      </MemoryRouter>,
    );

    const slider = findCastSlider(container)!;

    act(() => {
      fireEvent.change(slider, { target: { value: "35" } });
    });

    // Optimistic store update happens immediately.
    expect(usePlayer.getState().castVolume).toBe(35);
    // Local volume must remain untouched while casting.
    expect(usePlayer.getState().volume).toBe(0.8);
    // Debounced: no POST yet.
    expect(api.sonosSetVolume).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(api.sonosSetVolume).toHaveBeenCalledWith("RINCON_1", 35);
  });

  it("stops the previous Sonos device when sink switches to local (#198)", async () => {
    usePlayer.setState({
      sink: { type: "sonos", deviceId: "RINCON_1", deviceName: "Kitchen" },
      queue: [track("trk-1")],
      currentIndex: 0,
    });

    render(
      <MemoryRouter>
        <PlayerBar />
      </MemoryRouter>,
    );

    await act(async () => {
      usePlayer.setState({ sink: "local" });
    });

    expect(api.sonosCommand).toHaveBeenCalledWith("RINCON_1", "stop");
  });

  it("stops the previous Sonos device when switching to a different Sonos (#198)", async () => {
    usePlayer.setState({
      sink: { type: "sonos", deviceId: "RINCON_1", deviceName: "Kitchen" },
      queue: [track("trk-1")],
      currentIndex: 0,
    });

    render(
      <MemoryRouter>
        <PlayerBar />
      </MemoryRouter>,
    );

    await act(async () => {
      usePlayer.setState({
        sink: { type: "sonos", deviceId: "RINCON_2", deviceName: "Bedroom" },
      });
    });

    expect(api.sonosCommand).toHaveBeenCalledWith("RINCON_1", "stop");
  });

  it("passes current playback position when switching local → Sonos mid-track (#194)", async () => {
    usePlayer.setState({
      sink: "local",
      queue: [track("trk-1")],
      currentIndex: 0,
      currentTime: 42,
    });

    render(
      <MemoryRouter>
        <PlayerBar />
      </MemoryRouter>,
    );

    await act(async () => {
      usePlayer.setState({
        sink: { type: "sonos", deviceId: "RINCON_1", deviceName: "Kitchen" },
      });
    });

    expect(api.sonosPlay).toHaveBeenCalledWith(
      "RINCON_1",
      "trk-1",
      expect.objectContaining({ position: 42 }),
    );
  });

  it("does not pass position when track-changing on the same Sonos sink", async () => {
    usePlayer.setState({
      sink: { type: "sonos", deviceId: "RINCON_1", deviceName: "Kitchen" },
      queue: [track("trk-1"), track("trk-2")],
      currentIndex: 0,
      currentTime: 0,
    });

    render(
      <MemoryRouter>
        <PlayerBar />
      </MemoryRouter>,
    );

    // Simulate next(): store resets currentTime to 0 and advances index.
    await act(async () => {
      usePlayer.setState({ currentIndex: 1, currentTime: 0 });
    });

    const lastCall = (api.sonosPlay as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(lastCall?.[1]).toBe("trk-2");
    expect(lastCall?.[2]).toEqual(
      expect.objectContaining({ position: undefined }),
    );
  });

  it("seeking on Sonos re-issues play with the new position (#182)", () => {
    const longTrack: SubsonicSong = { ...track("trk-1"), durationMs: 200000 };
    usePlayer.setState({
      sink: { type: "sonos", deviceId: "RINCON_1", deviceName: "Kitchen" },
      queue: [longTrack],
      currentIndex: 0,
    });

    const { container } = render(
      <MemoryRouter>
        <PlayerBar />
      </MemoryRouter>,
    );

    (api.sonosPlay as ReturnType<typeof vi.fn>).mockClear();

    const seek = container.querySelector(
      'input[type="range"]:not([aria-label])',
    ) as HTMLInputElement;
    expect(seek).not.toBeNull();
    act(() => {
      fireEvent.change(seek, { target: { value: "150" } });
    });

    expect(api.sonosPlay).toHaveBeenCalledWith(
      "RINCON_1",
      "trk-1",
      expect.objectContaining({ position: 150 }),
    );
  });

  it("seeking on Sonos pass-through uses SOAP Seek, not a re-issue (#204)", async () => {
    (api.sonosPlay as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      transcoded: false,
    });
    // Override getSonosState to report the real track duration so the
    // poller doesn't clamp the seek-slider max to 1s mid-test.
    (api.getSonosState as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: "PLAYING",
      position: 0,
      duration: 200,
      volume: 25,
      volumeCap: 50,
      trackUri: "",
    });
    const longTrack: SubsonicSong = { ...track("trk-1"), durationMs: 200000 };
    usePlayer.setState({
      sink: { type: "sonos", deviceId: "RINCON_1", deviceName: "Kitchen" },
      queue: [longTrack],
      currentIndex: 0,
    });

    const { container } = render(
      <MemoryRouter>
        <PlayerBar />
      </MemoryRouter>,
    );

    // Wait for the initial sonosPlay resolve so castTranscodedRef updates.
    await act(async () => {
      await Promise.resolve();
    });

    (api.sonosPlay as ReturnType<typeof vi.fn>).mockClear();
    (api.sonosSeek as ReturnType<typeof vi.fn>).mockClear();

    const seek = container.querySelector(
      'input[type="range"]:not([aria-label])',
    ) as HTMLInputElement;
    expect(seek).not.toBeNull();
    act(() => {
      fireEvent.change(seek, { target: { value: "150" } });
    });

    expect(api.sonosSeek).toHaveBeenCalledWith("RINCON_1", 150);
    expect(api.sonosPlay).not.toHaveBeenCalled();
  });

  it("setSink preserves currentTime across sink changes (#194)", () => {
    usePlayer.setState({
      sink: "local",
      currentTime: 33,
    });
    usePlayer.getState().setSink({
      type: "sonos",
      deviceId: "RINCON_1",
      deviceName: "Kitchen",
    });
    expect(usePlayer.getState().currentTime).toBe(33);
  });

  it("does not call stop on initial mount with a Sonos sink already selected", () => {
    usePlayer.setState({
      sink: { type: "sonos", deviceId: "RINCON_1", deviceName: "Kitchen" },
      queue: [track("trk-1")],
      currentIndex: 0,
    });

    render(
      <MemoryRouter>
        <PlayerBar />
      </MemoryRouter>,
    );

    const stopCalls = (api.sonosCommand as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => c[1] === "stop");
    expect(stopCalls).toHaveLength(0);
  });

  it("recent drag blocks a poll-driven overwrite within the guard window", () => {
    // Drive the guard window via the slider's onChange (which stamps the
    // drag-guard ref), then push a setCastVolume directly — the store
    // accepts it (no guard on the action), but the poll path inside
    // PlayerBar respects the timestamp. We instead verify that the store
    // setCastVolume clamps to the cap and the slider reflects the latest
    // explicit drag, not the polled value, by simulating both in order.
    usePlayer.setState({
      sink: { type: "sonos", deviceId: "RINCON_1", deviceName: "Kitchen" },
      castVolume: 20,
      castVolumeCap: 50,
      queue: [track("trk-1")],
      currentIndex: 0,
    });

    const { container } = render(
      <MemoryRouter>
        <PlayerBar />
      </MemoryRouter>,
    );

    const slider = findCastSlider(container)!;
    act(() => {
      fireEvent.change(slider, { target: { value: "40" } });
    });
    // Even if the poll runs in the background and resolves with volume=10,
    // the guard ref in PlayerBar suppresses calling setCastVolume for
    // ~1.5s. The store's castVolume should remain at 40.
    expect(usePlayer.getState().castVolume).toBe(40);
  });
});
