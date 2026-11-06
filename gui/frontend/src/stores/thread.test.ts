import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpStatusView } from "@/api/mcp";
import type { SlashCommandView } from "@/api/slashCommands";
import type { ThreadEventView, ThreadItemView, ThreadPendingView } from "@/api/thread";
import {
  applyPendingEvent,
  applyThreadEvent,
  applyThreadEvents,
  applyWatchBatch,
  closePageModal,
  deferTurnFolds,
  flashPage,
  openPageModal,
  PAGE_FLASH_MS,
  prunePageModals,
  setPageModalSource,
  foldDeferredTurns,
  forgetTurnView,
  KEPT_LOG_BUDGET,
  logsOverBudget,
  openThreadWatches,
  sameItem,
  setRowExpanded,
  setTurnFolded,
  startThreadWatch,
  useThreadPending,
  useThreadStore,
  WATCH_BATCH_MS,
  watchTurnEnds,
  type ThreadLog,
} from "./thread";

const watched = vi.hoisted(() => ({ events: [] as unknown[], attempts: [] as unknown[][], opened: 0 }));
vi.mock("@/api/thread", async (orig) => ({
  ...(await orig<typeof import("@/api/thread")>()),
  watchThread: async function* (_id: string, signal: AbortSignal) {
    watched.opened++;
    for (const ev of watched.attempts.shift() ?? watched.events) {
      if (ev === "socket died") throw new TypeError("a WebSocket stream closed with 1006");
      yield ev as ThreadEventView;
    }
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => {
        resolve();
      });
    });
  },
}));

function text(id: string, ordinal: number, t = "", over: Partial<ThreadItemView> = {}): ThreadItemView {
  return { id, ordinal, parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: false, kind: "text", text: t, ...over } as ThreadItemView;
}
function tool(id: string, ordinal: number, input = ""): ThreadItemView {
  return { id, ordinal, parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: true, kind: "tool", toolUseId: id, name: "Bash", inputJson: input, status: "running", output: "", isError: false, resultJson: "" };
}
const pend = (requestId: string): ThreadPendingView => ({ requestId, itemId: `perm-${requestId}`, question: false, toolName: "Bash", summary: "Bash ls" });
const snapshot = (seq: number, items: ThreadItemView[], pending: ThreadPendingView[] = []): ThreadEventView => ({ kind: "snapshot", threadId: "s", seq, items, pending, mcp: null, commands: [], agents: [] });

function apply(log: ThreadLog | undefined, ...evs: ThreadEventView[]): ThreadLog | undefined {
  return evs.reduce(applyThreadEvent, log);
}

describe("applyThreadEvents (a batch)", () => {
  const d = (seq: number, itemId: string, t: string): ThreadEventView => ({ kind: "delta", threadId: "s", seq, itemId, ordinal: 1, field: "text", text: t });

  it("matches one-by-one application, a resync snapshot mid-batch included, without touching its input", () => {
    const start = apply(undefined, snapshot(1, [text("a", 1, "x"), text("b", 2, "y")]));
    const frozen = JSON.stringify(start);
    const events: ThreadEventView[] = [
      d(2, "a", "1"),
      d(3, "a", "2"),
      { kind: "appended", threadId: "s", seq: 4, item: text("c", 3) },
      d(5, "c", "z"),
      // The daemon restarted: a new snapshot with a lower seq, then events above it; the
      // stale delta is dropped and nothing is duplicated.
      snapshot(2, [text("a", 1, "x12"), text("b", 2, "y"), text("c", 3, "z")]),
      d(2, "c", "stale"),
      d(3, "c", "!"),
      d(4, "b", "?"),
    ];
    const batched = applyThreadEvents(start, events);
    expect(batched).toEqual(apply(start, ...events));
    expect(batched?.order).toEqual(["a", "b", "c"]);
    expect(batched?.byId.c).toMatchObject({ text: "z!" });
    expect(JSON.stringify(start)).toBe(frozen);
  });

  it("deltas copy the item map once and keep other items by identity", () => {
    const start = apply(undefined, snapshot(1, [text("a", 1), text("b", 2)]));
    const next = applyThreadEvents(start, [d(2, "a", "h"), d(3, "a", "i")]);
    expect(next?.byId.a).toMatchObject({ text: "hi" });
    expect(next?.byId.b).toBe(start?.byId.b);
    expect(start?.byId.a).toMatchObject({ text: "" });
    expect(next?.seq).toBe(3);
  });
});

