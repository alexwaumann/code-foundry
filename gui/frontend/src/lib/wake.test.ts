import { describe, expect, it } from "vitest";
import { wakeLine, wakeLines } from "./wake";

const thread = (t: Record<string, unknown>) => JSON.stringify({ kind: "thread", subscription_id: "sub-1", condition: "settled", fired_at: "2026-10-17T09:01:08.732Z", thread: { id: "s-c", name: "Child", ...t } });
const run = (r: Record<string, unknown>) => JSON.stringify({ kind: "action_run", subscription_id: "sub-2", condition: "finished", run: { id: "r-1", action_name: "Slow", ...r } });

describe("wakeLine", () => {
  it.each([
    ["a finished thread with a report", thread({ status: "needs_attention", status_reason: "finished", report: { status: "done", summary: "6 tests, all passing" } }), { tone: "ok", threadId: "s-c", name: "Child", detail: "idle, finished", summary: "6 tests, all passing" }],
    ["an idle thread, no report", thread({ status: "idle", status_reason: "at prompt", report: null }), { tone: "ok", detail: "idle, at prompt", summary: "" }],
    ["a thread waiting on a permission", thread({ status: "needs_attention", status_reason: "permission: Bash" }), { tone: "attention", detail: "needs attention, permission: Bash" }],
    ["an error status", thread({ status: "error", status_reason: "interrupted" }), { tone: "fail", detail: "error, interrupted" }],
    ["a Claude error at the prompt", thread({ status: "needs_attention", status_reason: "error: overloaded" }), { tone: "fail" }],
    ["a failed report", thread({ status: "needs_attention", status_reason: "finished", report: { status: "failed", summary: "lock timeout" } }), { tone: "fail", summary: "lock timeout" }],
    ["an unnamed thread: its id", thread({ name: "", status: "idle" }), { name: "s-c", detail: "idle" }],
    ["a run that exited 0", run({ exit_code: 0, output_tail: "built 42 files\n\n" }), { tone: "ok", threadId: "", name: "Slow", detail: "exit 0", summary: "built 42 files" }],
    ["a run that failed", run({ exit_code: 3, output_tail: "a\nb\n" }), { tone: "fail", detail: "exit 3", summary: "b" }],
    ["a run without output", run({ exit_code: 1 }), { tone: "fail", summary: "" }],
  ])("%s", (_n, json, want) => {
    expect(wakeLine({ title: "the header", json })).toMatchObject(want);
  });

  it("pretty-prints the payload for the body", () => {
    expect(wakeLine({ title: "t", json: '{"kind":"thread","thread":{"id":"s"}}' }).json).toBe('{\n  "kind": "thread",\n  "thread": {\n    "id": "s"\n  }\n}');
  });

  it.each([
    ["not JSON", "{oops"],
    ["not an object", "[1]"],
    ["a pull request (no note of its own yet)", '{"kind":"pull_request","pull_request":{"number":7}}', '{\n  "kind": "pull_request",\n  "pull_request": {\n    "number": 7\n  }\n}'],
  ])("an unreadable payload (%s): the header as the summary", (_n, json, body = json) => {
    const l = wakeLine({ title: 'Thread "X" (s-1) is idle: finished.', json });
    expect(l).toMatchObject({ tone: "ok", threadId: "", name: "", detail: "", summary: 'Thread "X" (s-1) is idle: finished.' });
    // The raw text as the body when it does not parse as an object.
    expect(l.json).toBe(body);
  });

  it("a batch: one line per wake, each with its own payload", () => {
    const one = (id: string, t: Record<string, unknown>) => ({ kind: "thread", subscription_id: `sub-${id}`, condition: "settled", thread: { id, name: id.toUpperCase(), ...t } });
    const json = JSON.stringify({
      kind: "batch",
      wakes: [one("s-a", { status: "needs_attention", status_reason: "finished", report: { status: "done", summary: "ok" } }), one("s-b", { status: "needs_attention", status_reason: "permission: Bash" })],
    });
    const lines = wakeLines({ title: "2 threads settled: …", json });
    expect(lines).toMatchObject([
      { tone: "ok", threadId: "s-a", name: "S-A", detail: "idle, finished", summary: "ok" },
      { tone: "attention", threadId: "s-b", name: "S-B", detail: "needs attention, permission: Bash" },
    ]);
    expect(JSON.parse(lines[1]?.json ?? "")).toMatchObject({ subscription_id: "sub-s-b" });
    expect(wakeLine({ title: "t", json })).toMatchObject({ threadId: "s-a" });
  });

  it.each([
    ["an empty batch", '{"kind":"batch","wakes":[]}'],
    ["a batch of non-objects", '{"kind":"batch","wakes":[1]}'],
  ])("%s: one line with the header", (_n, json) => {
    expect(wakeLines({ title: "the header", json })).toMatchObject([{ threadId: "", summary: "the header" }]);
  });

  it("a restart: its notice is a line of its own, first", () => {
    const notice = { kind: "restart", restarted_at: "2026-10-19T10:45:50.000Z", interrupted: [{ id: "s-a", name: "Tests", reason: "daemon stopped" }, { id: "s-b", name: "", reason: "daemon stopped" }], subscriptions: 2 };
    const json = JSON.stringify({ kind: "batch", wakes: [notice, { kind: "thread", after_restart: true, thread: { id: "s-a", name: "Tests", status: "error", status_reason: "interrupted" } }] });
    expect(wakeLines({ title: "The app restarted at 10:45 CDT; …", json })).toMatchObject([
      { tone: "attention", threadId: "", name: "App restart", detail: "2 interrupted", summary: "Tests, s-b" },
      { tone: "fail", threadId: "s-a", detail: "error, interrupted" },
    ]);
    expect(wakeLines({ title: "t", json: JSON.stringify({ ...notice, interrupted: [], own_turn_interrupted: true }) })).toMatchObject([{ tone: "attention", detail: "own turn interrupted", summary: "" }]);
    expect(wakeLines({ title: "t", json: JSON.stringify({ ...notice, interrupted: [] }) })).toMatchObject([{ tone: "ok", detail: "", summary: "" }]);
  });

  it("a single wake is one line", () => {
    expect(wakeLines({ title: "t", json: thread({ status: "idle" }) })).toHaveLength(1);
  });
});
