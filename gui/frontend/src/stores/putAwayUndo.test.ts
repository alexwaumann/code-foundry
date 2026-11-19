import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmationView } from "@/api/command";
import type { ThreadView } from "@/api/threads";
import type { Notice } from "@/lib/notify";

const invokeCommand = vi.hoisted(() => vi.fn());
class NeedsConfirm extends Error {
  constructor(readonly confirm: ConfirmationView) {
    super(confirm.message);
  }
}
vi.mock("@/api/command", async (orig) => ({
  ...(await orig<typeof import("@/api/command")>()),
  invokeCommand,
  confirmationOf: (err: unknown) => (err instanceof NeedsConfirm ? err.confirm : null),
}));
const applyLayoutOp = vi.hoisted(() => vi.fn(() => Promise.resolve({ rev: 0 })));
vi.mock("@/api/layout", async (orig) => ({ ...(await orig<typeof import("@/api/layout")>()), applyLayoutOp }));
const notify = vi.hoisted(() => vi.fn<(n: Notice) => string>(() => "id"));
const dismissNotice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify, notifyProgress: vi.fn(), dismissNotice }));

const { dismissUndo, putAwayOf, runUndo, startPutAwayUndo, UNDO_TOAST_ID, undoDescription, undoShowing, undoTitle } = await import("./putAwayUndo");
const { archiveThread, saveThreadForLater, snoozeThread } = await import("./threadActions");
const { archiveThreads, snoozeThreads } = await import("./bulkThreadActions");
const { runCommandForResult } = await import("./commands");
const { answerConfirm, useConfirmStore } = await import("./confirm");
const { useThreadsStore } = await import("./threads");
const { resetLayout } = await import("./layout");
const { handleKeyDown } = await import("@/keys/bindings");
const { layoutOf, pane, row, seedLayout, space, tab } = await import("@/test/shellLayout");

// Wednesday 2026-11-18, 2:12 PM local.
const NOW = new Date(2026, 10, 18, 14, 12).getTime();
const TOMORROW_9 = new Date(2026, 10, 19, 9, 0).getTime();
const ctx = { activeTerminalId: "", activeThreadId: "s-1", activeProjectId: "", activeWorktreePath: "", activeView: "", activeWorkspaceId: "" };

function thread(id: string, name: string, archived = false): ThreadView {
  return { id, name, projectId: "", worktreePath: "", workspaceId: "", archivedAtMs: archived ? 1 : null, snoozedUntilMs: null } as unknown as ThreadView;
}

/** The undo toasts shown so far. */
const undoToasts = () => notify.mock.calls.map((c) => c[0]).filter((n) => n.id === UNDO_TOAST_ID);
/** The last undo toast shown. */
function lastUndo(): Notice {
  const n = undoToasts().at(-1);
  if (!n) throw new Error("no undo toast");
  return n;
}
/** The commands invoked, as name + args. */
const invoked = () => invokeCommand.mock.calls.map((c) => ({ name: c[0] as string, args: c[2] as Record<string, string> }));

let stop: () => void = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  invokeCommand.mockResolvedValue({ message: "done", resultJson: "" });
  useThreadsStore.setState({ byId: { "s-1": thread("s-1", "Fix the login bug"), "s-2": thread("s-2", "Write docs"), "s-3": thread("s-3", "") }, order: ["s-1", "s-2", "s-3"] });
  resetLayout();
  stop = startPutAwayUndo();
});

afterEach(() => {
  dismissUndo();
  stop();
  vi.useRealTimers();
});