describe("applyThreadEvent", () => {
  it("drops everything before the first snapshot", () => {
    expect(apply(undefined, { kind: "appended", threadId: "s", seq: 5, item: text("a", 1) })).toBeUndefined();
  });

  it("applies events above the snapshot's seq and drops the rest (snapshot+seq dedupe)", () => {
    const log = apply(
      undefined,
      snapshot(10, [text("a", 1, "hi")]),
      { kind: "appended", threadId: "s", seq: 9, item: text("old", 2) },
      { kind: "delta", threadId: "s", seq: 10, itemId: "a", ordinal: 1, field: "text", text: " again" },
      { kind: "delta", threadId: "s", seq: 11, itemId: "a", ordinal: 1, field: "text", text: " there" },
      { kind: "appended", threadId: "s", seq: 12, item: text("b", 3) },
      { kind: "delta", threadId: "s", seq: 12, itemId: "b", ordinal: 3, field: "text", text: "dup" },
    );
    expect(log?.seq).toBe(12);
    expect(log?.order).toEqual(["a", "b"]);
    expect(log?.byId.a).toMatchObject({ text: "hi there" });
    expect(log?.byId.b).toMatchObject({ text: "" });
  });

  it("appends input deltas to a tool call and ignores a field that does not apply", () => {
    const log = apply(
      undefined,
      snapshot(1, [tool("t", 1, '{"comm')]),
      { kind: "delta", threadId: "s", seq: 2, itemId: "t", ordinal: 1, field: "input", text: 'and":"ls"}' },
      { kind: "delta", threadId: "s", seq: 3, itemId: "t", ordinal: 1, field: "text", text: "nope" },
      { kind: "delta", threadId: "s", seq: 4, itemId: "missing", ordinal: 9, field: "text", text: "x" },
    );
    expect(log?.byId.t).toMatchObject({ inputJson: '{"command":"ls"}' });
    expect(log?.seq).toBe(4);
  });

  it("orders by ordinal, replaces by id, and keeps unchanged items and the order by identity", () => {
    const a = text("a", 5, "x");
    let log = apply(undefined, snapshot(1, [a, text("b", 2)]));
    expect(log?.order).toEqual(["b", "a"]);
    const order = log?.order;
    log = apply(log, { kind: "updated", threadId: "s", seq: 2, item: { ...a } });
    expect(log?.byId.a).toBe(a);
    expect(log?.order).toBe(order);
    log = apply(log, { kind: "updated", threadId: "s", seq: 3, item: text("a", 5, "y") });
    expect(log?.byId.a).toMatchObject({ text: "y" });
    expect(log?.order).toBe(order);
  });

  it("a second snapshot resyncs: replaces the log, keeping equal items by identity", () => {
    const a = text("a", 1, "x");
    let log = apply(undefined, snapshot(3, [a, text("b", 2)], [pend("r1")]));
    const pending = log?.pending;
    log = apply(log, snapshot(7, [text("a", 1, "x"), text("c", 3)], [pend("r1")]));
    expect(log?.seq).toBe(7);
    expect(log?.order).toEqual(["a", "c"]);
    expect(log?.byId.a).toBe(a);
    expect(log?.pending).toBe(pending);
    // Even one with a lower seq (a restarted daemon starts over).
    expect(apply(log, snapshot(1, []))?.order).toEqual([]);
  });

  it("replaces pending requests from pending events", () => {
    let log = apply(undefined, snapshot(1, []));
    log = apply(log, { kind: "pending", threadId: "s", seq: 2, pending: [pend("r1")] });
    expect(log?.pending.map((p) => p.requestId)).toEqual(["r1"]);
    log = apply(log, { kind: "pending", threadId: "s", seq: 2, pending: [] });
    expect(log?.pending).toHaveLength(1);
    log = apply(log, { kind: "pending", threadId: "s", seq: 3, pending: [] });
    expect(log?.pending).toEqual([]);
  });
});

