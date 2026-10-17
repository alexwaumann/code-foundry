import { Code, ConnectError } from "@connectrpc/connect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const commands = vi.hoisted(() => ({ runCommand: vi.fn(), runCommandForResult: vi.fn(), refreshCommands: vi.fn() }));
vi.mock("./commands", async (importOriginal) => ({ ...(await importOriginal<typeof import("./commands")>()), ...commands }));
vi.mock("./context", () => ({ getUiContext: (target: { id: string }) => ({ activeSessionId: target.id }) }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const { respondThread, snoozeSession, THREAD_COMMANDS } = await import("./threadActions");
const { useThreadStore } = await import("./thread");

type Opts = { expected?: (err: unknown) => boolean };

/** runCommandForResult failing with err: calls `expected` like the real one, then resolves null. */
function failWith(err: unknown) {
  commands.runCommandForResult.mockImplementationOnce((_name: string, _args: unknown, opts: Opts) => {
    if (!opts.expected?.(err)) toast.error("Answer Thread Request failed");
    return Promise.resolve(null);
  });
}

const answering = () => useThreadStore.getState().answering.s1 ?? {};

beforeEach(() => {
  vi.clearAllMocks();
  commands.runCommand.mockResolvedValue(true);
  useThreadStore.setState({ answering: {} });
});

describe("snoozeSession", () => {
  it("sends an absolute time as RFC 3339 in the thread's context", async () => {
    expect(await snoozeSession("s1", Date.UTC(2026, 9, 15, 14, 0))).toBe(true);
    expect(commands.runCommand).toHaveBeenCalledWith(THREAD_COMMANDS.snooze, { until: "2026-10-15T14:00:00.000Z" }, { activeSessionId: "s1" });
    expect(THREAD_COMMANDS.snooze).toBe("thread.snooze");
  });

  it("null unsnoozes with clear", async () => {
    await snoozeSession("s2", null);
    expect(commands.runCommand).toHaveBeenCalledWith("thread.snooze", { clear: "true" }, { activeSessionId: "s2" });
  });
});

describe("respondThread", () => {
  it("sends the decision, the answers as JSON and a trimmed reason; the prompt leaves", async () => {
    commands.runCommandForResult.mockResolvedValueOnce({ message: "", resultJson: "" });
    expect(await respondThread("s1", "r1", "deny", { message: "  not now " })).toBe(true);
    expect(commands.runCommandForResult).toHaveBeenCalledWith("thread.respond", { id: "s1", request: "r1", decision: "deny", message: "not now" }, expect.objectContaining({ quiet: true }));
    commands.runCommandForResult.mockResolvedValueOnce({ message: "", resultJson: "" });
    await respondThread("s1", "r2", "allow", { answers: { "Which?": "A, B" } });
    expect(commands.runCommandForResult).toHaveBeenLastCalledWith("thread.respond", { id: "s1", request: "r2", decision: "allow", answer: '{"Which?":"A, B"}' }, expect.anything());
    expect(answering()).toEqual({ r1: true, r2: true });
  });

  it("a failed answer brings the prompt back once and toasts the error", async () => {
    failWith(new ConnectError("the thread's process has ended", Code.FailedPrecondition));
    expect(await respondThread("s1", "r1", "allow")).toBe(false);
    expect(answering()).toEqual({});
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it("a request Claude withdrew stays gone with a plain notice, no error", async () => {
    failWith(new ConnectError("Claude withdrew request r1", Code.NotFound));
    expect(await respondThread("s1", "r1", "allow")).toBe(false);
    expect(answering()).toEqual({ r1: true });
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
  });
});
