import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { toThreadView } from "@/api/threads";
import { ThreadFlagLevel, ThreadSchema, ThreadState, ThreadStatus } from "@/gen/codefoundry/v1/thread_lifecycle_pb";
import { statusLine } from "@/lib/statusLine";
import { threadGroup } from "@/lib/thread";
import { isAttention, isRunning, sameThread } from "@/stores/threads";

// Plugins' flags no longer show in the GUI (docs/notes/notifications-4-row-mark.md): a flag
// arrives as a notification naming the thread, which its row's mark and hover card show. A
// daemon that still fills Thread.flags is read without them: nothing on line 1, no attention
// group, no attention count.
describe("Thread.flags from an older daemon", () => {
  const flagged = () =>
    create(ThreadSchema, {
      id: "s",
      state: ThreadState.CONNECTED,
      status: ThreadStatus.IDLE,
      flags: [
        { plugin: "gh-actions", pluginDisplayName: "GitHub Actions", level: ThreadFlagLevel.ERROR, reason: "deploy failed" },
        { plugin: "lint", pluginDisplayName: "Lint", level: ThreadFlagLevel.ATTENTION, reason: "3 warnings", untilSeen: true },
      ],
    });

  it("maps the thread and leaves the flags out", () => {
    const v = toThreadView(flagged());
    expect(v.id).toBe("s");
    expect("flags" in v).toBe(false);
  });

  it("an idle thread with flags reads as idle: no status, the idle group, not attention", () => {
    const v = toThreadView(flagged());
    const plain = toThreadView(create(ThreadSchema, { id: "s", state: ThreadState.CONNECTED, status: ThreadStatus.IDLE }));
    expect(statusLine(v)).toEqual(statusLine(plain));
    expect(statusLine(v).kind).toBe("place");
    expect(threadGroup(v)).toBe(threadGroup(plain));
    expect(isAttention(v)).toBe(false);
    expect(isRunning(v)).toBe(isRunning(plain));
  });

  it("flags coming or going are no change to the thread", () => {
    expect(sameThread(toThreadView(flagged()), toThreadView(create(ThreadSchema, { id: "s", state: ThreadState.CONNECTED, status: ThreadStatus.IDLE })))).toBe(true);
  });
});
