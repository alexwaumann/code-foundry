import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { blankFile, type FileReadView } from "@/api/files";
import { useHealthStore } from "@/stores/health";
import { useMediaPlayerStore } from "@/stores/mediaPlayer";
import { MediaPlayer, type MediaKind } from "./MediaPlayer";

// The daemon's StreamFile: a URL per answer, counted.
const streamFile = vi.hoisted(() => vi.fn<(base: string, path: string) => Promise<{ url: string; mime: string; size: number; modifiedAtMs: number | null }>>());
vi.mock("@/api/files", async (orig) => ({
  ...(await orig<typeof import("@/api/files")>()),
  streamFile: (base: string, path: string) => streamFile(base, path),
}));
const revealed = vi.hoisted(() => vi.fn());
vi.mock("../../fileActions", () => ({ revealInFinder: revealed, openInEditor: vi.fn() }));

/**
 * jsdom has no media playback: each element gets a fake of what the player reads and sets
 * (time, length, frame, paused, error, volume, speed), and play, pause and load only record
 * the call and fire what a browser would.
 */
interface Fake {
  paused: boolean;
  currentTime: number;
  duration: number;
  readyState: number;
  error: { code: number } | null;
  videoWidth: number;
  videoHeight: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  defaultPlaybackRate: number;
}
const fakes = new WeakMap<HTMLMediaElement, Fake>();
function fake(el: HTMLMediaElement): Fake {
  let f = fakes.get(el);
  if (!f) {
    f = { paused: true, currentTime: 0, duration: Number.NaN, readyState: 0, error: null, videoWidth: 0, videoHeight: 0, volume: 1, muted: false, playbackRate: 1, defaultPlaybackRate: 1 };
    fakes.set(el, f);
  }
  return f;
}
const calls = { play: vi.fn<(el: HTMLMediaElement) => void>(), pause: vi.fn<(el: HTMLMediaElement) => void>(), load: vi.fn<(el: HTMLMediaElement) => void>() };

beforeAll(() => {
  const props = ["paused", "currentTime", "duration", "readyState", "error", "volume", "muted", "playbackRate", "defaultPlaybackRate"] as const;
  for (const p of props) {
    Object.defineProperty(HTMLMediaElement.prototype, p, {
      configurable: true,
      get(this: HTMLMediaElement) {
        return fake(this)[p];
      },
      set(this: HTMLMediaElement, v: never) {
        fake(this)[p] = v;
      },
    });
  }
  for (const p of ["videoWidth", "videoHeight"] as const) {
    Object.defineProperty(HTMLVideoElement.prototype, p, {
      configurable: true,
      get(this: HTMLVideoElement) {
        return fake(this)[p];
      },
    });
  }
  Object.defineProperty(HTMLMediaElement.prototype, "buffered", { configurable: true, get: () => ({ length: 0, start: () => 0, end: () => 0 }) });
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    calls.play(this);
    fake(this).paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
    calls.pause(this);
    if (!fake(this).paused) {
      fake(this).paused = true;
      this.dispatchEvent(new Event("pause"));
    }
  };
  HTMLMediaElement.prototype.load = function (this: HTMLMediaElement) {
    calls.load(this);
  };
});

const up = (pid: number) => {
  useHealthStore.setState({ status: "ok", health: { pid, version: "dev", uptimeSeconds: 1 }, error: null });
};
let urls = 0;
beforeEach(() => {
  up(1);
  urls = 0;
  streamFile.mockImplementation(() => Promise.resolve({ url: `http://127.0.0.1:7/media/g${String(++urls)}/a.webm`, mime: "video/webm", size: 3_250_586, modifiedAtMs: 1 }));
});
afterEach(() => {
  cleanup();
  streamFile.mockReset();
  revealed.mockReset();
  for (const c of Object.values(calls)) c.mockReset();
  useMediaPlayerStore.setState({ volume: 1, muted: false, rate: 1 });
  localStorage.clear();
  Reflect.deleteProperty(document, "fullscreenEnabled");
});

const PATH = "/Users/me/w/thread-open.webm";
const read = (over: Partial<FileReadView> = {}): FileReadView => ({ ...blankFile(PATH), text: null, lossless: false, binary: true, media: true, mime: "video/webm", size: 3_250_586, modifiedAtMs: 1, ...over });

function player(kind: MediaKind = "video", path = PATH, onMeta = vi.fn()) {
  const file = read({ path, mime: kind === "video" ? "video/webm" : "audio/mpeg" });
  return render(<MediaPlayer kind={kind} file={file} path={path} name={path.split("/").pop() ?? ""} mode="play" place={{ project: "p", dir: "/Users/me/w", file: path }} page={undefined} reloads={0} findKey={undefined} onMeta={onMeta} onMode={vi.fn()} />);
}
const element = (root: HTMLElement | Document = document) => within(root as HTMLElement).getByTestId("media-element") as HTMLMediaElement;
const streaming = async (url: string, root?: HTMLElement) => {
  await waitFor(() => {
    expect(element(root).getAttribute("src")).toBe(url);
  });
};
/** The element loaded its metadata: a 42 s, 1440 × 900 video. */
const loaded = (el: HTMLMediaElement, over: Partial<Fake> = {}) => {
  Object.assign(fake(el), { duration: 42, videoWidth: 1440, videoHeight: 900, readyState: 1, ...over });
  fireEvent.loadedMetadata(el);
};
const failsWith = (el: HTMLMediaElement, code: number) => {
  fake(el).error = { code };
  fireEvent.error(el);
};