describe("putAwayOf", () => {
  const archived = (id: string) => id === "s-9";
  it.each([
    { name: "a snooze until a time", cmd: "thread.snooze", args: { until: new Date(TOMORROW_9).toISOString() }, want: { kind: "snooze", ids: ["s-1"], untilMs: TOMORROW_9 } },
    { name: "save for later", cmd: "thread.snooze", args: { save: "true" }, want: { kind: "save", ids: ["s-1"], untilMs: null } },
    { name: "a snooze of several", cmd: "thread.snooze", args: { ids: "s-1, s-2", until: new Date(TOMORROW_9).toISOString() }, want: { kind: "snooze", ids: ["s-1", "s-2"], untilMs: TOMORROW_9 } },
    { name: "a snooze given an id", cmd: "thread.snooze", args: { id: "s-2", save: "true" }, want: { kind: "save", ids: ["s-2"], untilMs: null } },
    { name: "a snooze to a time it cannot read", cmd: "thread.snooze", args: { until: "after the meeting" }, want: { kind: "snooze", ids: ["s-1"], untilMs: null } },
    { name: "an unsnooze", cmd: "thread.snooze", args: { clear: "true" }, want: null },
    { name: "an archive", cmd: "thread.archive", args: { archived: "true" }, want: { kind: "archive", ids: ["s-1"], untilMs: null } },
    { name: "the archive toggle on a thread not archived", cmd: "thread.archive", args: {}, want: { kind: "archive", ids: ["s-1"], untilMs: null } },
    { name: "the archive toggle on an archived thread (an unarchive)", cmd: "thread.archive", args: { id: "s-9" }, want: null },
    { name: "the archive toggle on several archives", cmd: "thread.archive", args: { ids: "s-9,s-2" }, want: { kind: "archive", ids: ["s-9", "s-2"], untilMs: null } },
    { name: "an unarchive", cmd: "thread.archive", args: { archived: "false" }, want: null },
    { name: "an archive of the threads below one", cmd: "thread.archive", args: { "descendants-of": "s-1" }, want: null },
    { name: "another command", cmd: "thread.pin", args: { pinned: "true" }, want: null },
  ])("$name", ({ cmd, args, want }) => {
    expect(putAwayOf(cmd, args as Record<string, string>, ctx, archived)).toEqual(want);
  });

  it("is nothing without a thread", () => {
    expect(putAwayOf("thread.archive", { archived: "true" }, { ...ctx, activeThreadId: "" })).toBeNull();
  });
});

describe("the toast's words", () => {
  it.each([
    { name: "a snooze until tomorrow", p: { kind: "snooze", ids: ["a"], untilMs: TOMORROW_9 }, want: "Snoozed until tomorrow, 9:00 AM" },
    { name: "a snooze later today", p: { kind: "snooze", ids: ["a"], untilMs: NOW + 3_600_000 }, want: "Snoozed until 3:12 PM" },
    { name: "a snooze of three until tomorrow", p: { kind: "snooze", ids: ["a", "b", "c"], untilMs: TOMORROW_9 }, want: "Snoozed 3 threads until tomorrow, 9:00 AM" },
    { name: "a snooze to a time it cannot tell", p: { kind: "snooze", ids: ["a"], untilMs: null }, want: "Snoozed" },
    { name: "save for later", p: { kind: "save", ids: ["a"], untilMs: null }, want: "Saved for later" },
    { name: "save two for later", p: { kind: "save", ids: ["a", "b"], untilMs: null }, want: "Saved 2 threads for later" },
    { name: "an archive", p: { kind: "archive", ids: ["a"], untilMs: null }, want: "Archived" },
    { name: "an archive of three", p: { kind: "archive", ids: ["a", "b", "c"], untilMs: null }, want: "Archived 3 threads" },
  ] as const)("title: $name", ({ p, want }) => {
    expect(undoTitle({ ...p, ids: [...p.ids] }, NOW)).toBe(want);
  });

  it.each([
    [["Fix the login bug"], "Fix the login bug"],
    [["a", "b"], "a and b"],
    [["a", "b", "c"], "a, b and 1 more"],
    [["a", "b", "c", "d", "e"], "a, b and 3 more"],
  ])("description of %j: %s", (names, want) => {
    expect(undoDescription(names)).toBe(want);
  });
});

