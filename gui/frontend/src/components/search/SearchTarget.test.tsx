// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHitView, SearchEntryView, SearchWatchEventView } from "@/api/search";
import type { ThreadItemView } from "@/api/thread";
import type { SearchResultView } from "@/api/threadSearch";
import { HEARTBEAT, type Heartbeat } from "@/api/stream";
import { stubLayout, settle } from "@/test/composerWorld";

// jsdom lays nothing out: every row at its estimated size (as SearchDialog.test.tsx).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (o: { count: number; estimateSize: (i: number) => number; getItemKey: (i: number) => string | number }) => {
    const items: { index: number; key: string | number; start: number; size: number; end: number }[] = [];
    let at = 0;
    for (let i = 0; i < o.count; i++) {
      const size = o.estimateSize(i);
      items.push({ index: i, key: o.getItemKey(i), start: at, size, end: at + size });
      at += size;
    }
    return { getVirtualItems: () => items, getTotalSize: () => at, measure: () => undefined, scrollToIndex: () => undefined, scrollToOffset: () => undefined };
  },
}));

/** A stream the test feeds: each open is an attempt that yields what is pushed until ended or failed. */
class Feed<T> {
  private queue: (T | Heartbeat)[] = [];
  private wake: (() => void) | null = null;
  private state: { ended: boolean; failure: Error | null } = { ended: false, failure: null };
  opens = 0;
  push(...vs: T[]): void {
    this.queue.push(...vs);
    this.wake?.();
  }
  end(): void {
    this.state.ended = true;
    this.wake?.();
  }
  fail(err: Error): void {
    this.state.failure = err;
    this.wake?.();
  }
  private now(): { ended: boolean; failure: Error | null } {
    return this.state;
  }
  async *open(signal: AbortSignal): AsyncGenerator<T | Heartbeat> {
    this.opens++;
    this.state = { ended: false, failure: null };
    yield HEARTBEAT;
    while (!signal.aborted) {
      const v = this.queue.shift();
      if (v !== undefined) {
        yield v;
        continue;
      }
      const st = this.now();
      if (st.failure) throw st.failure;
      if (st.ended) return;
      await new Promise<void>((r) => {
        this.wake = r;
        signal.addEventListener("abort", () => {
          r();
        });
      });
      this.wake = null;
    }
  }
}

const watches = new Map<string, Feed<SearchWatchEventView>>();
const watchOf = (id: string) => {
  let f = watches.get(id);
  if (!f) {
    f = new Feed<SearchWatchEventView>();
    watches.set(id, f);
  }
  return f;
};
const recent = new Feed<SearchEntryView[]>();
const startAgentSearch = vi.fn<(q: string) => Promise<SearchEntryView>>();
vi.mock("@/api/search", async (orig) => ({
  ...(await orig<typeof import("@/api/search")>()),
  startAgentSearch: (q: string) => startAgentSearch(q),
  watchSearch: (id: string, signal: AbortSignal) => watchOf(id).open(signal),
  watchRecentSearches: (signal: AbortSignal) => recent.open(signal),
}));
const search = vi.fn<(query: string) => Promise<SearchResultView>>();
const hitItem = vi.fn<(threadId: string, itemId: string, ordinal: number) => Promise<ThreadItemView | null>>();
vi.mock("@/api/threadSearch", async (orig) => ({
  ...(await orig<typeof import("@/api/threadSearch")>()),
  searchThreads: (q: string) => search(q),
  readHitItem: (t: string, i: string, o: number) => hitItem(t, i, o),
  readPromptBefore: () => Promise.resolve(null),
  readLastReply: () => Promise.resolve(null),
}));
vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));

const { useUiStore } = await import("@/stores/ui");
const { setSearchTarget, useSearchDialogStore } = await import("@/stores/searchDialog");
const { useCiteStore } = await import("@/stores/cite");
const { invocationsOf, resetDaemon } = await import("@/test/daemonFakes");
const { addThreads, seedWorld, thread } = await import("@/test/projectsWorld");
const { CommandPalette } = await import("@/components/palette/CommandPalette");

const hit = (n: number, over: Partial<AgentHitView> = {}): AgentHitView => ({
  n,
  threadId: "s-a",
  threadName: "Poll checks by fingerprint",
  archived: n === 1,
  itemId: `i-${String(n)}`,
  ordinal: n * 2,
  speaker: "assistant",
  itemAtMs: null,
  quote: `the quote of hit ${String(n)}`,
  why: `why ${String(n)}`,
  opened: false,
  ...over,
});
function entry(over: Partial<SearchEntryView> = {}): SearchEntryView {
  return {
    id: "q-1",
    mode: "agent",
    query: "where did we decide it?",
    createdAtMs: Date.now(),
    finishedAtMs: null,
    status: "running",
    error: "",
    answer: "",
    hits: [],
    steps: [],
    searches: 0,
    threadsRead: 0,
    model: "claude-sonnet-5-5[1m]",
    costUsd: 0,
    durationMs: 0,
    unseen: false,
    version: 1,
    promotedThreadId: "",
    findHits: 0,
    ...over,
  };
}
const done = (over: Partial<SearchEntryView> = {}) =>
  entry({ status: "done", answer: "Kept check-count based [1]; again in [2].", hits: [hit(1), hit(2), hit(3)], searches: 2, threadsRead: 3, durationMs: 21_000, version: 9, ...over });

const base = { parentToolUseId: "", createdAtMs: 0, updatedAtMs: 0, streaming: false } as const;
const textItem = (id: string, ordinal: number, text: string): ThreadItemView => ({ ...base, id, ordinal, kind: "text", text });

