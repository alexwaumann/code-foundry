import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeCommand = vi.hoisted(() => vi.fn());
const listCommands = vi.hoisted(() => vi.fn(() => Promise.resolve([])));
vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), invokeCommand, listCommands }));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), loading: vi.fn(() => "t1"), dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const { prSessionArgs, startingKey, startPrSession, usePrSessionsStore } = await import("./prSessions");

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
  usePrSessionsStore.setState({ starting: {} });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("prSessionArgs", () => {
  it.each([
    ["explain", "", { "repo-slug": "acme/repo", number: "12" }],
    ["fix", "ignored", { "repo-slug": "acme/repo", number: "12" }],
    ["ask", "  why the lock?\nand the retry  ", { "repo-slug": "acme/repo", number: "12", question: "why the lock?\nand the retry" }],
    ["ask", "", { "repo-slug": "acme/repo", number: "12", question: "" }],
  ] as const)("%s with %j", (kind, question, want) => {
    // No worktree, model or effort: the daemon reads the active worktree from the context
    // and the defaults from settings.
    expect(prSessionArgs(kind, REF, question)).toEqual(want);
  });
});

describe("startPrSession", () => {
  it.each([
    ["explain", "pr.explain", "", {}],
    ["fix", "pr.fix.findings", "", {}],
    ["ask", "pr.ask", "What does this change?", { question: "What does this change?" }],
  ] as const)("%s runs %s and resolves the new session's id", async (kind, name, question, extra) => {
    invokeCommand.mockResolvedValueOnce(started("s-9"));
    await expect(startPrSession(kind, REF, question)).resolves.toBe("s-9");
    expect(invokeCommand).toHaveBeenCalledWith(name, expect.anything(), { "repo-slug": "acme/repo", number: "12", ...extra });
    expect(toast.success).toHaveBeenCalledWith("Started session s-9 for PR #12");
    expect(usePrSessionsStore.getState().starting).toEqual({});
  });

  it("does not send a blank question", async () => {
    await expect(startPrSession("ask", REF, " \n ")).resolves.toBeNull();
    expect(invokeCommand).not.toHaveBeenCalled();
  });

  it("is busy while running, and a second run of the same command sends nothing", async () => {
    const d = deferred<ReturnType<typeof started>>();
    invokeCommand.mockReturnValueOnce(d.promise);
    const first = startPrSession("explain", REF);
    expect(usePrSessionsStore.getState().starting).toEqual({ [startingKey(REF, "explain")]: true });
    await expect(startPrSession("explain", REF)).resolves.toBeNull();
    expect(invokeCommand).toHaveBeenCalledTimes(1);
    d.resolve(started("s-1"));
    await expect(first).resolves.toBe("s-1");
    expect(usePrSessionsStore.getState().starting).toEqual({});
  });

  it("fix findings shows a preparing toast while it runs and dismisses it", async () => {
    const d = deferred<ReturnType<typeof started>>();
    invokeCommand.mockReturnValueOnce(d.promise);
    const run = startPrSession("fix", REF);
    expect(toast.loading).toHaveBeenCalledWith("Preparing worktree for #12…");
    expect(toast.dismiss).not.toHaveBeenCalled();
    d.resolve(started("s-2"));
    await run;
    expect(toast.dismiss).toHaveBeenCalledWith("t1");
  });

  it("explain shows no preparing toast", async () => {
    invokeCommand.mockResolvedValueOnce(started("s-3"));
    await startPrSession("explain", REF);
    expect(toast.loading).not.toHaveBeenCalled();
  });

  it("a failure is toasted, resolves null and clears the busy flag", async () => {
    invokeCommand.mockRejectedValueOnce(new Error("#12 comes from a fork and no worktree of acme/repo has its head checked out"));
    await expect(startPrSession("fix", REF)).resolves.toBeNull();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error.mock.calls[0]).toEqual(["pr.fix.findings failed", { description: "#12 comes from a fork and no worktree of acme/repo has its head checked out" }]);
    expect(toast.dismiss).toHaveBeenCalledWith("t1");
    expect(usePrSessionsStore.getState().starting).toEqual({});
  });

  it("a result without a session id still counts as started", async () => {
    invokeCommand.mockResolvedValueOnce({ message: "Started", resultJson: "" });
    await expect(startPrSession("explain", REF)).resolves.toBe("");
  });
});