describe("the MCP status on the log", () => {
  const status = (checkedAtMs: number, st: "connected" | "failed" = "connected"): McpStatusView => ({
    checkedAtMs,
    trigger: "turn",
    server: "",
    servers: [
      { name: "a", status: "connected", serverName: "", version: "1", error: "", scope: "user", source: "user", transport: "stdio", tools: [] },
      { name: "b", status: st, serverName: "", version: "", error: st === "failed" ? "boom" : "", scope: "user", source: "user", transport: "http", tools: [] },
    ],
  });
  const mcp = (seq: number, s: McpStatusView | null): ThreadEventView => ({ kind: "mcp", threadId: "s", seq, status: s });

  it("comes with the snapshot, follows mcp events by seq, keeps unchanged servers, and drops to null", () => {
    const start = apply(undefined, { ...snapshot(1, [text("a", 1)]), mcp: status(10, "failed") } as ThreadEventView);
    expect(start?.mcp?.servers.map((s) => s.status)).toEqual(["connected", "failed"]);
    const items = start?.byId;

    const next = apply(start, mcp(2, status(20)));
    expect(next?.seq).toBe(2);
    expect(next?.byId).toBe(items);
    expect(next?.mcp?.checkedAtMs).toBe(20);
    expect(next?.mcp?.servers[0]).toBe(start?.mcp?.servers[0]);
    expect(next?.mcp?.servers[1]?.status).toBe("connected");

    // An event the log has (seq) is dropped.
    expect(apply(next, mcp(2, null))).toBe(next);
    // The process ended.
    expect(apply(next, mcp(3, null))?.mcp).toBeNull();
    // A resync snapshot without one clears it.
    expect(apply(next, snapshot(5, [text("a", 1)]))?.mcp).toBeNull();
  });
});

describe("slash commands", () => {
  const cmd = (name: string, builtin = true): SlashCommandView => ({ name, description: `${name} it`, argumentHint: "", aliases: [], builtin });
  const commands = (seq: number, list: SlashCommandView[]): ThreadEventView => ({ kind: "commands", threadId: "s", seq, commands: list });

  it("come with the snapshot, follow commands events above its seq, keep an unchanged list, and drop to empty", () => {
    const start = apply(undefined, { ...snapshot(3, [text("a", 1)]), commands: [cmd("compact"), cmd("deploy", false)] } as ThreadEventView);
    expect(start?.commands.map((c) => c.name)).toEqual(["compact", "deploy"]);
    const items = start?.byId;

    // An event the snapshot already includes is dropped.
    expect(apply(start, commands(3, []))).toBe(start);
    expect(apply(start, commands(2, [cmd("x")]))).toBe(start);

    const next = apply(start, commands(4, [cmd("deploy", false), cmd("compact"), cmd("usage")]));
    expect(next?.seq).toBe(4);
    expect(next?.byId).toBe(items);
    expect(next?.commands.map((c) => c.name)).toEqual(["deploy", "compact", "usage"]);

    // The same list again (an effort restart's) keeps its identity.
    const same = apply(next, commands(5, [cmd("deploy", false), cmd("compact"), cmd("usage")]));
    expect(same?.commands).toBe(next?.commands);
    // So does a resync snapshot with it.
    expect(apply(same, { ...snapshot(6, [text("a", 1)]), commands: [cmd("deploy", false), cmd("compact"), cmd("usage")] } as ThreadEventView)?.commands).toBe(next?.commands);

    // The process ended.
    expect(apply(next, commands(6, []))?.commands).toEqual([]);
    // A snapshot without any (not running, or an older daemon) clears them.
    expect(apply(next, snapshot(7, [text("a", 1)]))?.commands).toEqual([]);
  });

  it("are batched like any other event", () => {
    const start = apply(undefined, snapshot(1, []));
    const out = applyThreadEvents(start, [commands(2, [cmd("compact")]), { kind: "delta", threadId: "s", seq: 3, itemId: "x", ordinal: 1, field: "text", text: "y" }]);
    expect(out?.seq).toBe(3);
    expect(out?.commands.map((c) => c.name)).toEqual(["compact"]);
  });
});

