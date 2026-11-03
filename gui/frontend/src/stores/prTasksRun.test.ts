import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvokeResultView } from "@/api/command";

const answer = vi.hoisted(() => ({ resolve: null as ((r: InvokeResultView) => void) | null }));
vi.mock("./commands", () => ({
  runCommandForResult: vi.fn(
    () =>
      new Promise<InvokeResultView>((resolve) => {
        answer.resolve = resolve;
      }),
  ),
}));
const toasts = vi.hoisted(() => ({ success: vi.fn<(text: string, opts?: { action?: unknown }) => void>(), error: vi.fn<(text: string) => void>() }));
vi.mock("sonner", () => ({ toast: toasts }));

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
    const [text, opts] = toasts.success.mock.calls[0] ?? [];
    expect(text).toBe("Sent to Port the fix for this thread");
    expect(opts?.action).toBeDefined(); // Open: the owner is not selected
  });

  it("pressed outside a thread (a page): the sender is named, whatever is selected later", async () => {
    useThreadsStore.setState({ byId: { "s-3": thread("s-3", { name: "Fix resize race" }), "s-kid": thread("s-kid", { name: "Port the fix" }) } });
    useUiStore.setState({ selection: { kind: "none" } });
    const run = runPrTask({ slug: "o/r", number: 7 }, "checks", { kind: "other", threadId: "s-3", name: "Fix resize race" });
    useUiStore.setState({ selection: { kind: "thread", id: "s-3" } });
    answer.resolve?.({ message: "Sent to Port the fix (s-kid) for Fix resize race (s-3) (#4)", resultJson: '{"threadId":"s-kid","viaThreadId":"s-3","sent":true}' });
    await run;
    expect(toasts.success.mock.calls[0]?.[0]).toBe("Sent to Port the fix for Fix resize race");
  });
});
