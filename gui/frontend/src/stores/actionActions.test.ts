import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRunFinishedView } from "@/api/actions";
import type { InvokeResultView } from "@/api/command";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));
const runCommandForResult = vi.hoisted(() => vi.fn<(...a: unknown[]) => Promise<InvokeResultView | null>>());
vi.mock("./commands", async (orig) => ({ ...(await orig<typeof import("./commands")>()), runCommandForResult, refreshCommands: vi.fn(() => Promise.resolve()) }));
const invokeCommand = vi.hoisted(() => vi.fn(() => Promise.resolve({ message: "", resultJson: "" })));
vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), invokeCommand }));
const showOwnTerminal = vi.hoisted(() => vi.fn());
const closeBottomTerminal = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const revealShell = vi.hoisted(() => vi.fn(() => false));
vi.mock("./bottomActions", async (orig) => ({ ...(await orig<typeof import("./bottomActions")>()), showOwnTerminal, closeBottomTerminal, revealShell }));

const { deleteAction, onActionRunFinished, openFailedRun, ownerOfTerminal, rerunAction, runAction, saveAction, setupFailedMessage, stopActionRun } = await import("./actionActions");
const { useActionsStore } = await import("./actions");
const { useActionDialogStore } = await import("./actionDialog");
const { useActionStopsStore } = await import("./actionStops");
const { useTerminalsStore } = await import("./terminals");
const { useThreadsStore } = await import("./threads");
const { useUiStore } = await import("./ui");

const finished = (o: Partial<ActionRunFinishedView>): ActionRunFinishedView => ({
  runId: "r-1",
  actionId: "a-1",
  actionName: "Install deps",
  repoId: "repo-cf",
  threadId: "s-1",
  exitCode: 1,
  mode: "background",
  trigger: "worktree-create",
  terminalId: "",
  ...o,
});

