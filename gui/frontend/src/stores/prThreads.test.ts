import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeCommand = vi.hoisted(() => vi.fn());
const listCommands = vi.hoisted(() => vi.fn(() => Promise.resolve([])));
vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), invokeCommand, listCommands }));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), loading: vi.fn(() => "t1"), dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const { PREPARING_TOAST_DELAY_MS, openStartedThread, prThreadArgs, startingKey, startPrThread, usePrThreadsStore } = await import("./prThreads");
const { useUiStore } = await import("./ui");

const REF = { slug: "acme/repo", number: 12 };
const started = (id: string) => ({ message: `Started session ${id} for PR #12`, resultJson: JSON.stringify({ id, worktreePath: "/w" }) });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  usePrThreadsStore.setState({ starting: {} });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("prThreadArgs", () => {
  it.each([
    ["explain", "", { "repo-slug": "acme/repo", number: "12" }],
    ["fix", "ignored", { "repo-slug": "acme/repo", number: "12" }],
    ["ask", "  why the lock?\nand the retry  ", { "repo-slug": "acme/repo", number: "12", question: "why the lock?\nand the retry" }],
    ["ask", "", { "repo-slug": "acme/repo", number: "12", question: "" }],
  ] as const)("%s with %j", (kind, question, want) => {
    // No worktree, model or effort: the daemon reads the active worktree from the context
    // and the defaults from settings.
    expect(prThreadArgs(kind, REF, question)).toEqual(want);
  });
});

describe("startPrThread", () => {
  it.each([
    ["explain", "pr.explain", "", {}],
    ["fix", "pr.fix.findings", "", {}],
    ["ask", "pr.ask", "What does this change?", { question: "What does this change?" }],
  ] as const)("%s runs %s and resolves the new thread's id", async (kind, name, question, extra) => {
    invokeCommand.mockResolvedValueOnce(started("s-9"));
    await expect(startPrThread(kind, REF, question)).resolves.toBe("s-9");
    expect(invokeCommand).toHaveBeenCalledWith(name, expect.anything(), { "repo-slug": "acme/repo", number: "12", ...extra });
    expect(toast.success).toHaveBeenCalledTimes(1); // runCommandForResult's own toast is skipped
    const [message, opts] = toast.success.mock.calls[0] as [string, { action: { label: string; onClick: unknown } }];
    expect(message).toBe("Started session s-9 for PR #12");
    expect(opts.action.label).toBe("Open");
    expect(typeof opts.action.onClick).toBe("function");
    expect(usePrThreadsStore.getState().starting).toEqual({});
  });

  it("does not send a blank question", async () => {
    await expect(startPrThread("ask", REF, " \n ")).resolves.toBeNull();
    expect(invokeCommand).not.toHaveBeenCalled();
  });

  it("is busy while running, and a second run of the same command sends nothing", async () => {
    const d = deferred<ReturnType<typeof started>>();
    invokeCommand.mockReturnValueOnce(d.promise);
    const first = startPrThread("explain", REF);
    expect(usePrThreadsStore.getState().starting).toEqual({ [startingKey(REF, "explain")]: true });
    await expect(startPrThread("explain", REF)).resolves.toBeNull();
    expect(invokeCommand).toHaveBeenCalledTimes(1);
    d.resolve(started("s-1"));
    await expect(first).resolves.toBe("s-1");
    expect(usePrThreadsStore.getState().starting).toEqual({});
  });

  it("fix findings shows a preparing toast while it runs and dismisses it after sonner has added it", async () => {
    vi.useFakeTimers();
    try {
      const d = deferred<ReturnType<typeof started>>();
      invokeCommand.mockReturnValueOnce(d.promise);
      const run = startPrThread("fix", REF);
      expect(toast.loading).not.toHaveBeenCalled();
      vi.advanceTimersByTime(PREPARING_TOAST_DELAY_MS);
      expect(toast.loading).toHaveBeenCalledWith("Preparing worktree for #12…");
      d.resolve(started("s-2"));
      await run;
      // Deferred to a timeout queued after sonner's own add.
      expect(toast.dismiss).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(toast.dismiss).toHaveBeenCalledWith("t1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a quick answer shows no preparing toast", async () => {
    vi.useFakeTimers();
    try {
      invokeCommand.mockResolvedValueOnce(started("s-2"));
      await startPrThread("fix", REF);
      vi.runAllTimers();
      expect(toast.loading).not.toHaveBeenCalled();
      expect(toast.dismiss).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("explain shows no preparing toast", async () => {
    invokeCommand.mockResolvedValueOnce(started("s-3"));
    await startPrThread("explain", REF);
    expect(toast.loading).not.toHaveBeenCalled();
  });

  it("a failure is toasted, resolves null and clears the busy flag", async () => {
    invokeCommand.mockRejectedValueOnce(new Error("#12 comes from a fork and no worktree of acme/repo has its head checked out"));
    await expect(startPrThread("fix", REF)).resolves.toBeNull();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error.mock.calls[0]).toEqual(["pr.fix.findings failed", { description: "#12 comes from a fork and no worktree of acme/repo has its head checked out" }]);
    expect(usePrThreadsStore.getState().starting).toEqual({});
  });

  it("a result without a session id still counts as started, with no Open action", async () => {
    invokeCommand.mockResolvedValueOnce({ message: "Started", resultJson: "" });
    await expect(startPrThread("explain", REF)).resolves.toBe("");
    expect(toast.success).toHaveBeenCalledWith("Started", undefined);
  });

  it("the toast's Open selects the new thread when no FocusThread moved the selection", async () => {
    useUiStore.setState({ selection: { kind: "view", name: "pullrequests" }, promptFocusSeq: 0 });
    invokeCommand.mockResolvedValueOnce(started("s-9"));
    await startPrThread("explain", REF);
    const opts = toast.success.mock.calls[0]?.[1] as { action: { onClick: () => void } };
    opts.action.onClick();
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-9" });
    expect(useUiStore.getState().promptFocusSeq).toBe(1);
  });
});

describe("openStartedThread", () => {
  it.each([
    ["the Pull Requests page", { kind: "view", name: "pullrequests" }, 1],
    ["another session", { kind: "thread", id: "s-1" }, 1],
    // FocusThread got there first: nothing changes (no second terminal focus).
    ["the new thread", { kind: "thread", id: "s-9" }, 0],
  ] as const)("from %s", (_, selection, focusSeq) => {
    useUiStore.setState({ selection, promptFocusSeq: 0 });
    openStartedThread("s-9");
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-9" });
    expect(useUiStore.getState().promptFocusSeq).toBe(focusSeq);
  });
});
