import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpStatusView } from "@/api/mcp";
import type { SlashCommandView } from "@/api/slashCommands";
import type { ThreadEventView, ThreadItemView, ThreadPendingView } from "@/api/thread";
import { applyPendingEvent, applyThreadEvent, applyThreadEvents, KEPT_LOGS, sameItem, startThreadWatch, useThreadStore, WATCH_BATCH_MS, type ThreadLog } from "./thread";

const watched = vi.hoisted(() => ({ events: [] as unknown[], opened: 0 }));
vi.mock("@/api/thread", async (orig) => ({
  ...(await orig<typeof import("@/api/thread")>()),
  watchThread: async function* (_id: string, signal: AbortSignal) {
    watched.opened++;
    for (const ev of watched.events) yield ev as ThreadEventView;
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
    useThreadStore.setState({ logs: {}, pending: {}, watch: null, folds: {}, expanded: {} });
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
    expect(useThreadStore.getState().watch).toMatchObject({ threadId: "s", status: "open" });
    expect(useThreadStore.getState().logs.s).toBeUndefined();
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_MS);
    expect(useThreadStore.getState().logs.s?.byId.a).toMatchObject({ text: "hello" });
    expect(updates).toHaveBeenCalledTimes(1);
    stop();
    unsub();
    expect(useThreadStore.getState().watch).toBeNull();
    expect(watched.opened).toBe(1);
  });

  it("keeps the logs of the last KEPT_LOGS watched threads only", async () => {
    const ids = Array.from({ length: KEPT_LOGS + 2 }, (_, i) => `t${String(i)}`);
    for (const id of ids) {
      watched.events = [{ ...snapshot(1, [text("a", 1)]), threadId: id }];
      const stop = startThreadWatch(id);
      await vi.advanceTimersByTimeAsync(WATCH_BATCH_MS);
      stop();
    }
    expect(Object.keys(useThreadStore.getState().logs).sort()).toEqual(ids.slice(-KEPT_LOGS).sort());
    // Watching an old one again moves it to the front.
    const stop = startThreadWatch(ids[ids.length - KEPT_LOGS] ?? "");
    stop();
    watched.events = [];
    startThreadWatch("new")();
    expect(Object.keys(useThreadStore.getState().logs)).toContain(ids[ids.length - KEPT_LOGS]);
  });
});
