// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import type { SearchEntryView, SearchWatchEventView } from "@/api/search";
import { HEARTBEAT, type Heartbeat } from "@/api/stream";
import { useSearchWatch } from "./useAgentSearch";

function entry(over: Partial<SearchEntryView> = {}): SearchEntryView {
  return {
    id: "q-1",
    mode: "agent",
    query: "where?",
    createdAtMs: 0,
    finishedAtMs: null,
    status: "running",
    error: "",
    answer: "",
    hits: [],
    steps: [],
    searches: 0,
    threadsRead: 0,
    model: "",
    costUsd: 0,
    durationMs: 0,
    unseen: false,
    version: 1,
    promotedThreadId: "",
    findHits: 0,
    ...over,
  };
}
const hit = (n: number) => ({ n, threadId: "s-a", threadName: "A", archived: false, itemId: `i-${String(n)}`, ordinal: n, speaker: "assistant" as const, itemAtMs: null, quote: "q", why: "w", opened: false });

/** A Watch whose attempts play scripts in turn: events, then an end or an error. */
function scripted(attempts: { events: SearchWatchEventView[]; then: "end" | "hold" | Error }[]) {
  let i = 0;
  const opens = { n: 0 };
  const watch = async function* (_id: string, signal: AbortSignal): AsyncGenerator<SearchWatchEventView | Heartbeat> {
    opens.n++;
    const a = attempts[Math.min(i++, attempts.length - 1)];
    if (!a) return;
    yield HEARTBEAT;
    for (const ev of a.events) yield ev;
    if (a.then instanceof Error) throw a.then;
    if (a.then === "hold")
      await new Promise((r) => {
        signal.addEventListener("abort", r);
      });
  };
  return { watch, opens };
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

describe("useSearchWatch", () => {
  it("shows the seed until the snapshot, folds the events, and ends after the status without reconnecting", async () => {
    const { watch, opens } = scripted([
      {
        events: [
          { kind: "snapshot", version: 1, entry: entry() },
          { kind: "hit", version: 2, hit: hit(1) },
          { kind: "answer", version: 3, text: "Yes [1]." },
          { kind: "status", version: 4, status: "done", error: "", finishedAtMs: 1, costUsd: 0.02, durationMs: 9000, unseen: true },
        ],
        then: "end",
      },
    ]);
    const seed = entry({ query: "seeded" });
    const { result } = renderHook(() => useSearchWatch("q-1", seed, watch));
    expect(result.current.entry?.query).toBe("seeded");
    await wait(50);
    expect(result.current.entry).toMatchObject({ status: "done", answer: "Yes [1].", version: 4, unseen: true });
    expect(result.current.entry?.hits.map((h) => h.n)).toEqual([1]);
    await wait(600);
    expect(opens.n).toBe(1);
  });

  it("a dropped stream while it runs reconnects and resyncs from the new snapshot", async () => {
    const { watch, opens } = scripted([
      { events: [{ kind: "snapshot", version: 1, entry: entry() }, { kind: "hit", version: 2, hit: hit(1) }], then: new Error("network") },
      { events: [{ kind: "snapshot", version: 5, entry: entry({ version: 5, hits: [hit(1), hit(2)] }) }], then: "hold" },
    ]);
    const { result, unmount } = renderHook(() => useSearchWatch("q-1", null, watch));
    await wait(700);
    expect(opens.n).toBe(2);
    expect(result.current.entry?.version).toBe(5);
    expect(result.current.entry?.hits.map((h) => h.n)).toEqual([1, 2]);
    unmount();
  });

  it("a forgotten search (NOT_FOUND) is gone and not watched again", async () => {
    const { watch, opens } = scripted([{ events: [{ kind: "snapshot", version: 1, entry: entry() }], then: new ConnectError("no search q-1", Code.NotFound) }]);
    const { result } = renderHook(() => useSearchWatch("q-1", null, watch));
    await wait(600);
    expect(result.current.gone).toBe(true);
    expect(opens.n).toBe(1);
  });

  it("no search shown holds no stream", async () => {
    const { watch, opens } = scripted([{ events: [], then: "end" }]);
    const { result } = renderHook(() => useSearchWatch(null, null, watch));
    await wait(20);
    expect(opens.n).toBe(0);
    expect(result.current.entry).toBeNull();
  });
});