async function open(): Promise<void> {
  act(() => {
    useUiStore.getState().openSearchPalette();
  });
  await settle(10);
}
async function close(): Promise<void> {
  act(() => {
    useUiStore.getState().closePalette();
  });
  await settle(10);
}

const dialog = () => screen.getByTestId("search-dialog");
const input = (): HTMLInputElement => screen.getByTestId<HTMLInputElement>("search-input");
const key = (k: string, init: KeyboardEventInit = {}) => {
  fireEvent.keyDown(input(), { key: k, ...init });
};
async function type(q: string): Promise<void> {
  fireEvent.change(input(), { target: { value: q } });
  await settle(10);
}
const hitRows = () => screen.queryAllByTestId("agent-hit");
const selectedHit = () => hitRows().find((r) => r.hasAttribute("data-selected"))?.getAttribute("data-n");

/** Shows a running search for the typed question: Enter, StartAgent's entry, Watch's snapshot. */
async function startShown(e: SearchEntryView = entry()): Promise<void> {
  startAgentSearch.mockResolvedValueOnce(e);
  await type(e.query);
  key("Enter");
  await settle(20);
  watchOf(e.id).push({ kind: "snapshot", version: e.version, entry: e });
  await settle(20);
}

beforeEach(() => {
  stubLayout();
  resetDaemon();
  seedWorld();
  addThreads(thread("s-a", { name: "Poll checks by fingerprint" }), thread("s-b", { name: "gh granular events" }), thread("s-new", { name: "PR poller CI rerun refetch decision" }));
  useSearchDialogStore.setState({ mode: "agent", session: null, pending: null, target: null });
  useCiteStore.setState({ flash: null, editing: null });
  watches.clear();
  startAgentSearch.mockReset();
  search.mockReset();
  search.mockImplementation((q) => Promise.resolve({ query: q, threads: [], groups: [], caseSensitive: false, namesOnly: false, totalHits: 0, totalThreads: 0, truncated: false }));
  hitItem.mockReset();
  hitItem.mockImplementation((_t, id, o) => Promise.resolve(textItem(id, o, `Before. The quote of hit ${id.slice(2)} is here. After.`)));
  render(<CommandPalette />);
});

afterEach(() => {
  cleanup();
  act(() => {
    useUiStore.getState().closePalette();
  });
  vi.restoreAllMocks();
});

describe("opened on a search (the sidebar's row)", () => {
  async function openOn(e: SearchEntryView): Promise<void> {
    act(() => {
      setSearchTarget(e);
      useUiStore.getState().openSearchPalette();
    });
    await settle(10);
  }

  it("shows that search with its results, marks it seen, and leaves the target taken", async () => {
    const e = done({ id: "q-7", query: "which threads fixed the badge?", unseen: true, hits: [hit(1), hit(2)] });
    await openOn(e);
    expect(dialog().dataset.mode).toBe("agent");
    expect(input().value).toBe("which threads fixed the badge?");
    watchOf("q-7").push({ kind: "snapshot", version: e.version, entry: e });
    await settle(20);
    expect(hitRows()).toHaveLength(2);
    expect(selectedHit()).toBe("1");
    expect(invocationsOf("search.seen").map((i) => i.args)).toEqual([{ id: "q-7" }]);
    expect(useSearchDialogStore.getState().target).toBeNull();
  });

  it("from Find too, and whatever a restored session held", async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    await open();
    await startShown(done());
    await close();
    useSearchDialogStore.setState({ mode: "find" });
    now.mockReturnValue(t0 + 60_000);
    await openOn(done({ id: "q-7", query: "another one", unseen: true }));
    expect(dialog().dataset.mode).toBe("agent");
    expect(input().value).toBe("another one");
  });

  it("the search the last close showed keeps its place", async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    await open();
    const e = done({ hits: [hit(1), hit(2), hit(3)] });
    await startShown(e);
    key("ArrowDown");
    await settle(10);
    expect(selectedHit()).toBe("2");
    await close();
    now.mockReturnValue(t0 + 60_000);
    await openOn({ ...e, unseen: true });
    watchOf(e.id).push({ kind: "snapshot", version: e.version + 1, entry: e });
    await settle(20);
    expect(selectedHit()).toBe("2");
  });

  it("a running one: its question, and no second run on open; it is seen when it ends in view", async () => {
    const e = entry({ id: "q-r", query: "still going?", status: "running" });
    await openOn(e);
    expect(input().value).toBe("still going?");
    expect(startAgentSearch).not.toHaveBeenCalled();
    watchOf("q-r").push({ kind: "snapshot", version: e.version, entry: e });
    await settle(20);
    expect(invocationsOf("search.seen")).toHaveLength(0);
    const end = done({ id: "q-r", query: "still going?", unseen: true, version: e.version + 1 });
    watchOf("q-r").push({ kind: "snapshot", version: end.version, entry: end });
    await settle(20);
    expect(invocationsOf("search.seen").map((i) => i.args)).toEqual([{ id: "q-r" }]);
  });

  it("another unseen search is cued, not jumped to", async () => {
    await openOn(done({ id: "q-7", query: "the one clicked", unseen: true }));
    recent.push([done({ id: "q-8", query: "the other", unseen: true, hits: [hit(1)] }), done({ id: "q-7", query: "the one clicked", unseen: true })]);
    await settle(20);
    expect(input().value).toBe("the one clicked");
    expect(screen.getByTestId("search-unseen-cue").dataset.id).toBe("q-8");
  });

  it("a target while the dialog is open moves it there (the CLI's search open)", async () => {
    await open();
    await openOn(done({ id: "q-7", query: "from the CLI" }));
    expect(input().value).toBe("from the CLI");
  });
});
