import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvokeResultView } from "@/api/command";
import type { Notice } from "@/lib/notify";

const answer = vi.hoisted(() => ({ resolve: null as ((r: InvokeResultView) => void) | null }));
vi.mock("./commands", () => ({
  runCommandForResult: vi.fn(
    () =>
      new Promise<InvokeResultView>((resolve) => {
        answer.resolve = resolve;
      }),
  ),
}));
const notify = vi.hoisted(() => vi.fn<(n: Notice) => void>());
vi.mock("@/lib/notify", () => ({ notify, notifyProgress: vi.fn(), dismissNotice: vi.fn() }));

const { runPrTask } = await import("./prTasks");
const { useUiStore } = await import("./ui");
const { useThreadsStore } = await import("./threads");
const { thread } = await import("@/test/projectsWorld");

afterEach(() => {
  vi.clearAllMocks();
});

describe("runPrTask", () => {
  it("a forward's toast says 'for this thread' for the thread the button was pressed in, though another is selected when the answer comes", async () => {
    useThreadsStore.setState({ byId: { "s-3": thread("s-3", { name: "Fix resize race" }), "s-kid": thread("s-kid", { name: "Port the fix" }), "s-1": thread("s-1", { name: "Other" }) } });
    useUiStore.setState({ selection: { kind: "thread", id: "s-3" } });
    const run = runPrTask({ slug: "o/r", number: 7 }, "checks", { kind: "this", threadId: "s-3" });
    // The user moves on before the daemon answers.
    useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
    answer.resolve?.({ message: "Sent to Port the fix (s-kid) for Fix resize race (s-3) (#4); wait with: x", resultJson: '{"threadId":"s-kid","viaThreadId":"s-3","sent":true,"ordinal":4}' });
    await expect(run).resolves.toBe("s-kid");
    const n = notify.mock.calls[0]?.[0];
    expect(n).toMatchObject({ level: "success", title: "Task sent", description: "Sent to Port the fix for this thread" });
    expect(n?.action).toBeDefined(); // Open: the owner is not selected
  });

  it("pressed outside a thread (a page): the sender is named, whatever is selected later", async () => {
    useThreadsStore.setState({ byId: { "s-3": thread("s-3", { name: "Fix resize race" }), "s-kid": thread("s-kid", { name: "Port the fix" }) } });
    useUiStore.setState({ selection: { kind: "none" } });
    const run = runPrTask({ slug: "o/r", number: 7 }, "checks", { kind: "other", threadId: "s-3", name: "Fix resize race" });
    useUiStore.setState({ selection: { kind: "thread", id: "s-3" } });
    answer.resolve?.({ message: "Sent to Port the fix (s-kid) for Fix resize race (s-3) (#4)", resultJson: '{"threadId":"s-kid","viaThreadId":"s-3","sent":true}' });
    await run;
    expect(notify.mock.calls[0]?.[0].description).toBe("Sent to Port the fix for Fix resize race");
  });

  it("sent into the selected thread: the thread shows the task, so nothing is toasted", async () => {
    useThreadsStore.setState({ byId: { "s-3": thread("s-3", { name: "Fix resize race" }) } });
    useUiStore.setState({ selection: { kind: "thread", id: "s-3" } });
    const run = runPrTask({ slug: "o/r", number: 7 }, "checks", { kind: "this", threadId: "s-3" });
    answer.resolve?.({ message: "Sent to Fix resize race (s-3) (#4)", resultJson: '{"threadId":"s-3","sent":true}' });
    await expect(run).resolves.toBe("s-3");
    expect(notify).not.toHaveBeenCalled();
  });
});
