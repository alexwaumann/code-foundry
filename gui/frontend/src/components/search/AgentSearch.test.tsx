// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
const { useCommandsStore } = await import("@/stores/commands");
const { DictateHint } = await import("./AgentSearch");
const { useSearchDialogStore } = await import("@/stores/searchDialog");
const { useCiteStore } = await import("@/stores/cite");
const { useThreadStore } = await import("@/stores/thread");
const { answerConfirm, useConfirmStore } = await import("@/stores/confirm");
const { daemon, invocationsOf, confirmFirst, resetDaemon } = await import("@/test/daemonFakes");
const { addThreads, seedWorld, thread } = await import("@/test/projectsWorld");
const { CommandPalette } = await import("@/components/palette/CommandPalette");
const { SEARCH_DEBOUNCE_MS, PREVIEW_DEBOUNCE_MS } = await import("./useSearch");
const { ANSWER_ROW, RESTORE_MS } = await import("@/lib/agentSearch");

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

async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
  await settle(10);
}

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
const answerRow = () => screen.queryByTestId("agent-answer-row");
const answerSelected = () => answerRow()?.hasAttribute("data-selected") ?? false;

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
  useSearchDialogStore.setState({ mode: "agent", session: null, pending: null });
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

describe("DictateHint", () => {
  const toggle = (keybindings: string[]) => ({ name: "dictation.toggle", title: "Dictate", description: "", category: "Dictation", args: [], keybindings, available: true });
  it.each([
    ["no chord, the default", [], true, ""],
    ["a bound chord", ["cmd+shift+m"], true, "⇧⌘Mdictate"],
    ["a bound chord, dictation off", ["cmd+shift+m"], false, ""],
  ])("%s", (_name, keybindings, canDictate, want) => {
    useCommandsStore.setState({ commands: [toggle(keybindings)] });
    const { container } = render(<DictateHint canDictate={canDictate} />);
    expect(container.textContent).toBe(want);
  });
});

describe("modes", () => {
  it("opens in Agent search with a sparkle; Tab switches to Find keeping the query, and the last mode is remembered across opens and restarts", async () => {
    await open();
    expect(dialog().dataset.mode).toBe("agent");
    expect(screen.getByTestId("search-header-icon").dataset.icon).toBe("sparkle");
    expect(screen.getByTestId("search-mode-agent").getAttribute("aria-pressed")).toBe("true");
    await type("fingerprint");
    key("Tab");
    await settle(10);
    expect(dialog().dataset.mode).toBe("find");
    expect(screen.getByTestId("search-header-icon").dataset.icon).toBe("search");
    expect(input().value).toBe("fingerprint");
    // Find searches as it types; Agent search did not.
    await wait(SEARCH_DEBOUNCE_MS + 20);
    expect(search).toHaveBeenCalledWith("fingerprint");
    expect(startAgentSearch).not.toHaveBeenCalled();
    // Persisted (localStorage), so an app restart opens on Find too.
    expect(JSON.parse(localStorage.getItem("code-foundry.searchDialog") ?? "{}")).toMatchObject({ state: { mode: "find" } });
    await close();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + RESTORE_MS + 1000);
    await open();
    expect(dialog().dataset.mode).toBe("find");
    expect(input().value).toBe("");
    key("Tab");
    await settle(10);
    expect(dialog().dataset.mode).toBe("agent");
  });

  it("the mode switch's buttons switch too, and the field keeps the keyboard", async () => {
    await open();
    fireEvent.click(screen.getByTestId("search-mode-find"));
    await settle(10);
    expect(dialog().dataset.mode).toBe("find");
    expect(document.activeElement).toBe(input());
  });
});

