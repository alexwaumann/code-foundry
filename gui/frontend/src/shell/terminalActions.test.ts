import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadLayoutView } from "@/api/layout";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";

/** Every command the actions ran: its name, args and the context's thread and terminal. */
const runs: { name: string; args: Record<string, string>; thread: string; terminal: string }[] = [];
const results = new Map<string, string>();
const applied: unknown[] = [];

vi.mock("@/stores/commands", () => ({
  runCommandForResult: (name: string, args: Record<string, string>, opts: { ctx?: { activeThreadId?: string; activeTerminalId?: string } } = {}) => {
    runs.push({ name, args, thread: opts.ctx?.activeThreadId ?? "", terminal: opts.ctx?.activeTerminalId ?? "" });
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
const { resetLayout } = await import("@/stores/layout");
const { useThreadsStore } = await import("@/stores/threads");
const { useUiStore } = await import("@/stores/ui");

const quick = (open: boolean): ThreadLayoutView => ({ threadId: "s-1", spaceId: "sp-a", quick: { open, height: 0 }, remembered: [], rememberedPaneId: "" });

/** Thread s-1's tab in p-1, its diff and a terminal tab in p-2, the Pull Requests page in p-2 too. */
async function seed(focusPane: string, active2 = "t-term", open = false): Promise<void> {
  const l = layoutOf([
    space(
      row("s-r", [
        pane("p-1", [tab("t-th", "thread", "s-1")]),
        pane("p-2", [tab("t-diff", "diff", "s-1"), tab("t-term", "terminal", "s-1", { params: { terminal: "term-1" }, name: "logs" }), tab("t-prs", "prs")], active2),
      ]),
      focusPane,
    ),
  ]);
  await seedLayout({ ...l, threads: [quick(open)] });
}

const names = () => runs.map((r) => [r.name, r.args]);

beforeEach(() => {
  runs.length = 0;
  applied.length = 0;
  results.clear();
  resetLayout();
  useThreadsStore.setState({ byId: { "s-1": { id: "s-1", name: "One", worktreePath: "/w", projectId: "" } }, order: ["s-1"] } as never);
});

afterEach(() => {
  resetQuickHosts();
  actions.endTabRename();
  document.body.innerHTML = "";
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
    await actions.runAgain({ id: "t-term", params: { terminal: "term-1", ran: "make dev" } }, "make dev");
    expect(runs).toEqual([{ name: "terminal.rerun", args: { id: "term-1", command: "make dev" }, thread: "", terminal: "term-1" }]);
    expect(applied).toHaveLength(1);
    expect(JSON.stringify(applied[0])).toContain('"tab":"t-term"');
    expect(JSON.stringify(applied[0])).not.toContain("make dev");
  });
});
