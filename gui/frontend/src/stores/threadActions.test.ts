import { Code, ConnectError } from "@connectrpc/connect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";

const commands = vi.hoisted(() => ({ runCommand: vi.fn(), runCommandForResult: vi.fn(), refreshCommands: vi.fn() }));
vi.mock("./commands", async (importOriginal) => ({ ...(await importOriginal<typeof import("./commands")>()), ...commands }));
vi.mock("./context", () => ({ getUiContext: (target: { id: string }) => ({ activeThreadId: target.id }) }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const { archiveThread, respondThread, snoozeThread, THREAD_COMMANDS, toggleThreadSidebar } = await import("./threadActions");
const { useThreadStore } = await import("./thread");
const { useThreadsStore } = await import("./threads");
const { useSettingsStore } = await import("./settings");

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

describe("snoozeThread", () => {
  it("sends an absolute time as RFC 3339 in the thread's context", async () => {
    expect(await snoozeThread("s1", Date.UTC(2026, 9, 15, 14, 0))).toBe(true);
    expect(commands.runCommand).toHaveBeenCalledWith(THREAD_COMMANDS.snooze, { until: "2026-10-15T14:00:00.000Z" }, { activeThreadId: "s1" });
    expect(THREAD_COMMANDS.snooze).toBe("thread.snooze");
  });

  it("null unsnoozes with clear", async () => {
    await snoozeThread("s2", null);
    expect(commands.runCommand).toHaveBeenCalledWith("thread.snooze", { clear: "true" }, { activeThreadId: "s2" });
  });
});

describe("archiveThread", () => {
  it.each([
    ["archives", true, "true"],
    ["unarchives", false, "false"],
  ] as const)("%s in the thread's context", async (_, archived, arg) => {
    expect(await archiveThread("s3", archived)).toBe(true);
    expect(commands.runCommand).toHaveBeenCalledWith("thread.archive", { archived: arg }, { activeThreadId: "s3" });
    expect(THREAD_COMMANDS.archive).toBe("thread.archive");
  });
});

describe("toggleThreadSidebar (thread.sidebar's presenter)", () => {
  const kid = (inSidebar: boolean | null) => ({ id: "k", createdBy: "p", inSidebar }) as ThreadView;
  it.each<[string, boolean | null, boolean, string]>([
    ["hidden by the setting: shows it", null, false, "true"],
    ["shown by the setting: hides it", null, true, "false"],
    ["shown by its override: hides it", true, false, "false"],
    ["hidden by its override: shows it", false, true, "true"],
  ])("%s", (_name, over, showCreated, shown) => {
    useThreadsStore.setState({ byId: { k: kid(over) }, order: ["k"] });
    useSettingsStore.setState({ snapshot: { values: { "threads.show_created_threads": String(showCreated) }, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
    expect(toggleThreadSidebar("k")).toBe(true);
    expect(commands.runCommand).toHaveBeenCalledWith("thread.sidebar", { shown }, { activeThreadId: "k" });
  });

  it("an unknown thread: not presented (the command prompts as usual)", () => {
    expect(toggleThreadSidebar("nope")).toBe(false);
    expect(commands.runCommand).not.toHaveBeenCalled();
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
