import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadEventView, ThreadItemView, ThreadPendingView } from "@/api/thread";
import { applyPendingEvent, applyThreadEvent, sameItem, startThreadWatch, useThreadStore, WATCH_BATCH_MS, type ThreadLog } from "./thread";

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
const snapshot = (seq: number, items: ThreadItemView[], pending: ThreadPendingView[] = []): ThreadEventView => ({ kind: "snapshot", sessionId: "s", seq, items, pending });

function apply(log: ThreadLog | undefined, ...evs: ThreadEventView[]): ThreadLog | undefined {
  return evs.reduce(applyThreadEvent, log);
}

describe("applyThreadEvent", () => {
  it("drops everything before the first snapshot", () => {
    expect(apply(undefined, { kind: "appended", sessionId: "s", seq: 5, item: text("a", 1) })).toBeUndefined();
  });

  it("applies events above the snapshot's seq and drops the rest (snapshot+seq dedupe)", () => {
    const log = apply(
      undefined,
      snapshot(10, [text("a", 1, "hi")]),
      { kind: "appended", sessionId: "s", seq: 9, item: text("old", 2) },
      { kind: "delta", sessionId: "s", seq: 10, itemId: "a", ordinal: 1, field: "text", text: " again" },
      { kind: "delta", sessionId: "s", seq: 11, itemId: "a", ordinal: 1, field: "text", text: " there" },
      { kind: "appended", sessionId: "s", seq: 12, item: text("b", 3) },
      { kind: "delta", sessionId: "s", seq: 12, itemId: "b", ordinal: 3, field: "text", text: "dup" },
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
      { kind: "delta", sessionId: "s", seq: 2, itemId: "t", ordinal: 1, field: "input", text: 'and":"ls"}' },
      { kind: "delta", sessionId: "s", seq: 3, itemId: "t", ordinal: 1, field: "text", text: "nope" },
      { kind: "delta", sessionId: "s", seq: 4, itemId: "missing", ordinal: 9, field: "text", text: "x" },
    );
    expect(log?.byId.t).toMatchObject({ inputJson: '{"command":"ls"}' });
    expect(log?.seq).toBe(4);
  });

  it("orders by ordinal, replaces by id, and keeps unchanged items and the order by identity", () => {
    const a = text("a", 5, "x");
    let log = apply(undefined, snapshot(1, [a, text("b", 2)]));
    expect(log?.order).toEqual(["b", "a"]);
    const order = log?.order;
    log = apply(log, { kind: "updated", sessionId: "s", seq: 2, item: { ...a } });
    expect(log?.byId.a).toBe(a);
    expect(log?.order).toBe(order);
    log = apply(log, { kind: "updated", sessionId: "s", seq: 3, item: text("a", 5, "y") });
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
    log = apply(log, { kind: "pending", sessionId: "s", seq: 2, pending: [pend("r1")] });
    expect(log?.pending.map((p) => p.requestId)).toEqual(["r1"]);
    log = apply(log, { kind: "pending", sessionId: "s", seq: 2, pending: [] });
    expect(log?.pending).toHaveLength(1);
    log = apply(log, { kind: "pending", sessionId: "s", seq: 3, pending: [] });
    expect(log?.pending).toEqual([]);
  });
});

describe("sameItem", () => {
  it("compares arrays and the request (answers included) by value", () => {
    const req = { requestId: "r", toolName: "AskUserQuestion", displayName: "", title: "", description: "", toolUseId: "t", agentId: "", blockedPath: "", decisionReason: "", inputJson: "{}", suggestionsJson: "", state: "allowed" as const, decision: "allow", message: "", answers: { Q: "A" } };
    const q = (answers: Record<string, string>): ThreadItemView => ({ id: "q", ordinal: 1, parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: false, kind: "question", request: { ...req, answers } });
    expect(sameItem(q({ Q: "A" }), q({ Q: "A" }))).toBe(true);
    expect(sameItem(q({ Q: "A" }), q({ Q: "B" }))).toBe(false);
    const u = (atts: string[]): ThreadItemView => ({ id: "u", ordinal: 1, parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: false, kind: "user", text: "hi", attachments: atts });
    expect(sameItem(u(["/a.png"]), u(["/a.png"]))).toBe(true);
    expect(sameItem(u(["/a.png"]), u([]))).toBe(false);
  });
});

describe("applyPendingEvent (EventService thread source)", () => {
  it("replaces on the snapshot, follows pending events by seq, and ignores item events", () => {
    let p = applyPendingEvent({}, { kind: "pendingSnapshot", threads: [{ sessionId: "a", seq: 4, pending: [pend("r1")] }] });
    expect(Object.keys(p)).toEqual(["a"]);
    const same = applyPendingEvent(p, { kind: "pendingSnapshot", threads: [{ sessionId: "a", seq: 4, pending: [pend("r1")] }] });
    expect(same).toBe(p);
    p = applyPendingEvent(p, { kind: "pending", sessionId: "b", seq: 1, pending: [pend("r2")] });
    expect(Object.keys(p).sort()).toEqual(["a", "b"]);
    expect(applyPendingEvent(p, { kind: "pending", sessionId: "a", seq: 3, pending: [] })).toBe(p);
    p = applyPendingEvent(p, { kind: "pending", sessionId: "a", seq: 5, pending: [] });
    expect(Object.keys(p)).toEqual(["b"]);
    expect(applyPendingEvent(p, { kind: "appended", sessionId: "b", seq: 9, item: text("x", 1) })).toBe(p);
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
      { kind: "delta", sessionId: "s", seq: 2, itemId: "a", ordinal: 1, field: "text", text: "l" },
      { kind: "delta", sessionId: "s", seq: 3, itemId: "a", ordinal: 1, field: "text", text: "lo" },
    ];
    const updates = vi.fn();
    const unsub = useThreadStore.subscribe((s, prev) => {
      if (s.logs !== prev.logs) updates();
    });
    const stop = startThreadWatch("s");
    await vi.advanceTimersByTimeAsync(0);
    expect(useThreadStore.getState().watch).toMatchObject({ sessionId: "s", status: "open" });
    expect(useThreadStore.getState().logs.s).toBeUndefined();
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_MS);
    expect(useThreadStore.getState().logs.s?.byId.a).toMatchObject({ text: "hello" });
    expect(updates).toHaveBeenCalledTimes(1);
    stop();
    unsub();
    expect(useThreadStore.getState().watch).toBeNull();
    expect(watched.opened).toBe(1);
  });
});
