import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import { useThreadsStore } from "@/stores/threads";
import { ColdCacheNote } from "./ColdCacheNote";

/**
 * The composer's cold-cache line (docs/notes/rendered-threads-cold-cache.md) as the mock's
 * "Fix stale PR badge" has it: 25.7K tokens of context that cost about $0.26 to re-read.
 * The rule itself is lib/coldCache.test.ts's.
 */

const NOTE = "Cache expired · the next message re-reads 25.7K tokens (~$0.26)";
const NOW = new Date(2026, 9, 20, 15, 0).getTime();

function put(o: Partial<ThreadView>): void {
  useThreadsStore.setState({
    byId: { "s-r1": { id: "s-r1", state: "connected", status: "idle", contextTokens: 25_700, contextRereadUsd: 0.26, cacheExpiresAtMs: NOW + 10_000, ...o } as ThreadView },
    order: ["s-r1"],
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ColdCacheNote", () => {
  it("appears on its own 30 s re-check while the user looks, with nothing new from the daemon", () => {
    put({});
    render(<ColdCacheNote threadId="s-r1" pending={0} />);
    // Expires in 10 s: still warm.
    expect(screen.queryByTestId("thread-cold-cache")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(screen.getByTestId("thread-cold-cache").textContent).toBe(NOTE);
  });

  it("shows at once when a thread update says the cache expired", () => {
    put({});
    render(<ColdCacheNote threadId="s-r1" pending={0} />);
    expect(screen.queryByTestId("thread-cold-cache")).toBeNull();
    act(() => {
      put({ cacheExpiresAtMs: NOW - 60_000 });
    });
    expect(screen.getByTestId("thread-cold-cache").textContent).toBe(NOTE);
  });

  it("a pending prompt hides it", () => {
    put({ cacheExpiresAtMs: NOW - 60_000 });
    const { rerender } = render(<ColdCacheNote threadId="s-r1" pending={0} />);
    expect(screen.getByTestId("thread-cold-cache")).toBeTruthy();
    rerender(<ColdCacheNote threadId="s-r1" pending={1} />);
    expect(screen.queryByTestId("thread-cold-cache")).toBeNull();
  });

  it("a working thread hides it", () => {
    put({ cacheExpiresAtMs: NOW - 60_000, status: "busy" });
    render(<ColdCacheNote threadId="s-r1" pending={0} />);
    expect(screen.queryByTestId("thread-cold-cache")).toBeNull();
  });
});