describe("after a put-away from this window", () => {
  it("shows one neutral toast bottom left, with Undo and its chord, a close button and 5 seconds, in place of the success toast", async () => {
    await snoozeThread("s-1", TOMORROW_9);
    expect(notify).toHaveBeenCalledTimes(1);
    const n = lastUndo();
    expect(n).toMatchObject({ level: "neutral", position: "bottom-left", title: "Snoozed until tomorrow, 9:00 AM", closable: true, duration: 5000 });
    expect(n.action).toMatchObject({ label: "Undo", chord: "cmd+z" });
    expect(undoShowing()).toBe(true);
  });

  it.each([
    { name: "save for later", run: () => saveThreadForLater("s-1"), title: "Saved for later" },
    { name: "an archive from a row's button", run: () => archiveThread("s-1", true, { inView: true }), title: "Archived" },
    { name: "the bulk menu's archive", run: () => archiveThreads(["s-1", "s-2", "s-3"], true), title: "Archived 3 threads" },
    { name: "the bulk menu's snooze", run: () => snoozeThreads(["s-1", "s-2"], TOMORROW_9), title: "Snoozed 2 threads until tomorrow, 9:00 AM" },
    { name: "a key or the palette (the toggle)", run: () => runCommandForResult("thread.archive", {}, { ctx }), title: "Archived" },
  ])("$name: $title", async ({ run, title }) => {
    await run();
    expect(lastUndo().title).toBe(title);
    expect(notify.mock.calls.filter((c) => c[0].level === "success")).toHaveLength(0);
  });

  it("names the thread, or the first two and how many more (a thread without a name by its id)", async () => {
    await snoozeThread("s-3", TOMORROW_9);
    expect(lastUndo().description).toMatchObject({ props: { children: "s-3" } });
    await archiveThreads(["s-1", "s-2", "s-3"], true);
    expect(lastUndo().description).toMatchObject({ props: { children: "Fix the login bug, Write docs and 1 more" } });
  });

  it.each([
    { name: "a failure", run: async () => {
      invokeCommand.mockRejectedValueOnce(new Error("thread s-1 is resident"));
      await snoozeThread("s-1", TOMORROW_9);
    } },
    { name: "a declined confirmation", run: async () => {
      invokeCommand.mockRejectedValueOnce(new NeedsConfirm({ command: "thread.archive", title: "Archive", message: "Claude is still working" }));
      const done = archiveThread("s-1", true);
      await vi.waitFor(() => {
        expect(useConfirmStore.getState().pending).not.toBeNull();
      });
      answerConfirm(false);
      await done;
    } },
    { name: "an unsnooze", run: () => snoozeThread("s-1", null) },
    { name: "an unarchive", run: () => archiveThread("s-1", false) },
    { name: "a plugin's put-away", run: () => runCommandForResult("thread.archive", { archived: "true" }, { ctx, caller: "a plugin" }) },
  ])("shows no undo toast for $name", async ({ run }) => {
    await run();
    expect(undoToasts()).toHaveLength(0);
    expect(undoShowing()).toBe(false);
  });

  it("closing it (its timer, its X) leaves nothing to undo", async () => {
    await snoozeThread("s-1", TOMORROW_9);
    lastUndo().onClose?.();
    expect(undoShowing()).toBe(false);
    expect(runUndo()).toBe(false);
  });
});

describe("Undo", () => {
  it("unsnoozes the thread", async () => {
    await snoozeThread("s-1", TOMORROW_9);
    invokeCommand.mockClear();
    lastUndo().action?.onClick();
    await vi.waitFor(() => {
      expect(invoked()).toContainEqual({ name: "thread.snooze", args: { clear: "true", id: "s-1" } });
    });
    expect(dismissNotice).toHaveBeenCalledWith(UNDO_TOAST_ID);
    expect(undoShowing()).toBe(false);
    expect(undoToasts()).toHaveLength(1);
  });

  it("unarchives several with ids", async () => {
    await archiveThreads(["s-1", "s-2"], true);
    invokeCommand.mockClear();
    expect(runUndo()).toBe(true);
    await vi.waitFor(() => {
      expect(invoked()).toEqual([{ name: "thread.archive", args: { archived: "false", ids: "s-1,s-2" } }]);
    });
  });

  it("a newer put-away replaces the toast (the same id) and its Undo undoes only the newer", async () => {
    await snoozeThread("s-1", TOMORROW_9);
    await saveThreadForLater("s-2");
    expect(new Set(undoToasts().map((n) => n.id))).toEqual(new Set([UNDO_TOAST_ID]));
    expect(lastUndo().title).toBe("Saved for later");
    // The first toast's close does not end the second's.
    undoToasts()[0]?.onClose?.();
    invokeCommand.mockClear();
    expect(runUndo()).toBe(true);
    await vi.waitFor(() => {
      expect(invoked()).toEqual([{ name: "thread.snooze", args: { clear: "true", id: "s-2" } }]);
    });
  });

  it("gives a woken thread's tab the focus back when it had it, once the daemon has put it back", async () => {
    await seedLayout(layoutOf([space(row("r", [pane("p-1", [tab("t-1", "thread", "s-1")]), pane("p-2", [tab("t-2", "thread", "s-2")])]), "p-1")]));
    await snoozeThread("s-1", TOMORROW_9);
    await seedLayout(layoutOf([space(row("r", [pane("p-1", [tab("t-c", "compose")]), pane("p-2", [tab("t-2", "thread", "s-2")])]), "p-1")], 2));
    invokeCommand.mockClear();
    runUndo();
    await vi.waitFor(() => {
      expect(invoked()).toContainEqual({ name: "thread.snooze", args: { clear: "true", id: "s-1" } });
    });
    expect(invoked().some((c) => c.name === "tab.focus")).toBe(false);
    await seedLayout(layoutOf([space(row("r", [pane("p-1", [tab("t-9", "thread", "s-1")]), pane("p-2", [tab("t-2", "thread", "s-2")])]), "p-1")], 3));
    await vi.waitFor(() => {
      expect(invoked()).toContainEqual({ name: "tab.focus", args: { tab: "t-9", focus: "true" } });
    });
  });

  it("leaves the focus alone when the thread's tab did not have it", async () => {
    await seedLayout(layoutOf([space(row("r", [pane("p-1", [tab("t-1", "thread", "s-1")]), pane("p-2", [tab("t-2", "thread", "s-2")])]), "p-2")]));
    await snoozeThread("s-1", TOMORROW_9);
    invokeCommand.mockClear();
    runUndo();
    await vi.waitFor(() => {
      expect(invoked()).toEqual([{ name: "thread.snooze", args: { clear: "true", id: "s-1" } }]);
    });
  });

  it("opens an unarchived thread's tab in place of the untouched New thread tab the archive left, with the focus it had", async () => {
    await seedLayout(layoutOf([space(pane("p-1", [tab("t-1", "thread", "s-1")]), "p-1")]));
    await archiveThread("s-1", true);
    await seedLayout(layoutOf([space(pane("p-1", [tab("t-c", "compose")]), "p-1")], 2));
    runUndo();
    await vi.waitFor(() => {
      expect(applyLayoutOp).toHaveBeenCalledWith({ op: "open_thread", thread: "s-1", compose: "t-c", focus: true });
    });
    expect(invoked()).toContainEqual({ name: "thread.archive", args: { archived: "false", id: "s-1" } });
  });

  it("opens it beside the composer once the user typed in it (a draft), at its old place", async () => {
    await seedLayout(layoutOf([space(pane("p-1", [tab("t-0", "prs"), tab("t-1", "thread", "s-1")], "t-0"), "p-2")]));
    await archiveThread("s-1", true);
    await seedLayout(layoutOf([space(pane("p-1", [tab("t-0", "prs"), tab("t-c", "compose", "", { params: { draft: "d-1" } })], "t-0"), "p-1")], 2));
    invokeCommand.mockClear();
    runUndo();
    await vi.waitFor(() => {
      expect(invoked()).toContainEqual({ name: "thread.open", args: { id: "s-1", pane: "p-1", index: "1" } });
    });
    expect(applyLayoutOp).not.toHaveBeenCalled();
  });

  it("leaves an unarchived thread closed when its tab was not open", async () => {
    await archiveThread("s-1", true);
    invokeCommand.mockClear();
    runUndo();
    await vi.waitFor(() => {
      expect(invoked()).toEqual([{ name: "thread.archive", args: { archived: "false", id: "s-1" } }]);
    });
  });
});

