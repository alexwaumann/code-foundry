// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { ThreadStatus } from "../src/gen/codefoundry/v1/thread_lifecycle_pb";
import { World } from "./world";

/** The mock daemon mirrors a snooze until an event (docs/notes/snooze-until-event.md). */
const c = { activeThreadId: "s-1", activeView: "thread" } as UiContext;

async function run(w: World, name: string, args: Record<string, string>): Promise<{ message: string; resultJson: string }> {
  const out = await w.invoke(name, c, args, false);
  return typeof out === "string" ? { message: out, resultJson: "" } : out;
}

describe("snooze until an event in the mock", () => {
  it("lists the linked open pull requests newest first, and the running plugins' wake sources", async () => {
    const w = new World();
    w.linkPullRequest("s-1", "acme/web", 790);
    w.linkPullRequest("s-1", "acme/web", 812);
    const evs = JSON.parse((await run(w, "thread.snooze.events", { id: "s-1" })).resultJson) as { pullRequests: { number: number; conditions: string[] }[]; plugins: { target: string }[] };
    expect(evs.pullRequests.map((p) => p.number)).toEqual([812, 790]);
    expect(evs.pullRequests[0]?.conditions).toEqual(["checks_done", "review", "merged", "comment", "head_pushed", "closed", "review_requested"]);
    expect(evs.plugins.map((p) => p.target)).toEqual(expect.arrayContaining(["hello/tick", "test-watcher/tests-finished", "doc-preview/deploy"]));
  });

  it("snoozes until the event, shows it, ends it as a wake with the sentence, and remembers the plugin used", async () => {
    const w = new World();
    w.linkPullRequest("s-1", "acme/web", 812);
    expect((await run(w, "thread.snooze", { "until-pr": "#812", on: "merged" })).message).toBe(`snoozed thread ${label(w)} until #812 is merged`);
    const s = w.threads.get("s-1");
    expect(s?.savedAt).not.toBeNull();
    expect(s?.snoozeEvent).toMatchObject({ kind: "pull_request", target: "acme/web#812", condition: "merged", label: "#812 merged" });
    w.endEventSnooze("s-1");
    expect(s?.savedAt).toBeNull();
    expect(s?.snoozeEvent).toBeNull();
    expect(s?.snoozeEndedBy).toBe("#812 was merged");
    // s-1 is working: like the daemon's wake, a working thread keeps its status.
    expect(s?.status).toBe(ThreadStatus.BUSY);
    if (s) {
      s.status = ThreadStatus.IDLE;
      s.statusReason = "at prompt";
    }

    await run(w, "thread.snooze", { "until-plugin": "hello/tick" });
    w.endEventSnooze("s-1", "Hello: tick 1");
    expect([s?.status, s?.statusReason, s?.snoozeEndedBy]).toEqual([ThreadStatus.NEEDS_ATTENTION, "snooze ended", "Hello: tick 1"]);
    await run(w, "thread.snooze", { "until-plugin": "hello/tick" });
    expect(s?.snoozeEvent).toMatchObject({ kind: "plugin", target: "hello/tick", label: "tick", waitingFor: "Tick (Hello)" });
    expect(s?.snoozeEndedBy).toBe("");
    const evs = JSON.parse((await run(w, "thread.snooze.events", { id: "s-1" })).resultJson) as { recentPlugins: string[] };
    expect(evs.recentPlugins).toEqual(["hello/tick"]);
    // A timed snooze, a save or an unsnooze drops the event.
    await run(w, "thread.snooze", { save: "true" });
    expect(s?.snoozeEvent).toBeNull();
  });

  it("refuses an event the thread cannot wait on, and two forms at once", async () => {
    const w = new World();
    await expect(run(w, "thread.snooze", { "until-pr": "#999" })).rejects.toThrow(/not an open pull request/);
    await expect(run(w, "thread.snooze", { "until-plugin": "nope/x" })).rejects.toThrow(/no running plugin/);
    await expect(run(w, "thread.snooze", { "until-pr": "#1", save: "true" })).rejects.toThrow(/give one of/);
  });
});

function label(w: World): string {
  const s = w.threads.get("s-1");
  return s?.name ? `${s.name} (${s.id})` : "s-1";
}
