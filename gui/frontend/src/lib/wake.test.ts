import { describe, expect, it } from "vitest";
import { wakeLine } from "./wake";

const thread = (t: Record<string, unknown>) => JSON.stringify({ kind: "thread", subscription_id: "sub-1", condition: "settled", fired_at: "2026-10-17T09:01:08.732Z", thread: { id: "s-c", name: "Child", ...t } });
const run = (r: Record<string, unknown>) => JSON.stringify({ kind: "action_run", subscription_id: "sub-2", condition: "finished", run: { id: "r-1", action_name: "Slow", ...r } });

describe("wakeLine", () => {
  it.each([
    ["a finished thread with a report", thread({ status: "needs_attention", status_reason: "finished", report: { status: "done", summary: "6 tests, all passing" } }), { tone: "ok", threadId: "s-c", name: "Child", detail: "needs attention, finished", summary: "6 tests, all passing" }],
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
    ["neither a thread nor a run", '{"kind":"pr"}', '{\n  "kind": "pr"\n}'],
  ])("an unreadable payload (%s): the header as the summary", (_n, json, body = json) => {
    const l = wakeLine({ title: 'Thread "X" (s-1) is idle: finished.', json });
    expect(l).toMatchObject({ tone: "ok", threadId: "", name: "", detail: "", summary: 'Thread "X" (s-1) is idle: finished.' });
    // The raw text as the body when it does not parse as an object.
    expect(l.json).toBe(body);
  });
});