describe("MediaPlayer", () => {
  it("asks for a URL once and streams it with metadata only; nothing plays until asked", async () => {
    player();
    await streaming("http://127.0.0.1:7/media/g1/a.webm");
    const el = element();
    expect(streamFile).toHaveBeenCalledTimes(1);
    expect(streamFile).toHaveBeenCalledWith("/Users/me/w", PATH);
    expect(el.getAttribute("preload")).toBe("metadata");
    expect(el.hasAttribute("autoplay")).toBe(false);
    expect(el.hasAttribute("controls")).toBe(false);
    expect(calls.play).not.toHaveBeenCalled();
  });

  it("fills row two and the length once the metadata loads", async () => {
    const onMeta = vi.fn();
    player("video", PATH, onMeta);
    await streaming("http://127.0.0.1:7/media/g1/a.webm");
    expect(onMeta).not.toHaveBeenCalled();
    loaded(element());
    expect(onMeta).toHaveBeenLastCalledWith("0:42 · 1440 × 900 · 3.1 MB · WebM");
    expect(screen.getByTestId("media-duration").textContent).toBe("0:42");
    expect(screen.getByTestId("media-time").textContent).toBe("0:00");
  });

  it("a file WebKit cannot play gets a clear state with Open in Finder, and is not asked for again", async () => {
    player();
    await streaming("http://127.0.0.1:7/media/g1/a.webm");
    failsWith(element(), 4);
    const state = await screen.findByTestId("file-media-unplayable");
    expect(state.textContent).toContain("This video format cannot be played here");
    expect(screen.queryByTestId("media-controls")).toBeNull();
    fireEvent.click(within(state).getByRole("button", { name: "Open in Finder" }));
    expect(revealed).toHaveBeenCalledWith({ project: "p", dir: "/Users/me/w", file: PATH });
    expect(streamFile).toHaveBeenCalledTimes(1);
  });

  it("an audio file that cannot play says so as audio", async () => {
    player("audio", "/Users/me/w/song.ogg");
    await streaming("http://127.0.0.1:7/media/g1/a.webm");
    failsWith(element(), 3);
    expect((await screen.findByTestId("file-media-unplayable")).textContent).toContain("This audio format cannot be played here");
  });

  it("a URL that played and then failed (the daemon restarted: 404) is asked for again, and playback picks up where it was", async () => {
    player();
    await streaming("http://127.0.0.1:7/media/g1/a.webm");
    const el = element();
    loaded(el);
    fireEvent.click(screen.getByTestId("media-play"));
    expect(calls.play).toHaveBeenCalledTimes(1);
    fake(el).currentTime = 20;
    fireEvent.timeUpdate(el);
    failsWith(el, 4);
    await streaming("http://127.0.0.1:7/media/g2/a.webm");
    expect(streamFile).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("file-media-unplayable")).toBeNull();
    // The new URL loads from the start; its metadata puts it back at 0:20, playing.
    fake(el).error = null;
    fake(el).currentTime = 0;
    loaded(el);
    expect(el.currentTime).toBe(20);
    expect(calls.play).toHaveBeenCalledTimes(2);
  });

  it("a new daemon (another pid) is asked for a new URL before the old one fails; a blip with the same pid is not", async () => {
    player();
    await streaming("http://127.0.0.1:7/media/g1/a.webm");
    const el = element();
    loaded(el);
    fake(el).currentTime = 12;
    act(() => {
      useHealthStore.setState({ status: "connecting", health: null, error: null });
    });
    act(() => {
      up(1);
    });
    expect(streamFile).toHaveBeenCalledTimes(1);
    act(() => {
      up(2);
    });
    await streaming("http://127.0.0.1:7/media/g2/a.webm");
    fake(el).currentTime = 0;
    loaded(el);
    expect(el.currentTime).toBe(12);
    // It was paused: it stays paused.
    expect(calls.play).not.toHaveBeenCalled();
  });

  it("the stream is let go when the player goes (its tab hidden or closed)", async () => {
    const { unmount } = player();
    await streaming("http://127.0.0.1:7/media/g1/a.webm");
    const el = element();
    calls.load.mockReset();
    unmount();
    expect(calls.pause).toHaveBeenCalledWith(el);
    expect(el.hasAttribute("src")).toBe(false);
    expect(calls.load).toHaveBeenCalledWith(el);
  });

  it("a refusal (the file went) shows why, with Retry", async () => {
    streamFile.mockImplementationOnce(() => Promise.reject(new Error("file not found")));
    player();
    const state = await screen.findByTestId("file-media-error");
    expect(state.textContent).toContain("Cannot play the video");
    expect(state.textContent).toContain("file not found");
    fireEvent.click(screen.getByTestId("file-media-retry"));
    await streaming("http://127.0.0.1:7/media/g1/a.webm");
    expect(screen.queryByTestId("file-media-error")).toBeNull();
  });

  it("volume, mute and speed are the remembered ones, for every player", async () => {
    useMediaPlayerStore.setState({ volume: 0.3, muted: true, rate: 1.5 });
    player();
    await streaming("http://127.0.0.1:7/media/g1/a.webm");
    const el = element();
    expect([el.volume, el.muted, el.playbackRate, el.defaultPlaybackRate]).toEqual([0.3, true, 1.5, 1.5]);
    expect(screen.getByTestId("media-speed").textContent).toBe("1.5×");
    expect(screen.getByTestId("media-mute").getAttribute("aria-label")).toBe("Unmute");
    fireEvent.click(screen.getByTestId("media-mute"));
    expect(el.muted).toBe(false);
    expect(JSON.parse(localStorage.getItem("code-foundry.mediaPlayer") ?? "{}")).toMatchObject({ state: { volume: 0.3, muted: false, rate: 1.5 } });
  });

  it("the speed menu offers 0.5× to 2× and remembers the pick", async () => {
    player();
    await streaming("http://127.0.0.1:7/media/g1/a.webm");
    fireEvent.pointerDown(screen.getByTestId("media-speed"), { button: 0, ctrlKey: false });
    const menu = await screen.findByTestId("media-speed-menu");
    expect(within(menu).getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual(["0.5×", "1×", "1.25×", "1.5×", "2×"]);
    fireEvent.click(within(menu).getByText("2×"));
    await waitFor(() => {
      expect(useMediaPlayerStore.getState().rate).toBe(2);
    });
    expect(element().playbackRate).toBe(2);
  });

  it.each<[string, MediaKind, boolean, string[]]>([
    ["video, where the webview allows full screen", "video", true, ["media-play", "media-speed", "media-mute", "media-fullscreen"]],
    ["video, where it does not: no dead button", "video", false, ["media-play", "media-speed", "media-mute"]],
    ["audio", "audio", true, ["media-play", "media-speed", "media-mute"]],
  ])("the controls for %s", async (_, kind, allowed, want) => {
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: allowed });
    document.documentElement.requestFullscreen = () => Promise.resolve();
    player(kind);
    await streaming("http://127.0.0.1:7/media/g1/a.webm");
    const bar = screen.getByTestId("media-controls");
    expect([...bar.querySelectorAll("button[data-testid]")].map((b) => b.getAttribute("data-testid"))).toEqual(want);
    expect(within(bar).getAllByRole("slider").map((s) => s.getAttribute("aria-label"))).toEqual(["Seek", "Volume"]);
  });

  it("keys inside the player: Space, Left and Right, Up and Down, M; a chord with a modifier is left to the window", async () => {
    player();
    await streaming("http://127.0.0.1:7/media/g1/a.webm");
    const el = element();
    loaded(el);
    const root = screen.getByTestId("media-player");
    expect(root.hasAttribute("data-keys-local")).toBe(true);
    fireEvent.keyDown(root, { key: " " });
    expect(calls.play).toHaveBeenCalledTimes(1);
    fake(el).currentTime = 12;
    fireEvent.keyDown(root, { key: "ArrowLeft" });
    expect(el.currentTime).toBe(7);
    fireEvent.keyDown(root, { key: "ArrowRight" });
    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(el.currentTime).toBe(17);
    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(el.volume).toBe(0.9);
    fireEvent.keyDown(root, { key: "m" });
    expect(el.muted).toBe(true);
    // Not handled, so not prevented: the keymap's cmd+left, and a letter that is not the player's.
    expect(fireEvent.keyDown(root, { key: "ArrowLeft", metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(root, { key: "k" })).toBe(true);
    expect(el.currentTime).toBe(17);
    fireEvent.keyDown(root, { key: " " });
    expect(calls.pause).toHaveBeenCalled();
  });

  it("two players of one file play on their own: each its element and position, one URL", async () => {
    player();
    player();
    await waitFor(() => {
      expect(screen.getAllByTestId("media-element").every((e) => e.getAttribute("src") === "http://127.0.0.1:7/media/g1/a.webm" || e.getAttribute("src") === "http://127.0.0.1:7/media/g2/a.webm")).toBe(true);
    });
    const [a, b] = screen.getAllByTestId("media-element") as HTMLMediaElement[];
    if (!a || !b) throw new Error("two players");
    loaded(a);
    loaded(b);
    const [playA] = screen.getAllByTestId("media-play");
    if (!playA) throw new Error("a play button");
    fireEvent.click(playA);
    expect(calls.play).toHaveBeenCalledWith(a);
    expect(calls.play).not.toHaveBeenCalledWith(b);
    expect(screen.getAllByTestId("media-player").map((p) => p.dataset.playing ?? "")).toEqual(["true", ""]);
  });
});