describe("sameItem", () => {
  it("compares arrays and the request (answers included) by value", () => {
    const req = { requestId: "r", toolName: "AskUserQuestion", displayName: "", title: "", description: "", toolUseId: "t", agentId: "", blockedPath: "", decisionReason: "", inputJson: "{}", suggestionsJson: "", state: "allowed" as const, decision: "allow", message: "", answers: { Q: "A" } };
    const q = (answers: Record<string, string>): ThreadItemView => ({ id: "q", ordinal: 1, parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: false, kind: "question", request: { ...req, answers } });
    expect(sameItem(q({ Q: "A" }), q({ Q: "A" }))).toBe(true);
    expect(sameItem(q({ Q: "A" }), q({ Q: "B" }))).toBe(false);
    const u = (atts: string[]): ThreadItemView => ({ id: "u", ordinal: 1, parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: false, kind: "user", text: "hi", attachments: atts, composerText: "" });
    expect(sameItem(u(["/a.png"]), u(["/a.png"]))).toBe(true);
    expect(sameItem(u(["/a.png"]), u([]))).toBe(false);
  });
});

describe("applyPendingEvent (EventService thread source)", () => {
  it("replaces on the snapshot, follows pending events by seq, and ignores item events", () => {
    let p = applyPendingEvent({}, { kind: "pendingSnapshot", threads: [{ threadId: "a", seq: 4, pending: [pend("r1")] }] });
    expect(Object.keys(p)).toEqual(["a"]);
    const same = applyPendingEvent(p, { kind: "pendingSnapshot", threads: [{ threadId: "a", seq: 4, pending: [pend("r1")] }] });
    expect(same).toBe(p);
    p = applyPendingEvent(p, { kind: "pending", threadId: "b", seq: 1, pending: [pend("r2")] });
    expect(Object.keys(p).sort()).toEqual(["a", "b"]);
    expect(applyPendingEvent(p, { kind: "pending", threadId: "a", seq: 3, pending: [] })).toBe(p);
    p = applyPendingEvent(p, { kind: "pending", threadId: "a", seq: 5, pending: [] });
    expect(Object.keys(p)).toEqual(["b"]);
    expect(applyPendingEvent(p, { kind: "appended", threadId: "b", seq: 9, item: text("x", 1) })).toBe(p);
  });
});

