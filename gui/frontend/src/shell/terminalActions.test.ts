import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadLayoutView } from "@/api/layout";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";

/** Every command the actions ran: its name, args and the context's thread and terminal. */
const runs: { name: string; args: Record<string, string>; thread: string; terminal: string }[] = [];
const results = new Map<string, string>();
const applied: unknown[] = [];
/** What happens while a command runs (the user acting before its answer), by command name. */
const during = new Map<string, () => void>();

vi.mock("@/stores/commands", () => ({
  runCommandForResult: (name: string, args: Record<string, string>, opts: { ctx?: { activeThreadId?: string; activeTerminalId?: string } } = {}) => {
    runs.push({ name, args, thread: opts.ctx?.activeThreadId ?? "", terminal: opts.ctx?.activeTerminalId ?? "" });
    during.get(name)?.();
    return Promise.resolve({ message: "", resultJson: results.get(name) ?? "" });
  },
}));
vi.mock("@/api/layout", async (orig) => ({
  ...(await orig<typeof import("@/api/layout")>()),
  applyLayoutOp: (op: unknown) => {
    applied.push(op);
    return Promise.resolve({ rev: 0 });
  },
}));

const actions = await import("./terminalActions");
const { registerQuickHost, resetQuickHosts } = await import("./quickTerminal");
const { applyLayoutEvent, resetLayout, useLayoutStore } = await import("@/stores/layout");
const { resetShellView, useShellViewStore } = await import("@/stores/shellView");
const { useThreadsStore } = await import("@/stores/threads");
const { useUiStore } = await import("@/stores/ui");

const quick = (open: boolean): ThreadLayoutView => ({ threadId: "s-1", spaceId: "sp-a", quick: { open, height: 0 }, remembered: [], rememberedPaneId: "" });

/** Thread s-1's tab in p-1, its diff and a terminal tab in p-2, the Pull Requests page in p-2 too. */
async function seed(focusPane: string, active2 = "t-term", open = false): Promise<void> {
  await seedLayout(layoutAt(focusPane, active2, open));
}

/** seed's layout, to apply as a snapshot from inside a command (`during`). */
function layoutAt(focusPane: string, active2 = "t-term", open = false, termParams: Record<string, string> = { terminal: "term-1" }) {
  const l = layoutOf([
    space(
      row("s-r", [
        pane("p-1", [tab("t-th", "thread", "s-1")]),
        pane("p-2", [tab("t-diff", "diff", "s-1"), tab("t-term", "terminal", "s-1", { params: termParams, name: "logs" }), tab("t-prs", "prs")], active2),
      ]),
      focusPane,
    ),
  ]);
  return { ...l, threads: [quick(open)] };
}

/** The layout changes as a snapshot, the way the event source delivers one. */
function snapshot(l: ReturnType<typeof layoutAt>, rev: number): void {
  applyLayoutEvent({ kind: "snapshot", rev, layout: { ...l, rev }, clientId: "" });
}

const names = () => runs.map((r) => [r.name, r.args]);

beforeEach(() => {
  runs.length = 0;
  applied.length = 0;
  results.clear();
  during.clear();
  resetLayout();
  useThreadsStore.setState({ byId: { "s-1": { id: "s-1", name: "One", worktreePath: "/w", projectId: "" } }, order: ["s-1"] } as never);
});

afterEach(() => {
  resetQuickHosts();
  actions.endTabRename();
  document.body.innerHTML = "";
});

