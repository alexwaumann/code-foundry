/**
 * Hiding and showing the window leaves the streams alone (docs/notes/ws-stall-workarounds.md).
 * The thread's Watch, Ember's board and dictation's Watch used to reopen on show, for fetch
 * in WKWebView holding back a stream's last bytes. Over the tunnel nothing is held, so a
 * show would only resend each snapshot (a thread's reaches 49 MB) and reconnect them all
 * at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DictationView } from "@/api/dictation";
import type { EmberBoardView } from "@/api/ember";
import type { ThreadEventView } from "@/api/thread";
import { holdDictation } from "./dictation";
import { holdEmberBoard } from "./ember";
import { startThreadWatch, useThreadStore } from "./thread";

const opened = vi.hoisted(() => ({ thread: 0, board: 0, dictation: 0 }));

/** A stream that sends one snapshot and then stays open until aborted. */
async function* oneSnapshot<T>(snap: T, signal: AbortSignal): AsyncGenerator<T> {
  yield snap;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => {
      resolve();
    });
  });
}

vi.mock("@/api/thread", async (orig) => ({
  ...(await orig<typeof import("@/api/thread")>()),
  watchThread: (_id: string, signal: AbortSignal) => {
    opened.thread++;
    const snap = { kind: "snapshot", threadId: "s", seq: opened.thread, items: [], pending: [], mcp: null, commands: [], agents: [] } satisfies ThreadEventView;
    return oneSnapshot(snap, signal);
  },
}));
vi.mock("@/api/ember", async (orig) => ({
  ...(await orig<typeof import("@/api/ember")>()),
  watchEmberBoard: (signal: AbortSignal) => {
    opened.board++;
    return oneSnapshot({} as EmberBoardView, signal);
  },
}));
vi.mock("@/api/dictation", async (orig) => ({
  ...(await orig<typeof import("@/api/dictation")>()),
  watchDictation: (signal: AbortSignal) => {
    opened.dictation++;
    return oneSnapshot({ micDenied: false } as DictationView, signal);
  },
  reportComposerTarget: () => Promise.resolve(),
}));

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => state === "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("streams across hiding and showing the window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useThreadStore.setState({ logs: {}, pending: {}, watches: {}, folds: {}, expanded: {} });
    opened.thread = 0;
    opened.board = 0;
    opened.dictation = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("keeps the thread's Watch, Ember's board and dictation's Watch open, with no new snapshot", async () => {
    const stops = [startThreadWatch("s"), holdEmberBoard(), holdDictation()];
    await vi.advanceTimersByTimeAsync(50);
    expect(opened).toEqual({ thread: 1, board: 1, dictation: 1 });
    expect(useThreadStore.getState().logs.s?.seq).toBe(1);

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(30_000);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(opened).toEqual({ thread: 1, board: 1, dictation: 1 });
    expect(useThreadStore.getState().logs.s?.seq).toBe(1);
    expect(useThreadStore.getState().watches.s?.status).toBe("open");
    for (const stop of stops) stop();
  });
});
