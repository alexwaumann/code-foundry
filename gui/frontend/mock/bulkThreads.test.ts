// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { ThreadState, ThreadStatus } from "../src/gen/codefoundry/v1/thread_lifecycle_pb";
import { World } from "./world";

/**
 * The mock's thread.archive, .snooze, .remove and thread.space.move given ids (the sidebar's
 * selection, docs/notes/sidebar-bulk-select.md), as the daemon's: one command for every thread,
 * one question naming the count and the busy ones. Seed: s-1 works, s-2 asks a permission,
 * s-3 and s-4 are idle.
 */
const gui = { activeThreadId: "s-3", activeView: "thread" } as UiContext;

async function run(w: World, name: string, args: Record<string, string>, confirmed = false): Promise<string> {
  const out = await w.invoke(name, gui, args, confirmed);
  return typeof out === "string" ? out : out.message;
}

describe("the mock's commands given ids", () => {
  it("thread.archive archives each idle one at once, and asks once when some are busy", async () => {
    const w = new World();
    expect(await run(w, "thread.archive", { ids: "s-3,s-4", archived: "true" })).toBe("archived 2 threads: s-3, s-4");
    expect(w.threads.get("s-3")?.archivedAt).not.toBeNull();
    expect(w.threads.get("s-4")?.archivedAt).not.toBeNull();
    await expect(run(w, "thread.archive", { ids: "s-1,s-2,s-3", archived: "true" })).rejects.toThrow(/^Archive 3 threads\? 2 of them are busy: Refactor sidebar tree \(Claude is still working\), Port renderer \(Claude is waiting on your answer\)\./);
    expect(w.threads.get("s-1")?.archivedAt).toBeNull();
    expect(await run(w, "thread.archive", { ids: "s-3,s-4", archived: "false" })).toBe("unarchived 2 threads: s-3, s-4");
  });

  it("thread.snooze saves or snoozes each, never asks (busy ones work on), and clear unsnoozes each", async () => {
    const w = new World();
    expect(await run(w, "thread.snooze", { ids: "s-3,s-4", save: "true" })).toBe("saved 2 threads for later: s-3, s-4");
    expect(w.threads.get("s-4")?.savedAt).not.toBeNull();
    expect(await run(w, "thread.snooze", { ids: "s-1,s-3", save: "true" })).toBe("saved 2 threads for later: s-1, s-3");
    expect(w.threads.get("s-1")).toMatchObject({ status: ThreadStatus.BUSY, state: ThreadState.CONNECTED });
    expect(await run(w, "thread.snooze", { ids: "s-3,s-4", clear: "true" })).toBe("unsnoozed 2 threads: s-3, s-4");
    expect(w.threads.get("s-4")?.savedAt).toBeNull();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect(await run(w, "thread.snooze", { ids: "s-3,s-4", until })).toBe("snoozed 2 threads: s-3, s-4");
    expect(w.threads.get("s-3")?.snoozedUntil).not.toBeNull();
  });

  it("thread.remove asks once, naming the count, then forgets each", async () => {
    const w = new World();
    await expect(run(w, "thread.remove", { ids: "s-3,s-4" })).rejects.toThrow(/^Remove 2 threads\? Claude stops in each that runs, and they are forgotten: s-3, s-4\./);
    expect(await run(w, "thread.remove", { ids: "s-3,s-4" }, true)).toBe("removed 2 threads: s-3, s-4");
    expect(w.threads.has("s-3")).toBe(false);
    expect(w.threads.has("s-4")).toBe(false);
  });

  it("thread.unread marks each idle one, and names the ones it refuses", async () => {
    const w = new World();
    const idle = (id: string) => {
      const t = w.thread(id);
      t.status = ThreadStatus.IDLE;
      t.statusReason = "at prompt";
    };
    idle("s-3");
    idle("s-4");
    expect(await run(w, "thread.unread", { ids: "s-3,s-4" })).toBe("marked 2 threads unread: s-3, s-4");
    expect([w.thread("s-3").statusReason, w.thread("s-4").statusReason]).toEqual(["finished", "finished"]);
    idle("s-3");
    expect(await run(w, "thread.unread", { ids: "s-3,s-1" })).toMatch(/^marked 1 thread unread: s-3\nfailed on 1 thread:\n {2}s-1: thread s-1 is not idle at its prompt/);
  });
});
