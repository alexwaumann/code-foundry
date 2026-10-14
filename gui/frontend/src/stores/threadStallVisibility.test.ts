/**
 * docs/notes/thread-render-stall.md, cause 1: after the Wails window was hidden, minimized
 * or covered, WKWebView holds the last bytes of the ThreadService.Watch response until more
 * bytes arrive. The stream stays open, so nothing reconnects, and the thread shows a stale
 * tail until the user leaves and comes back. These tests describe the proposed client half
 * of the fix (resync when the page becomes visible) and FAIL until it lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadEventView } from "@/api/thread";
import { startThreadWatch, useThreadStore } from "./thread";

const watched = vi.hoisted(() => ({ opened: 0 }));
vi.mock("@/api/thread", async (orig) => ({
  ...(await orig<typeof import("@/api/thread")>()),
  // A stream that delivers its snapshot and then nothing (the held tail never arrives).
  watchThread: async function* (_id: string, signal: AbortSignal) {
    watched.opened++;
    yield { kind: "snapshot", sessionId: "s", seq: watched.opened, items: [], pending: [], mcp: null, commands: [] } satisfies ThreadEventView;
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => {
        resolve();
      });
    });
  },
}));

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => state === "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("the visible thread's Watch after the window was hidden", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useThreadStore.setState({ logs: {}, pending: {}, watch: null, folds: {}, expanded: {} });
    watched.opened = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("gets a fresh snapshot when the page becomes visible again", async () => {
    const stop = startThreadWatch("s");
    await vi.advanceTimersByTimeAsync(50);
    expect(watched.opened).toBe(1);
    expect(useThreadStore.getState().logs.s?.seq).toBe(1);

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(30_000);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(1_000);

    // Today nothing happens: the open stream is trusted, and the stale log stays.
    expect(watched.opened).toBe(2);
    expect(useThreadStore.getState().logs.s?.seq).toBe(2);
    stop();
  });

  it("does not resync a page that never went hidden", async () => {
    const stop = startThreadWatch("s");
    await vi.advanceTimersByTimeAsync(50);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(watched.opened).toBe(1);
    stop();
  });
});
