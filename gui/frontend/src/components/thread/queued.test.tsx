import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadEventView, ThreadItemView } from "@/api/thread";
import { buildRows, buildTurns, decodeTimelineKey, timelineKey } from "@/lib/threadTimeline";
import { applyThreadEvent, structOf, useThreadStore, type ThreadLog } from "@/stores/thread";
import { ThreadContext } from "./context";
import { TimelineRowView } from "./rows";

// A message Claude has not read yet (docs/notes/orch-queued-placement.md): tagged
// "queued" until the daemon says it was read and moves it there.

afterEach(() => {
  cleanup();
  useThreadStore.setState({ logs: {} });
});

const base = { parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: false };
const user = (id: string, ordinal: number, over: Partial<Extract<ThreadItemView, { kind: "user" }>> = {}): ThreadItemView => ({
  ...base,
  id,
  ordinal,
  kind: "user",
  text: id,
  attachments: [],
  composerText: "",
  ...over,
});
const text = (id: string, ordinal: number): ThreadItemView => ({ ...base, id, ordinal, kind: "text", text: id });
const bash = (id: string, ordinal: number): ThreadItemView => ({
  ...base,
  id,
  ordinal,
  kind: "tool",
  toolUseId: id,
  name: "Bash",
  inputJson: '{"command":"sleep 4"}',
  status: "done",
  output: "",
  isError: false,
  resultJson: "",
});
const wake = { title: "Thread Child is idle", json: JSON.stringify({ kind: "thread", thread: { id: "s-c", name: "Child", status: "idle", status_reason: "finished" } }) };

function logOf(items: ThreadItemView[]): ThreadLog | undefined {
  return applyThreadEvent(undefined, { kind: "snapshot", threadId: "s", seq: 1, items, pending: [], mcp: null, commands: [], agents: [] });
}

function show(log: ThreadLog) {
  useThreadStore.setState({ logs: { s: log } });
  const items = log.order.map((id) => log.byId[id] as ThreadItemView);
  const rows = buildRows(buildTurns(items.map((it) => decodeTimelineKey(timelineKey(structOf(it))))), { fold: () => undefined, working: true });
  return render(
    <ThreadContext.Provider value={{ threadId: "s", cwd: "/w" }}>
      {rows.map((r) => (
        <TimelineRowView key={r.key} row={r} />
      ))}
    </ThreadContext.Provider>,
  ).container;
}

describe("the log's order", () => {
  it("puts a placed message after the item it was read after, behind ones placed there earlier", () => {
    const log = logOf([user("u1", 1), text("m1", 2), user("u3", 4, { placedAfter: 5 }), bash("A", 5), user("u2", 3, { placedAfter: 5 }), text("m2", 6)]);
    expect(log?.order).toEqual(["u1", "m1", "A", "u2", "u3", "m2"]);
  });

  it("moves a message when an update places it", () => {
    let log = logOf([user("u1", 1), text("m1", 2), user("u2", 3, { queued: true }), bash("A", 4)]);
    expect(log?.order).toEqual(["u1", "m1", "u2", "A"]);
    const placed: ThreadEventView = { kind: "updated", threadId: "s", seq: 2, item: user("u2", 3, { placedAfter: 4 }) };
    log = applyThreadEvent(log, placed);
    expect(log?.order).toEqual(["u1", "m1", "A", "u2"]);
  });
});

describe("a queued message", () => {
  it("is tagged queued under its bubble, with what the tag means in a tooltip", () => {
    const log = logOf([user("u1", 1), text("m1", 2), user("u2", 3, { queued: true })]);
    const c = show(log as ThreadLog);
    const steer = c.querySelector('[data-testid="thread-steer"]');
    const tag = steer?.querySelector('[data-testid="thread-queued"]');
    expect(tag?.textContent).toBe("queued");
    expect(tag?.className).toContain("text-caption");
    expect(c.querySelectorAll('[data-testid="thread-queued"]')).toHaveLength(1);
  });

  it("loses the tag once read, and sits above what answers it", () => {
    let log = logOf([user("u1", 1), text("m1", 2), user("u2", 3, { queued: true }), bash("A", 4)]);
    log = applyThreadEvent(log, { kind: "updated", threadId: "s", seq: 2, item: user("u2", 3, { placedAfter: 4 }) });
    log = applyThreadEvent(log, { kind: "appended", threadId: "s", seq: 3, item: text("answer", 5) });
    const c = show(log as ThreadLog);
    expect(c.querySelector('[data-testid="thread-queued"]')).toBeNull();
    const steer = c.querySelector('[data-testid="thread-steer"]');
    expect(steer?.nextElementSibling?.textContent).toContain("answer");
  });

  it("a queued wake is tagged on its note", () => {
    const log = logOf([user("u1", 1), text("m1", 2), user("w", 3, { wake, queued: true })]);
    const c = show(log as ThreadLog);
    expect(c.querySelector('[data-testid="thread-wake-note"] [data-testid="thread-queued"]')).not.toBeNull();
  });
});