describe("startThreadWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useThreadStore.setState({ logs: {}, pending: {}, watches: {}, folds: {}, expanded: {} });
    watched.opened = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies the stream's events in one batch per frame and reports its status", async () => {
    watched.events = [
      snapshot(1, [text("a", 1, "he")]),
      { kind: "delta", threadId: "s", seq: 2, itemId: "a", ordinal: 1, field: "text", text: "l" },
      { kind: "delta", threadId: "s", seq: 3, itemId: "a", ordinal: 1, field: "text", text: "lo" },
    ];
    const updates = vi.fn();
    const unsub = useThreadStore.subscribe((s, prev) => {
      if (s.logs !== prev.logs) updates();
    });
    const stop = startThreadWatch("s");
    await vi.advanceTimersByTimeAsync(0);
    expect(useThreadStore.getState().watches.s).toMatchObject({ status: "open" });
    expect(useThreadStore.getState().logs.s).toBeUndefined();
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_MS);
    expect(useThreadStore.getState().logs.s?.byId.a).toMatchObject({ text: "hello" });
    expect(updates).toHaveBeenCalledTimes(1);
    stop();
    unsub();
    expect(useThreadStore.getState().watches.s).toBeUndefined();
    expect(watched.opened).toBe(1);
  });

  describe("across reconnects", () => {
    const delta = (seq: number, itemId: string, t: string): ThreadEventView => ({ kind: "delta", threadId: "s", seq, itemId, ordinal: 1, field: "text", text: t });
    const appended = (seq: number, item: ThreadItemView): ThreadEventView => ({ kind: "appended", threadId: "s", seq, item });
    const log = () => {
      const l = useThreadStore.getState().logs.s;
      return l?.order.map((id) => (l.byId[id] as { text: string }).text);
    };
    const settled = () => vi.advanceTimersByTimeAsync(2000);

    it("keeps the log the daemon has when a socket dies with events still in the batch", async () => {
      watched.attempts = [
        [snapshot(2, [text("a", 1, "he")]), delta(3, "a", "l"), "socket died"],
        // Taken after a delta the old socket never delivered, and after one it did.
        [snapshot(4, [text("a", 1, "hell")]), delta(5, "a", "o"), appended(6, text("b", 2, "next")), "socket died"],
        // The same seqs again, as a snapshot with what came before them, then what is new.
        [snapshot(5, [text("a", 1, "hello")]), delta(5, "a", "o"), appended(6, text("b", 2, "next")), delta(7, "b", "!")],
      ];
      const stop = startThreadWatch("s");
      await settled();
      await settled();
      expect(watched.opened).toBe(3);
      expect(log()).toEqual(["hello", "next!"]);
      stop();
    });

    it("loses nothing from a batch still waiting when the new snapshot arrives behind it", async () => {
      watched.attempts = [
        [snapshot(1, [text("a", 1, "x")]), delta(2, "a", "y"), "socket died"],
        [snapshot(2, [text("a", 1, "xy")]), appended(3, text("b", 2, "z"))],
      ];
      const stop = startThreadWatch("s");
      await vi.advanceTimersByTimeAsync(WATCH_BATCH_MS - 1); // the first batch is not out yet
      await settled();
      expect(log()).toEqual(["xy", "z"]);
      stop();
    });

    it("orders by ordinal whatever order the items arrive in", async () => {
      watched.attempts = [
        [snapshot(1, [text("c", 3, "third")]), "socket died"],
        [snapshot(3, [text("a", 1, "first"), text("c", 3, "third")]), appended(4, text("b", 2, "second"))],
      ];
      const stop = startThreadWatch("s");
      await settled();
      expect(log()).toEqual(["first", "second", "third"]);
      stop();
    });

    it("starts over from the snapshot of a daemon that restarted, whose seq is lower", async () => {
      watched.attempts = [
        [snapshot(90, [text("a", 1, "old")]), "socket died"],
        [snapshot(3, [text("a", 1, "kept")]), delta(4, "a", "!")],
      ];
      const stop = startThreadWatch("s");
      await settled();
      expect(log()).toEqual(["kept!"]);
      stop();
    });
  });

  it("marks a thread synced once its Watch's snapshot arrives, even one equal to the kept log, and unmarks it when the Watch ends", async () => {
    const kept: ThreadLog = { seq: 1, byId: { a: text("a", 1, "hi") }, order: ["a"], pending: [], mcp: null, commands: [], agents: [] };
    useThreadStore.setState({ logs: { s: kept }, synced: {} });
    watched.events = [snapshot(1, [text("a", 1, "hi")])];
    const stop = startThreadWatch("s");
    await vi.advanceTimersByTimeAsync(0);
    expect(useThreadStore.getState().synced.s).toBeUndefined();
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_MS);
    expect(useThreadStore.getState().synced.s).toBe(true);
    stop();
    expect(useThreadStore.getState().synced.s).toBeUndefined();
    // The log stays kept for a later visit, which is behind until its own snapshot.
    expect(useThreadStore.getState().logs.s).toBeDefined();
  });

  it("opens one Watch per thread on screen: a second view of it shares it, another thread gets its own", async () => {
    watched.events = [];
    const main = startThreadWatch("s");
    const inline = startThreadWatch("s");
    const other = startThreadWatch("p");
    await vi.advanceTimersByTimeAsync(0);
    expect(watched.opened).toBe(2);
    expect(openThreadWatches()).toBe(2);
    expect(Object.keys(useThreadStore.getState().watches).sort()).toEqual(["p", "s"]);
    // The main pane leaves the thread: the plugin's view of it keeps the stream.
    main();
    main(); // a second release is harmless
    await vi.advanceTimersByTimeAsync(0);
    expect(useThreadStore.getState().watches.s).toBeDefined();
    expect(watched.opened).toBe(2);
    inline();
    other();
    expect(openThreadWatches()).toBe(0);
    expect(useThreadStore.getState().watches).toEqual({});
  });

  it("keeps logs up to the budget, dropping the oldest, and sizes a thread that grew when it is left", async () => {
    const big = "x".repeat(Math.ceil(KEPT_LOG_BUDGET * 0.4));
    const visit = async (id: string, body: string) => {
      watched.events = [{ ...snapshot(1, [text("a", 1, body)]), threadId: id }];
      const stop = startThreadWatch(id);
      await vi.advanceTimersByTimeAsync(WATCH_BATCH_MS);
      stop();
    };
    const kept = () => Object.keys(useThreadStore.getState().logs).sort();
    await visit("a", big);
    await visit("b", big);
    expect(kept()).toEqual(["a", "b"]);
    await visit("c", big);
    expect(kept()).toEqual(["b", "c"]);
    // Many small logs fit where few large ones did: the budget is size, not a count.
    for (const id of ["d", "e", "f", "g", "h", "i"]) await visit(id, "small");
    expect(kept()).toEqual(["b", "c", "d", "e", "f", "g", "h", "i"]);
    // Visiting an old one again makes it the most recent.
    await visit("b", big);
    await visit("j", big);
    expect(kept()).toEqual(["b", "d", "e", "f", "g", "h", "i", "j"]);
  });
});

