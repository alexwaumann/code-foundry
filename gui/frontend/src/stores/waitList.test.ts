import { Code, ConnectError } from "@connectrpc/connect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadEventView } from "@/api/thread";
import type { WakeSubscriptionView } from "@/api/wakes";

const run = vi.hoisted(() => vi.fn());
vi.mock("./commands", async (orig) => ({ ...(await orig<typeof import("./commands")>()), runCommandForResult: run }));
vi.mock("./context", () => ({ getUiContext: (target: { id: string }) => ({ activeThreadId: target.id }) }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const { applyThreadEvent } = await import("./thread");
const { stopShell } = await import("./threadActions");
const { removeWake } = await import("./waitList");
type ThreadLog = NonNullable<Parameters<typeof applyThreadEvent>[0]>;

const wake = (id: string, targetStatus = ""): WakeSubscriptionView => ({ id, kind: "timer", targetId: id, targetName: id, targetStatus, condition: "fired", note: "" });
const log = (wakes: WakeSubscriptionView[], seq = 5): ThreadLog => ({ seq, byId: {}, order: [], pending: [], mcp: null, commands: [], agents: [], wakes });
const snapshot = (wakes: WakeSubscriptionView[], seq: number): ThreadEventView => ({ kind: "snapshot", threadId: "s", seq, items: [], pending: [], mcp: null, commands: [], agents: [], wakes });

describe("the wake list on a thread's log", () => {
  it("a change has no seq: it replaces the list and leaves the log's", () => {
    const next = applyThreadEvent(log([wake("a")], 9), { kind: "wakes", threadId: "s", wakes: [wake("b")] });
    expect(next?.wakes?.map((w) => w.id)).toEqual(["b"]);
    expect(next?.seq).toBe(9);
  });

  it("before the first snapshot there is no log to put it on", () => {
    expect(applyThreadEvent(undefined, { kind: "wakes", threadId: "s", wakes: [wake("a")] })).toBeUndefined();
  });

  it("a resync's snapshot carries the list; a snapshot that says the same keeps it by identity", () => {
    const prev = log([wake("a")]);
    expect(applyThreadEvent(prev, snapshot([wake("a")], 6))?.wakes).toBe(prev.wakes);
    expect(applyThreadEvent(prev, snapshot([wake("a", "due")], 6))?.wakes?.[0]?.targetStatus).toBe("due");
  });
});

// A row can go between the press and the answer. A wake that went, or a shell that ended, is
// what was asked for: no red toast, and the press counts as done.
describe("a row gone under the press", () => {
  type Opts = { expected?: (err: unknown) => boolean };
  /** runCommandForResult failing with err: toasts unless `expected` claims it, like the real one. */
  const failWith = (err: unknown) => {
    run.mockImplementationOnce((_name: string, _args: unknown, opts: Opts) => {
      if (!opts.expected?.(err)) toast.error("failed");
      return Promise.resolve(null);
    });
  };
  const presses = [
    ["the ×", () => removeWake("s", "sub-1")],
    ["a shell's Stop", () => stopShell("s", "b1")],
  ] as const;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(presses)("%s: NotFound is done, with no toast", async (_name, press) => {
    failWith(new ConnectError("gone", Code.NotFound));
    await expect(press()).resolves.toBe(true);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each(presses)("%s: any other failure stays a failure, toasted", async (_name, press) => {
    failWith(new ConnectError("no group", Code.FailedPrecondition));
    await expect(press()).resolves.toBe(false);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