describe("Agent search", () => {
  it("typing does not search; Enter starts it; steps and verified hits arrive while it runs, with the time and Stop", async () => {
    await open();
    await type("where did we decide it?");
    await wait(SEARCH_DEBOUNCE_MS + 20);
    expect(startAgentSearch).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    await startShown();
    expect(startAgentSearch).toHaveBeenCalledWith("where did we decide it?");
    expect(screen.getByTestId("agent-results").dataset.status).toBe("running");
    const w = watchOf("q-1");
    w.push(
      { kind: "step", version: 2, step: { index: 0, kind: "search", done: false, failed: false, text: "Searching rerun refetch…", query: "rerun refetch", threadName: "" } },
      { kind: "step", version: 3, step: { index: 0, kind: "search", done: true, failed: false, text: "Searched rerun refetch · 6 hits", query: "rerun refetch", threadName: "" } },
      { kind: "step", version: 4, step: { index: 1, kind: "read", done: false, failed: false, text: "Reading gh granular events…", query: "", threadName: "gh granular events" } },
      { kind: "step", version: 5, step: { index: 2, kind: "search", done: true, failed: true, text: "Searched x · failed", query: "x", threadName: "" } },
      { kind: "hit", version: 6, hit: hit(1) },
    );
    await settle(20);
    expect(screen.getAllByTestId("agent-step").map((s) => [s.dataset.state, s.textContent])).toEqual([
      ["done", "Searched rerun refetch · 6 hits"],
      ["running", "Reading gh granular events…"],
      ["failed", "Searched x · failed"],
    ]);
    // The query reads in code, the thread name stressed.
    expect(within(screen.getAllByTestId("agent-step")[0] as HTMLElement).getByText("rerun refetch").className).toContain("text-code");
    expect(screen.getByText("Found so far")).toBeTruthy();
    expect(hitRows().map((r) => r.dataset.n)).toEqual(["1"]);
    expect(selectedHit()).toBe("1");
    // The preview follows the selected hit.
    await wait(PREVIEW_DEBOUNCE_MS + 20);
    expect(hitItem).toHaveBeenCalledWith("s-a", "i-1", 2);
    expect(screen.getByTestId("search-preview").dataset.thread).toBe("s-a");
    expect(screen.getByTestId("agent-elapsed").textContent).toMatch(/^\d+s$/);
    fireEvent.click(screen.getByTestId("agent-stop"));
    await settle(10);
    expect(invocationsOf("search.stop").map((i) => i.args)).toEqual([{ id: "q-1" }]);
  });

  it("Esc closes the dialog and does not stop the search", async () => {
    await open();
    await startShown();
    act(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle(20);
    expect(useUiStore.getState().palette.open).toBe(false);
    expect(invocationsOf("search.stop")).toHaveLength(0);
  });

  it("done: the Answer row selected with the whole answer in the pane, a summary line that opens the steps, the ranked hits; opened ones dimmed", async () => {
    await open();
    await startShown(done({ answer: "Kept **check-count** [1]; see [link](http://x) and [2].", hits: [hit(1, { opened: true }), hit(2)], steps: [{ index: 0, kind: "search", done: true, failed: false, text: "Searched a · 1 hit", query: "a", threadName: "" }] }));
    // Left, in order: the Answer row, the summary line, the hits.
    const results = screen.getByTestId("agent-results");
    expect([...results.querySelectorAll('[data-testid="agent-answer-row"], [data-testid="agent-summary"], [data-testid="agent-hit"]')].map((el) => el.getAttribute("data-testid"))).toEqual(["agent-answer-row", "agent-summary", "agent-hit", "agent-hit"]);
    expect(answerSelected()).toBe(true);
    expect(screen.getByTestId("agent-answer-preview").textContent).toBe("Kept check-count; see link and.");
    // Right: rendered, inert, its markers on.
    const answer = within(screen.getByTestId("agent-answer-pane")).getByTestId("agent-answer");
    expect(answer.textContent).toBe("Kept check-count 1; see link and 2.");
    expect(answer.querySelector("strong")?.textContent).toBe("check-count");
    expect(answer.querySelector("a")).toBeNull();
    expect(screen.queryByTestId("search-preview")).toBeNull();
    expect(screen.getByTestId("agent-summary-toggle").textContent).toBe("2 searches · read 3 threads · 21s");
    expect(screen.queryByTestId("agent-steps")).toBeNull();
    fireEvent.click(screen.getByTestId("agent-summary-toggle"));
    expect(screen.getByTestId("agent-steps")).toBeTruthy();
    const [first, second] = hitRows();
    expect(first?.dataset.opened).toBe("true");
    expect(within(first as HTMLElement).getByTestId("agent-hit-opened").textContent).toBe("opened");
    expect(within(second as HTMLElement).getByTestId("agent-hit-quote").textContent).toBe("“the quote of hit 2”");
    expect(within(second as HTMLElement).getByTestId("agent-hit-why").textContent).toBe("why 2");
    expect(screen.getByTestId("search-hints").textContent).toContain("continue in a thread");
    // A marker selects its hit, and the preview takes the pane.
    fireEvent.click(screen.getAllByTestId("agent-answer-ref")[1] as HTMLElement);
    expect(selectedHit()).toBe("2");
    expect(screen.queryByTestId("agent-answer-pane")).toBeNull();
    await wait(PREVIEW_DEBOUNCE_MS + 20);
    expect(screen.getByTestId("search-preview")).toBeTruthy();
    // The row brings the answer back.
    fireEvent.click(answerRow() as HTMLElement);
    expect(answerSelected()).toBe(true);
    expect(screen.getByTestId("agent-answer-pane")).toBeTruthy();
  });

  it("a run's end selects the Answer row; hits arriving before it behave as they did", async () => {
    await open();
    await startShown();
    watchOf("q-1").push({ kind: "hit", version: 2, hit: hit(1) }, { kind: "hit", version: 3, hit: hit(2) }, { kind: "answer", version: 4, text: "It did [1]." });
    await settle(20);
    // The answer has come but the run goes on: no row yet.
    expect(answerRow()).toBeNull();
    expect(selectedHit()).toBe("1");
    watchOf("q-1").push({ kind: "status", version: 5, status: "done", error: "", finishedAtMs: 1, costUsd: 0, durationMs: 1000, unseen: false });
    await settle(20);
    expect(answerSelected()).toBe(true);
    expect(selectedHit()).toBeUndefined();
  });

  it("a hit the user picked while it ran stays selected when it ends", async () => {
    await open();
    await startShown();
    watchOf("q-1").push({ kind: "hit", version: 2, hit: hit(1) }, { kind: "hit", version: 3, hit: hit(2) });
    await settle(20);
    key("ArrowDown");
    expect(selectedHit()).toBe("2");
    watchOf("q-1").push({ kind: "answer", version: 4, text: "It did [1]." }, { kind: "status", version: 5, status: "done", error: "", finishedAtMs: 1, costUsd: 0, durationMs: 1000, unseen: false });
    await settle(20);
    expect(answerRow()).toBeTruthy();
    expect(selectedHit()).toBe("2");
    expect(screen.queryByTestId("agent-answer-pane")).toBeNull();
  });

  it("no answer: no row, the first hit selected, as before", async () => {
    await open();
    await startShown(done({ answer: "" }));
    expect(answerRow()).toBeNull();
    expect(selectedHit()).toBe("1");
    expect(screen.getByTestId("search-hints").textContent).toContain("open and highlight");
  });

  it("an answer with no hits: the row alone, its marker as typed, and a note that nothing was reported", async () => {
    await open();
    await startShown(done({ answer: "It was decided [1].", hits: [] }));
    expect(answerSelected()).toBe(true);
    expect(screen.queryByTestId("agent-answer-ref")).toBeNull();
    expect(screen.getByTestId("agent-answer").textContent).toBe("It was decided [1].");
    expect(screen.getByTestId("agent-ended").textContent).toBe("It reported no messages to open.");
    expect(screen.getByTestId("search-hints").textContent).toContain("search again");
  });

  it("a marker past the hits selects nothing and leaves the pane", async () => {
    await open();
    await startShown(done({ answer: "One [1], past the end [9].", hits: [hit(1)] }));
    expect(screen.getAllByTestId("agent-answer-ref").map((r) => r.textContent)).toEqual(["1"]);
    expect(screen.getByTestId("agent-answer").textContent).toBe("One 1, past the end [9].");
    expect(answerSelected()).toBe(true);
  });

  it("FAILED and STOPPED say so", async () => {
    await open();
    await startShown(entry({ status: "failed", error: "Claude refused --safe-mode", version: 4 }));
    expect(screen.getByTestId("agent-ended").textContent).toBe("Agent search failed: Claude refused --safe-mode.");
    await type("another question");
    await startShown(entry({ id: "q-2", query: "another question", status: "stopped", hits: [hit(1)], version: 4 }));
    expect(screen.getByTestId("agent-ended").textContent).toBe("Stopped. 1 result found before it stopped.");
  });

  it("a finished result shown unseen is marked seen", async () => {
    await open();
    await startShown(done({ unseen: true }));
    expect(invocationsOf("search.seen").map((i) => i.args)).toEqual([{ id: "q-1" }]);
  });

  it("a search forgotten while shown (NOT_FOUND) says so", async () => {
    const { ConnectError, Code } = await import("@connectrpc/connect");
    await open();
    await startShown();
    watchOf("q-1").fail(new ConnectError("no search q-1", Code.NotFound));
    await settle(30);
    expect(screen.getByTestId("agent-gone").textContent).toContain("forgotten");
  });
});

describe("keys on results", () => {
  it("↑/↓ go through the Answer row, wrapping", async () => {
    await open();
    await startShown(done());
    expect(answerSelected()).toBe(true);
    key("ArrowDown");
    expect(selectedHit()).toBe("1");
    key("ArrowUp");
    expect(answerSelected()).toBe(true);
    key("ArrowUp");
    expect(selectedHit()).toBe("3");
    key("ArrowDown");
    expect(answerSelected()).toBe(true);
  });

  it("Enter on the Answer row moves to the first hit: nothing opens, nothing runs again; ⌘⏎ still continues", async () => {
    await open();
    await startShown(done());
    expect(screen.getByTestId("search-hints").textContent).toContain("first result");
    key("Enter");
    await settle(10);
    expect(selectedHit()).toBe("1");
    expect(useUiStore.getState().palette.open).toBe(true);
    expect(invocationsOf("search.open-hit")).toHaveLength(0);
    expect(startAgentSearch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("search-hints").textContent).toContain("open and highlight");
    key("ArrowUp");
    expect(answerSelected()).toBe(true);
    key("Enter", { metaKey: true });
    await settle(10);
    expect(invocationsOf("search.promote").map((i) => i.args)).toEqual([{ id: "q-1" }]);
  });

  it("Enter on a hit marks it opened, closes, selects its thread and reveals the quote once its log has the item", async () => {
    await open();
    await startShown(done());
    key("ArrowDown");
    key("ArrowDown");
    expect(selectedHit()).toBe("2");
    key("Enter");
    await settle(10);
    expect(invocationsOf("search.open-hit").map((i) => i.args)).toEqual([{ id: "q-1", hit: "2" }]);
    expect(useUiStore.getState().palette.open).toBe(false);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-a" });
    // The thread's log is not loaded yet: nothing to reveal until it is.
    expect(useCiteStore.getState().flash).toBeNull();
    act(() => {
      useThreadStore.setState((s) => ({ logs: { ...s.logs, "s-a": { seq: 1, byId: { "i-2": textItem("i-2", 4, "x") }, order: ["i-2"], pending: [], mcp: null, commands: [], agents: [] } } }));
    });
    await settle(10);
    expect(useCiteStore.getState().flash).toMatchObject({ threadId: "s-a", hold: true, cite: { itemId: "i-2", text: "the quote of hit 2", start: -1 } });
  });

  it("⌘⏎ continues the search as a thread and shows it; promoted already, its thread with no call", async () => {
    daemon.handlers.set("search.promote", () => ({ message: "", resultJson: JSON.stringify({ threadId: "s-new" }) }));
    await open();
    await startShown(done());
    key("Enter", { metaKey: true });
    await settle(20);
    expect(invocationsOf("search.promote").map((i) => i.args)).toEqual([{ id: "q-1" }]);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-new" });
    expect(useUiStore.getState().palette.open).toBe(false);

    act(() => {
      useUiStore.getState().select({ kind: "thread", id: "s-b" });
    });
    await open();
    await type("again");
    await startShown(done({ id: "q-2", query: "again", promotedThreadId: "s-new" }));
    expect(screen.getByTestId("search-hints").textContent).toContain("open its thread");
    key("Enter", { metaKey: true });
    await settle(20);
    expect(invocationsOf("search.promote")).toHaveLength(1);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-new" });
  });

  it("Enter with an edited question asks it as a new search; ⌘⌫ clears for a new one", async () => {
    await open();
    await startShown(done());
    await type("a different question");
    startAgentSearch.mockResolvedValueOnce(entry({ id: "q-2", query: "a different question" }));
    key("Enter");
    await settle(20);
    expect(startAgentSearch).toHaveBeenLastCalledWith("a different question");
    key("Backspace", { metaKey: true });
    await settle(10);
    expect(input().value).toBe("");
    expect(screen.queryByTestId("agent-results")).toBeNull();
  });
});

describe("Enter on a focused button", () => {
  it("presses the button: no start, no hit opened, and the field's Enter still works", async () => {
    await open();
    await startShown(done({ steps: [{ index: 0, kind: "search", done: true, failed: false, text: "Searched a · 1 hit", query: "a", threadName: "" }] }));
    const toggle = screen.getByTestId("agent-summary-toggle");
    const marker = screen.getAllByTestId("agent-answer-ref")[0] as HTMLElement;
    toggle.focus();
    // Not prevented: the browser presses the focused button.
    expect(fireEvent.keyDown(toggle, { key: "Enter" })).toBe(true);
    marker.focus();
    expect(fireEvent.keyDown(marker, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(marker, { key: "Enter", metaKey: true })).toBe(true);
    await settle(10);
    expect(startAgentSearch).toHaveBeenCalledTimes(1);
    expect(invocationsOf("search.promote")).toHaveLength(0);
    expect(useUiStore.getState().palette.open).toBe(true);

    // The empty state's Clear too.
    await type("");
    recent.push([done()]);
    await settle(20);
    const clear = screen.getByTestId("search-recent-clear");
    clear.focus();
    expect(fireEvent.keyDown(clear, { key: "Enter" })).toBe(true);
    await settle(10);
    expect(input().value).toBe("");
    expect(startAgentSearch).toHaveBeenCalledTimes(1);

    // The field's Enter is the dialog's.
    await type("a new question");
    startAgentSearch.mockResolvedValueOnce(entry({ id: "q-2", query: "a new question" }));
    expect(fireEvent.keyDown(input(), { key: "Enter" })).toBe(false);
    await settle(20);
    expect(startAgentSearch).toHaveBeenLastCalledWith("a new question");
  });
});

describe("restore and Recent searches", () => {
  /** StartAgent held until the test answers it. */
  function heldStart(): (e: SearchEntryView) => Promise<void> {
    let answer: (e: SearchEntryView) => void = () => undefined;
    startAgentSearch.mockReturnValueOnce(
      new Promise((r) => {
        answer = r;
      }),
    );
    return async (e) => {
      await act(async () => {
        answer(e);
        await Promise.resolve();
      });
      await settle(10);
    };
  }

  it("closed while its search was starting: a reopen shows that search, and Enter does not ask again", async () => {
    const answer = heldStart();
    await open();
    await type("where did we decide it?");
    key("Enter");
    await settle(10);
    await close();
    await answer(entry());
    expect(useSearchDialogStore.getState().session?.entryId).toBe("q-1");

    await open();
    expect(input().value).toBe("where did we decide it?");
    watchOf("q-1").push({ kind: "snapshot", version: 9, entry: done() });
    await settle(20);
    expect(hitRows()).toHaveLength(3);
    expect(answerSelected()).toBe(true);
    key("Enter"); // on to the first hit, not a second run
    await settle(10);
    expect(startAgentSearch).toHaveBeenCalledTimes(1);
    expect(selectedHit()).toBe("1");
    key("Enter");
    await settle(10);
    expect(useUiStore.getState().palette.open).toBe(false);
  });

  it("reopened before the start answered: it waits for that start rather than asking again", async () => {
    const answer = heldStart();
    await open();
    await type("where did we decide it?");
    key("Enter");
    await settle(10);
    await close();
    await open();
    expect(screen.getByTestId("agent-hint").textContent).toBe("Starting…");
    key("Enter");
    await settle(10);
    expect(startAgentSearch).toHaveBeenCalledTimes(1);
    await answer(entry());
    watchOf("q-1").push({ kind: "snapshot", version: 1, entry: entry() });
    await settle(20);
    expect(screen.getByTestId("agent-results").dataset.status).toBe("running");
    await close();
    expect(useSearchDialogStore.getState().session?.entryId).toBe("q-1");
    expect(useSearchDialogStore.getState().pending).toBeNull();
  });

  it("restored: finished searches it has not shown are cued above it (the newest, +N more); the cue shows one and marks it seen", async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    await open();
    await startShown(done());
    await close();
    now.mockReturnValue(t0 + 60_000);
    await open();
    recent.push([done({ id: "q-9", query: "what did we pin?", unseen: true, hits: [hit(1)] }), done({ id: "q-8", query: "the older one", unseen: true, status: "failed", hits: [] }), done()]);
    await settle(20);
    // The restored search stays.
    expect(input().value).toBe("where did we decide it?");
    let cue = screen.getByTestId("search-unseen-cue");
    expect(cue.dataset.id).toBe("q-9");
    expect(cue.textContent).toBe("Finished:what did we pin?· 1 result+1 more");
    expect(invocationsOf("search.seen")).toHaveLength(0);

    fireEvent.click(cue);
    await settle(10);
    expect(input().value).toBe("what did we pin?");
    watchOf("q-9").push({ kind: "snapshot", version: 9, entry: done({ id: "q-9", query: "what did we pin?", unseen: true, hits: [hit(1)] }) });
    await settle(20);
    expect(hitRows()).toHaveLength(1);
    expect(invocationsOf("search.seen").map((i) => i.args)).toEqual([{ id: "q-9" }]);
    // The next one is cued, alone.
    cue = screen.getByTestId("search-unseen-cue");
    expect(cue.dataset.id).toBe("q-8");
    expect(cue.textContent).toBe("Finished:the older one· failed");
    recent.push([done({ id: "q-9", query: "what did we pin?", hits: [hit(1)] }), done({ id: "q-8", query: "the older one", status: "failed", hits: [] }), done()]);
    await settle(20);
    expect(screen.queryByTestId("search-unseen-cue")).toBeNull();
  });


  it("reopened within 3 minutes: mode, query selected, results, and the next unopened hit after the one opened; after, empty with Recent", async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    await open();
    await startShown(done());
    key("ArrowDown");
    key("Enter"); // opens hit 1
    await settle(10);
    now.mockReturnValue(t0 + RESTORE_MS - 1000);
    await open();
    expect(dialog().dataset.mode).toBe("agent");
    expect(input().value).toBe("where did we decide it?");
    expect([input().selectionStart, input().selectionEnd]).toEqual([0, input().value.length]);
    watchOf("q-1").push({ kind: "snapshot", version: 10, entry: done({ version: 10, hits: [hit(1, { opened: true }), hit(2), hit(3)] }) });
    await settle(20);
    expect(selectedHit()).toBe("2");
    await close();

    now.mockReturnValue(t0 + 2 * RESTORE_MS + 5000);
    await open();
    expect(input().value).toBe("");
    expect(screen.queryByTestId("agent-results")).toBeNull();
    recent.push([done(), entry({ id: "q-f", mode: "find", query: "fingerprint", status: "done", findHits: 14, createdAtMs: t0 })]);
    await settle(20);
    expect(screen.getAllByTestId("search-recent-row").map((r) => r.dataset.id)).toEqual(["q-1", "q-f"]);
  });

  it("restored on the Answer row: the session says so and the reopen shows it", async () => {
    await open();
    await startShown(done());
    expect(answerSelected()).toBe(true);
    await close();
    expect(useSearchDialogStore.getState().session?.selectedN).toBe(ANSWER_ROW);
    await open();
    watchOf("q-1").push({ kind: "snapshot", version: 9, entry: done() });
    await settle(20);
    expect(answerSelected()).toBe(true);
    expect(screen.getByTestId("agent-answer-pane")).toBeTruthy();
  });

  it("a hit selected at close stays selected on the reopen, past later snapshots", async () => {
    await open();
    await startShown(done());
    key("ArrowDown");
    key("ArrowDown");
    await close();
    expect(useSearchDialogStore.getState().session?.selectedN).toBe(2);
    await open();
    watchOf("q-1").push({ kind: "snapshot", version: 9, entry: done() });
    await settle(20);
    expect(selectedHit()).toBe("2");
    watchOf("q-1").push({ kind: "snapshot", version: 10, entry: done({ version: 10, unseen: false }) });
    await settle(20);
    expect(selectedHit()).toBe("2");
  });

  it("closed while it ran on the first hit, reopened after it ended: the Answer row", async () => {
    await open();
    await startShown();
    watchOf("q-1").push({ kind: "hit", version: 2, hit: hit(1) });
    await settle(20);
    expect(selectedHit()).toBe("1");
    await close();
    expect(useSearchDialogStore.getState().session?.selectedN).toBeNull();
    await open();
    watchOf("q-1").push({ kind: "snapshot", version: 9, entry: done() });
    await settle(20);
    expect(answerSelected()).toBe(true);
  });

  it("an unseen finished search restores whatever the timer, then is marked seen", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * RESTORE_MS);
    await open();
    recent.push([entry({ id: "q-f", mode: "find", query: "fingerprint", status: "done" }), done({ id: "q-9", query: "what did we pin?", unseen: true })]);
    await settle(20);
    expect(input().value).toBe("what did we pin?");
    expect(dialog().dataset.mode).toBe("agent");
    watchOf("q-9").push({ kind: "snapshot", version: 9, entry: done({ id: "q-9", query: "what did we pin?", unseen: true }) });
    await settle(20);
    expect(hitRows()).toHaveLength(3);
    expect(answerSelected()).toBe(true);
    expect(invocationsOf("search.seen").map((i) => i.args)).toEqual([{ id: "q-9" }]);
  });

  it("Recent rows: agent entries with results and saved results in the preview, Find entries with hits; × forgets, Clear confirms", async () => {
    const t = Date.now();
    await open();
    recent.push([done({ createdAtMs: t - 3_600_000 }), entry({ id: "q-f", mode: "find", query: "fingerprint", status: "done", findHits: 14, createdAtMs: t - 2 * 3_600_000 })]);
    await settle(20);
    const rows = screen.getAllByTestId("search-recent-row");
    expect(rows.map((r) => [r.dataset.mode, within(r).getByTestId("search-recent-meta").textContent])).toEqual([
      ["agent", "3 results · 1h"],
      ["find", "14 hits · 2h"],
    ]);
    // The first row is selected; its saved results show, not run again.
    const preview = screen.getByTestId("search-recent-preview");
    expect(preview.textContent).toContain("Saved results · not re-run");
    expect(within(preview).getAllByTestId("agent-hit")).toHaveLength(3);
    expect(screen.getByTestId("search-hints").textContent).toContain("open saved results");
    key("ArrowDown");
    expect(screen.getByTestId("search-recent-preview").dataset.mode).toBe("find");

    fireEvent.click(within(rows[1] as HTMLElement).getByTestId("search-recent-forget"));
    await settle(10);
    expect(invocationsOf("search.forget").map((i) => i.args)).toEqual([{ id: "q-f" }]);

    confirmFirst("search.clear", "Clear the search history? Every agent search's transcript is deleted too.");
    fireEvent.click(screen.getByTestId("search-recent-clear"));
    await settle(10);
    expect(useConfirmStore.getState().pending?.message).toContain("Clear the search history?");
    act(() => {
      answerConfirm(true);
    });
    await settle(10);
    expect(invocationsOf("search.clear").map((i) => i.confirmed)).toEqual([false, true]);
  });

  it("Enter on an agent row shows its saved results; on a Find row, Find runs it again", async () => {
    await open();
    recent.push([entry({ id: "q-f", mode: "find", query: "fingerprint", status: "done", findHits: 14 }), done()]);
    await settle(20);
    key("Enter");
    await settle(10);
    expect(dialog().dataset.mode).toBe("find");
    expect(input().value).toBe("fingerprint");
    await wait(SEARCH_DEBOUNCE_MS + 20);
    expect(search).toHaveBeenCalledWith("fingerprint");

    await type("");
    recent.push([entry({ id: "q-f", mode: "find", query: "fingerprint", status: "done", findHits: 14 }), done()]);
    await settle(20);
    key("ArrowDown");
    key("Enter");
    await settle(10);
    expect(dialog().dataset.mode).toBe("agent");
    expect(input().value).toBe("where did we decide it?");
    watchOf("q-1").push({ kind: "snapshot", version: 9, entry: done() });
    await settle(20);
    expect(hitRows()).toHaveLength(3);
    expect(startAgentSearch).not.toHaveBeenCalled();
  });
});