describe("a quick terminal going away under the keyboard (handBackFromQuick)", () => {
  /** The quick terminal's drawing, the keyboard in it (`keyboard`) or not. */
  const drawn = (keyboard: boolean) => {
    const box = document.createElement("div");
    box.setAttribute("data-quick-terminal", "s-1");
    const field = document.createElement("textarea");
    box.append(field);
    document.body.append(box);
    if (keyboard) field.focus();
  };
  const cases: [string, boolean, boolean, string][] = [
    ["closed (its shell exited) with the keyboard in it: the thread's prompt takes it", true, false, "p-1"],
    ["closed without the keyboard: nothing moves", false, false, ""],
    ["still open (its tab left, smart swap): nothing moves", true, true, ""],
  ];
  it.each(cases)("%s", async (_name, keyboard, open, pane) => {
    await seed("p-1", "t-term", open);
    resetShellView();
    drawn(keyboard);
    actions.handBackFromQuick("s-1");
    await Promise.resolve();
    expect(useShellViewStore.getState().focusRequest.paneId).toBe(pane);
  });
});

describe("cmd+j", () => {
  it("closed, on the thread's tab: terminal.quick opens it with the focus, and the keyboard goes in once it mounts", async () => {
    await seed("p-1");
    await actions.quickKey();
    expect(names()).toEqual([["terminal.quick", { id: "s-1", open: "true", focus: "true" }]]);
    const focus = vi.fn();
    registerQuickHost("s-1", focus);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("open, the keyboard elsewhere: only the keyboard moves", async () => {
    await seed("p-1", "t-term", true);
    const focus = vi.fn();
    registerQuickHost("s-1", focus);
    await actions.quickKey();
    expect(runs).toEqual([]);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("open, with the keyboard in it: terminal.quick closes it", async () => {
    await seed("p-1", "t-term", true);
    document.body.innerHTML = '<section data-quick-terminal="s-1"><textarea id="x"></textarea></section>';
    document.getElementById("x")?.focus();
    await actions.quickKey();
    expect(names()).toEqual([["terminal.quick", { id: "s-1", close: "true" }]]);
  });

  it("closing it hands the keyboard to the thread's prompt, unless the user went to another pane meanwhile", async () => {
    const cases: [string, string, string][] = [
      ["the thread's pane still focused: its prompt", "p-1", "p-1"],
      ["another pane focused before the answer: nothing moves", "p-2", ""],
    ];
    for (const [, focusAfter, want] of cases) {
      await seed("p-1", "t-term", true);
      resetShellView();
      document.body.innerHTML = '<section data-quick-terminal="s-1"><textarea id="x"></textarea></section>';
      document.getElementById("x")?.focus();
      during.set("terminal.quick", () => {
        snapshot(layoutAt(focusAfter, "t-term", false), 2);
      });
      await actions.quickKey();
      expect(useShellViewStore.getState().focusRequest.paneId).toBe(want);
    }
  });

  it("on a linked surface: goes to its thread and opens it", async () => {
    await seed("p-2", "t-diff");
    await actions.quickKey();
    expect(names()).toEqual([["terminal.quick", { id: "s-1", open: "true", focus: "true" }]]);
  });

  it("on a tab of no thread: nothing", async () => {
    await seed("p-2", "t-prs");
    await actions.quickKey();
    expect(runs).toEqual([]);
  });
});

describe("the other terminal keys", () => {
  it("cmd+t: terminal.new with the focused tab's thread as the context", async () => {
    await seed("p-2", "t-diff");
    await actions.newTerminalTab();
    expect(runs).toEqual([{ name: "terminal.new", args: {}, thread: "s-1", terminal: "" }]);
  });

  it("cmd+t with no thread and no checkout: a free shell", async () => {
    await seed("p-2", "t-prs");
    useUiStore.setState({ selection: { kind: "none" } });
    await actions.newTerminalTab();
    expect(names()).toEqual([["terminal.new-free", {}]]);
  });

  it("cmd+shift+t: terminal.new-free", async () => {
    await seed("p-1");
    await actions.newFreeTerminalTab();
    expect(names()).toEqual([["terminal.new-free", {}]]);
  });

  it("cmd+shift+j: terminal.cycle from the focused tab", async () => {
    await seed("p-1");
    await actions.cycleTerminals();
    expect(names()).toEqual([["terminal.cycle", { tab: "t-th", focus: "true" }]]);
  });

  it("a code block's Run in terminal: terminal.new --run with that thread", async () => {
    await seed("p-2", "t-prs");
    await actions.runInLinkedTerminal("s-1", "make test");
    expect(runs).toEqual([{ name: "terminal.new", args: { run: "make test" }, thread: "s-1", terminal: "" }]);
  });
});

describe("cmd+r and cmd+shift+r", () => {
  it("on a terminal tab: its name field, then the automatic name through tab.rename --auto", async () => {
    await seed("p-2", "t-term");
    actions.renameFocusedTab();
    expect(actions.useTabRenameStore.getState().tabId).toBe("t-term");
    expect(runs).toEqual([]);
    actions.autoNameFocusedTab();
    expect(names()).toEqual([["tab.rename", { tab: "t-term", auto: "true" }]]);
  });

  it("on a thread's tab: today's rename, and the name generated again", async () => {
    await seed("p-1");
    useUiStore.setState({ sidebarVisible: true, renamingThreadId: null } as never);
    actions.renameFocusedTab();
    expect(useUiStore.getState().renamingThreadId).toBe("s-1");
    expect(actions.useTabRenameStore.getState().tabId).toBe("");
    actions.autoNameFocusedTab();
    expect(names()).toEqual([["thread.regenerate-name", { id: "s-1" }]]);
  });

  it("on another tab: nothing", async () => {
    await seed("p-2", "t-prs");
    actions.renameFocusedTab();
    actions.autoNameFocusedTab();
    expect(runs).toEqual([]);
    expect(actions.useTabRenameStore.getState().tabId).toBe("");
  });
});

describe("Reset and Run again", () => {
  it("Reset runs terminal.reset on that terminal", async () => {
    await actions.resetTerminal("term-1");
    expect(runs).toEqual([{ name: "terminal.reset", args: { id: "term-1" }, thread: "", terminal: "term-1" }]);
  });

  it("Run again types the restored command, then the tab forgets it", async () => {
    await seedLayout(layoutAt("p-2", "t-term", false, { terminal: "term-1", ran: "make dev" }));
    await actions.runAgain({ id: "t-term", params: { terminal: "term-1", ran: "make dev" } }, "make dev");
    expect(runs).toEqual([{ name: "terminal.rerun", args: { id: "term-1", command: "make dev" }, thread: "", terminal: "term-1" }]);
    expect(applied).toHaveLength(1);
    expect(JSON.stringify(applied[0])).toContain('"tab":"t-term"');
    expect(JSON.stringify(applied[0])).not.toContain("make dev");
  });

  it("Run again writes the tab's params as they are once it ran, and keeps the line when a Reset replaced the shell", async () => {
    const restored = { terminal: "term-1", ran: "make dev" };
    // A rename of the line's tab meanwhile (another param): kept, the line dropped.
    await seedLayout(layoutAt("p-2", "t-term", false, restored));
    during.set("terminal.rerun", () => {
      snapshot(layoutAt("p-2", "t-term", false, { ...restored, cwd: "/w/sub" }), 2);
    });
    await actions.runAgain({ id: "t-term", params: restored }, "make dev");
    expect(applied).toEqual([{ op: "set_tab_params", tab: "t-term", params: { terminal: "term-1", cwd: "/w/sub" } }]);

    // A Reset meanwhile: the tab shows a new shell, which never ran it; nothing is written.
    applied.length = 0;
    await seedLayout({ ...layoutAt("p-2", "t-term", false, restored), rev: 3 });
    during.set("terminal.rerun", () => {
      snapshot(layoutAt("p-2", "t-term", false, { terminal: "term-2", ran: "make dev" }), 4);
    });
    await actions.runAgain({ id: "t-term", params: restored }, "make dev");
    expect(applied).toEqual([]);
    expect(useLayoutStore.getState().tabs["t-term"]?.params).toEqual({ terminal: "term-2", ran: "make dev" });
  });
});