describe("logsOverBudget", () => {
  const sizes: Readonly<Record<string, number>> = { a: 40, b: 40, c: 40, huge: 500 };
  const size = (id: string) => sizes[id] ?? 0;
  it.each<[string, string[], string[], string[]]>([
    ["all fit", ["a", "b"], [], []],
    ["the oldest past the budget go", ["a", "b", "c"], [], ["c"]],
    ["everything older than the point it ran out goes", ["huge", "a", "b"], [], ["a", "b"]],
    ["the most recent closed one stays however large", ["huge"], [], []],
    ["an open log counts, but never goes", ["huge", "a"], ["huge"], []],
    ["after an open log, the most recent closed one is still the one kept", ["huge", "a", "b"], ["huge"], ["b"]],
    ["an open log past the budget is not dropped", ["a", "huge"], ["huge"], []],
  ])("%s", (_name, recent, open, want) => {
    expect(logsOverBudget(recent, size, (id) => open.includes(id), 100)).toEqual(want);
  });
});

describe("pending requests while a kept log catches up", () => {
  const read = () => renderHook(() => useThreadPending("s")).result.current.map((p) => p.requestId);
  const kept = apply(undefined, snapshot(1, [text("a", 1)], [pend("old")])) as ThreadLog;
  beforeEach(() => {
    useThreadStore.setState({ logs: { s: kept }, pending: {}, synced: {} });
  });

  it("reads the EventService's until the Watch syncs, then the Watch's", () => {
    useThreadStore.setState({ pending: { s: { threadId: "s", seq: 9, pending: [pend("live")] } } });
    expect(read()).toEqual(["live"]);
    useThreadStore.setState({ synced: { s: true } });
    expect(read()).toEqual(["old"]);
  });

  it("shows no request the kept log still has once the EventService has none", () => {
    expect(read()).toEqual([]);
  });
});