describe("Find mode additions", () => {
  it("no results offers Try Agent search: it switches mode with the query and starts the search (Enter too)", async () => {
    useSearchDialogStore.setState({ mode: "find" });
    await open();
    await type("why did we pin typescript?");
    await wait(SEARCH_DEBOUNCE_MS + 20);
    expect(screen.getByTestId("search-try-agent").textContent).toContain("Try Agent search: “why did we pin typescript?”");
    startAgentSearch.mockResolvedValueOnce(entry({ query: "why did we pin typescript?" }));
    fireEvent.click(screen.getByTestId("search-try-agent"));
    await settle(20);
    expect(dialog().dataset.mode).toBe("agent");
    expect(input().value).toBe("why did we pin typescript?");
    expect(startAgentSearch).toHaveBeenCalledWith("why did we pin typescript?");

    await close();
    useSearchDialogStore.setState({ mode: "find", session: null });
    await open();
    await type("nothing here");
    await wait(SEARCH_DEBOUNCE_MS + 20);
    startAgentSearch.mockResolvedValueOnce(entry({ id: "q-2", query: "nothing here" }));
    key("Enter");
    await settle(20);
    expect(startAgentSearch).toHaveBeenLastCalledWith("nothing here");
  });

  it("opening a Find result records the query with its result count", async () => {
    useSearchDialogStore.setState({ mode: "find" });
    search.mockImplementation((q) =>
      Promise.resolve({
        query: q,
        threads: [{ threadId: "s-a", name: "Poll checks by fingerprint", ranges: [], archived: false, lastActivityMs: null }],
        groups: [],
        caseSensitive: false,
        namesOnly: false,
        totalHits: 13,
        totalThreads: 0,
        truncated: false,
      }),
    );
    await open();
    await type("fingerprint");
    await wait(SEARCH_DEBOUNCE_MS + 20);
    key("Enter");
    await settle(10);
    expect(invocationsOf("search.find").map((i) => i.args)).toEqual([{ query: "fingerprint", hits: "14" }]);
  });
});