describe("keys while an undo toast shows", () => {
  function press(key: string, meta: boolean, target: Element): KeyboardEvent {
    const e = new KeyboardEvent("keydown", { key, metaKey: meta, bubbles: true, cancelable: true });
    Object.defineProperty(e, "target", { value: target });
    handleKeyDown(e);
    return e;
  }

  function field(): HTMLTextAreaElement {
    document.body.innerHTML = `<div data-region="content"><div data-chord-yield><textarea></textarea></div></div>`;
    const el = document.querySelector("textarea");
    if (!el) throw new Error("no field");
    el.focus();
    return el;
  }

  it("cmd+z runs Undo, from a focused prompt too", async () => {
    await snoozeThread("s-1", TOMORROW_9);
    invokeCommand.mockClear();
    const e = press("z", true, field());
    expect(e.defaultPrevented).toBe(true);
    expect(undoShowing()).toBe(false);
    await vi.waitFor(() => {
      expect(invoked()).toContainEqual({ name: "thread.snooze", args: { clear: "true", id: "s-1" } });
    });
  });

  it("Escape closes it without undoing", async () => {
    await archiveThread("s-1", true);
    invokeCommand.mockClear();
    const e = press("Escape", false, field());
    expect(e.defaultPrevented).toBe(true);
    expect(dismissNotice).toHaveBeenCalledWith(UNDO_TOAST_ID);
    expect(undoShowing()).toBe(false);
    expect(invoked()).toEqual([]);
  });

  it("with no undo toast, cmd+z and Escape are left to the field", () => {
    const el = field();
    expect(press("z", true, el).defaultPrevented).toBe(false);
    expect(press("Escape", false, el).defaultPrevented).toBe(false);
    expect(invoked()).toEqual([]);
  });

  it("with no undo toast, cmd+z outside a field does nothing of the toast's", () => {
    document.body.innerHTML = `<div data-region="content"><button>x</button></div>`;
    const b = document.querySelector("button");
    if (!b) throw new Error("no button");
    press("z", true, b);
    expect(dismissNotice).not.toHaveBeenCalled();
    expect(invoked().filter((c) => c.name.startsWith("thread."))).toEqual([]);
  });
});