describe("turns left open while scrolled up (deferTurnFolds, watchTurnEnds)", () => {
  const end = (id: string, ordinal: number) => text(id, ordinal, "", { kind: "turnEnd" });
  const put = (threadId: string, ...evs: ThreadEventView[]) => {
    applyWatchBatch(threadId, evs);
  };
  beforeEach(() => {
    useThreadStore.setState({ logs: {}, pending: {}, watches: {}, folds: {}, expanded: {}, deferred: {} });
  });

  it("reports a turn_end once, when it arrives, inside the store update that brings it", () => {
    put("s", snapshot(1, [text("u", 1), end("e0", 2)]));
    const got: string[][] = [];
    const stop = watchTurnEnds("s", (ids) => {
      // The log already has it: a deferral lands with it, before React renders the rows.
      expect(useThreadStore.getState().logs.s?.byId[ids[0] ?? ""]).toBeDefined();
      got.push(ids);
    });
    // Text deltas and other items report nothing; the end already there is not new.
    put("s", { kind: "appended", threadId: "s", seq: 2, item: text("a", 3) });
    put("s", { kind: "delta", threadId: "s", seq: 3, itemId: "a", ordinal: 3, field: "text", text: "hi" });
    expect(got).toEqual([]);
    put("s", { kind: "appended", threadId: "s", seq: 4, item: end("e1", 4) });
    expect(got).toEqual([["e1"]]);
    // A resync snapshot with the same ends reports nothing new; another thread's never.
    put("s", snapshot(5, [text("u", 1), end("e0", 2), text("a", 3, "hi"), end("e1", 4)]));
    put("t", snapshot(1, [end("x", 1)]));
    expect(got).toEqual([["e1"]]);
    stop();
    put("s", { kind: "appended", threadId: "s", seq: 6, item: end("e2", 5) });
    expect(got).toEqual([["e1"]]);
  });

  it("the first snapshot of a thread opening is not a turn ending", () => {
    const got: string[][] = [];
    const stop = watchTurnEnds("s", (ids) => got.push(ids));
    put("s", snapshot(1, [text("u", 1), end("e0", 2)]));
    expect(got).toEqual([]);
    put("s", { kind: "appended", threadId: "s", seq: 2, item: end("e1", 3) });
    expect(got).toEqual([["e1"]]);
    stop();
  });

  it("deferred turns fold on re-pin; leaving the thread forgets its folds, expanded rows and deferrals", () => {
    deferTurnFolds("s", ["e1"]);
    deferTurnFolds("s", ["e2"]);
    deferTurnFolds("t", ["x"]);
    setTurnFolded("s", "u1", false);
    setRowExpanded("s", "tool-1", true);
    setTurnFolded("t", "v1", false);
    expect(useThreadStore.getState().deferred).toEqual({ s: { e1: true, e2: true }, t: { x: true } });
    foldDeferredTurns("s");
    expect(useThreadStore.getState().deferred).toEqual({ t: { x: true } });
    // Nothing deferred: no store update at all (it runs on every scroll event at the bottom).
    const before = useThreadStore.getState();
    foldDeferredTurns("s");
    expect(useThreadStore.getState()).toBe(before);
    forgetTurnView("s");
    const s = useThreadStore.getState();
    expect(s.folds).toEqual({ t: { v1: false } });
    expect(s.expanded).toEqual({});
    expect(s.deferred).toEqual({ t: { x: true } });
    forgetTurnView("s");
    expect(useThreadStore.getState()).toBe(s);
  });
});

describe("page modals (inline-page-shows)", () => {
  beforeEach(() => {
    useThreadStore.setState({ logs: {}, folds: {}, expanded: {}, deferred: {}, pageModals: {}, pageFlash: {} });
  });

  it("are kept per scope, survive leaving the thread, and close on Close, a removed or archived thread", () => {
    openPageModal("s", "s", "h1");
    openPageModal("t", "t", "h9", true);
    openPageModal("s/run", "s", "h2");
    setRowExpanded("s", "html:h1", false);
    expect(useThreadStore.getState().pageModals).toEqual({ s: { thread: "s", id: "h1", source: false }, t: { thread: "t", id: "h9", source: true }, "s/run": { thread: "s", id: "h2", source: false } });
    // Leaving the thread forgets its row state, not its modal.
    forgetTurnView("s");
    expect(useThreadStore.getState().expanded).toEqual({});
    expect(useThreadStore.getState().pageModals.s).toEqual({ thread: "s", id: "h1", source: false });
    // The source toggle; a no-op when it is already so, or when nothing is open.
    setPageModalSource("s", true);
    expect(useThreadStore.getState().pageModals.s?.source).toBe(true);
    const before = useThreadStore.getState();
    setPageModalSource("s", true);
    setPageModalSource("nope", true);
    closePageModal("nope");
    expect(useThreadStore.getState()).toBe(before);
    // Another page replaces the open one.
    openPageModal("s", "s", "h3");
    expect(useThreadStore.getState().pageModals.s).toEqual({ thread: "s", id: "h3", source: false });
    closePageModal("t");
    expect(Object.keys(useThreadStore.getState().pageModals)).toEqual(["s", "s/run"]);
    // The thread goes (or is archived): every scope of it closes, with its flash.
    flashPage("s", "h3", 5);
    flashPage("u", "x", 5);
    prunePageModals((id) => id !== "s");
    expect(useThreadStore.getState().pageModals).toEqual({});
    expect(useThreadStore.getState().pageFlash).toEqual({ u: { id: "x", at: 5 } });
    const same = useThreadStore.getState();
    prunePageModals(() => true);
    expect(useThreadStore.getState()).toBe(same);
  });

  it("flashPage marks the card a link row pointed at, one per thread", () => {
    flashPage("s", "a", 100);
    flashPage("s", "b", 200);
    expect(useThreadStore.getState().pageFlash).toEqual({ s: { id: "b", at: 200 } });
    expect(PAGE_FLASH_MS).toBe(1000);
  });
});