beforeEach(() => {
  runCommandForResult.mockReset();
  useThreadsStore.setState({ byId: {}, order: [] });
  runCommandForResult.mockResolvedValue({ message: "", resultJson: '{"id":"r-9","terminalId":"t-9"}' });
  useActionsStore.setState({ byId: { "a-1": { id: "a-1", repoId: "repo-cf", name: "Test", command: "go test", icon: "test", inTerminal: true, onWorktreeCreate: false, position: 0 } }, byRepo: { "repo-cf": ["a-1"] }, runs: {} });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("onActionRunFinished", () => {
  it.each([
    ["a failed setup run toasts", finished({}), true],
    ["a setup run that passed is quiet", finished({ exitCode: 0 }), false],
    ["a user's failed run is quiet (its tab shows it)", finished({ trigger: "user" }), false],
  ])("%s", (_n, f, toasts) => {
    onActionRunFinished(f);
    expect(toastError).toHaveBeenCalledTimes(toasts ? 1 : 0);
    if (toasts) expect(toastError).toHaveBeenCalledWith("Setup action Install deps failed (exit 1)", expect.objectContaining({ id: "action-run-r-1", duration: Infinity, closeButton: true }));
  });

  it("the message", () => {
    expect(setupFailedMessage({ actionName: "Setup", exitCode: 127 })).toBe("Setup action Setup failed (exit 127)");
  });
});

describe("openFailedRun", () => {
  it("a background run: selects the thread and shows the output", () => {
    useThreadsStore.setState({ byId: { "s-1": { id: "s-1" } as never }, order: ["s-1"] });
    openFailedRun(finished({}));
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-1" });
    expect(useActionDialogStore.getState()).toMatchObject({ runId: "r-1", runName: "Install deps" });
    useUiStore.getState().select({ kind: "view", name: "projects" });
  });

  it("a terminal run: its tab", () => {
    revealShell.mockReturnValueOnce(true);
    useActionDialogStore.setState({ runId: null });
    openFailedRun(finished({ terminalId: "t-1" }));
    expect(revealShell).toHaveBeenCalledWith("t-1");
    expect(useActionDialogStore.getState().runId).toBeNull();
  });
});

describe("ownerOfTerminal", () => {
  it.each([
    ["a thread's", { kind: "action", thread: "s-1", project: "r", worktree: "/w" }, { kind: "thread", threadId: "s-1" }],
    ["a worktree's", { kind: "action", project: "r", worktree: "/w" }, { kind: "worktree", repoId: "r", path: "/w" }],
    ["neither", { kind: "action" }, null],
  ])("%s", (_n, labels, want) => {
    expect(ownerOfTerminal(labels)).toEqual(want);
  });
});

describe("runs", () => {
  it("runAction: action.run --terminal in the owner's context, quietly; the new tab is shown", async () => {
    await expect(runAction("a-1", { kind: "worktree", repoId: "repo-cf", path: "/w" })).resolves.toBe("t-9");
    expect(runCommandForResult).toHaveBeenCalledWith("action.run", { action: "a-1", terminal: "true" }, { ctx: expect.objectContaining({ activeRepoId: "repo-cf", activeWorktreePath: "/w" }) as unknown, quiet: true });
    expect(showOwnTerminal).toHaveBeenCalledWith("t-9");
  });

  it("runAction: a failed run shows nothing", async () => {
    runCommandForResult.mockResolvedValueOnce(null);
    await expect(runAction("a-1", { kind: "thread", threadId: "s-1" })).resolves.toBeNull();
    expect(showOwnTerminal).not.toHaveBeenCalled();
  });

  it("rerunAction: runs the same action for the same owner, then closes the old tab", async () => {
    useTerminalsStore.setState({ byId: { "t-1": { id: "t-1", labels: { kind: "action", thread: "s-1", action: "a-1" } } as never }, order: ["t-1"] });
    await expect(rerunAction("t-1")).resolves.toBe("t-9");
    expect(runCommandForResult.mock.calls[0]?.[1]).toEqual({ action: "a-1", terminal: "true" });
    expect(closeBottomTerminal).toHaveBeenCalledWith("t-1");
  });

  it("rerunAction: a run that fails keeps the old tab", async () => {
    useTerminalsStore.setState({ byId: { "t-1": { id: "t-1", labels: { kind: "action", thread: "s-1", action: "a-1" } } as never }, order: ["t-1"] });
    runCommandForResult.mockResolvedValueOnce(null);
    await expect(rerunAction("t-1")).resolves.toBeNull();
    expect(closeBottomTerminal).not.toHaveBeenCalled();
  });

  it("rerunAction: a second Rerun of the same tab while one is in flight runs nothing", async () => {
    useTerminalsStore.setState({ byId: { "t-1": { id: "t-1", labels: { kind: "action", thread: "s-1", action: "a-1" } } as never }, order: ["t-1"] });
    const first = rerunAction("t-1");
    await expect(rerunAction("t-1")).resolves.toBeNull();
    await expect(first).resolves.toBe("t-9");
    expect(runCommandForResult).toHaveBeenCalledTimes(1);
    expect(closeBottomTerminal).toHaveBeenCalledTimes(1);
    // Done: the tab (were it still there) could rerun again.
    await expect(rerunAction("t-1")).resolves.toBe("t-9");
  });

  it("stopActionRun: terminal.kill, confirmed (the button is the confirmation)", async () => {
    await stopActionRun("t-1");
    expect(invokeCommand).toHaveBeenCalledWith("terminal.kill", expect.objectContaining({ activeTerminalId: "t-1" }), { id: "t-1" }, undefined, { confirmed: true });
  });

  it("stopActionRun marks the terminal stopping before the kill returns", async () => {
    useActionStopsStore.setState({ byId: {} });
    let release = () => {};
    invokeCommand.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () => {
            r({ message: "", resultJson: "" });
          };
        }),
    );
    const done = stopActionRun("t-2");
    expect(useActionStopsStore.getState().byId).toHaveProperty("t-2");
    release();
    await done;
    expect(useActionStopsStore.getState().byId).toHaveProperty("t-2");
  });

  it("a kill that fails on a running terminal goes back to Running (and toasts)", async () => {
    useActionStopsStore.setState({ byId: {} });
    useTerminalsStore.setState({ byId: { "t-3": { id: "t-3", state: "running", labels: { kind: "action" } } as never }, order: ["t-3"] });
    invokeCommand.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    await stopActionRun("t-3");
    expect(useActionStopsStore.getState().byId).not.toHaveProperty("t-3");
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});

describe("saveAction and deleteAction", () => {
  it("a new action: action.add with the project", async () => {
    await expect(saveAction({ repoId: "repo-cf" }, { name: "Lint", command: "make lint", icon: "lint", onWorktreeCreate: false })).resolves.toBeNull();
    expect(runCommandForResult.mock.calls[0]?.[0]).toBe("action.add");
    expect(runCommandForResult.mock.calls[0]?.[1]).toMatchObject({ name: "Lint", project: "repo-cf", "in-terminal": "true" });
  });

  it("an unchanged edit asks nothing", async () => {
    await expect(saveAction({ repoId: "repo-cf", actionId: "a-1" }, { name: "Test", command: "go test", icon: "test", onWorktreeCreate: false })).resolves.toBeNull();
    expect(runCommandForResult).not.toHaveBeenCalled();
  });

  it("the daemon's refusal comes back for the editor, not as a toast", async () => {
    runCommandForResult.mockImplementationOnce((_n, _a, opts) => {
      const o = opts as { onError?: (m: string) => void; expected?: (e: unknown) => boolean };
      // The daemon's text, as Connect's rawMessage has it (the store's sentinel first).
      o.onError?.('failed precondition: this project already has an action named "Test"');
      expect(o.expected?.(new Error("x"))).toBe(true);
      return Promise.resolve(null);
    });
    await expect(saveAction({ repoId: "repo-cf", actionId: "a-1" }, { name: "test", command: "go test", icon: "test", onWorktreeCreate: false })).resolves.toBe('this project already has an action named "Test"');
  });

  it("an action deleted meanwhile", async () => {
    await expect(saveAction({ repoId: "repo-cf", actionId: "a-gone" }, { name: "x", command: "y", icon: "play", onWorktreeCreate: false })).resolves.toMatch(/deleted/);
  });

  it("deleteAction: action.remove by id in the project", async () => {
    await expect(deleteAction("a-1", "repo-cf")).resolves.toBeNull();
    expect(runCommandForResult.mock.calls[0]?.slice(0, 2)).toEqual(["action.remove", { action: "a-1", project: "repo-cf" }]);
  });
});
