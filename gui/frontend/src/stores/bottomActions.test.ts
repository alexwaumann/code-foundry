import { Code, ConnectError } from "@connectrpc/connect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalView } from "@/api/terminal";

const commands = vi.hoisted(() => ({
  invokeConfirmed: vi.fn(),
  runCommandForResult: vi.fn(),
  refreshCommands: vi.fn(),
}));
vi.mock("./commands", async (importOriginal) => ({ ...(await importOriginal<typeof import("./commands")>()), ...commands }));
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

const { closeBottomTerminal, newBottomTerminal, newThreadTerminal, onNewTerminal, onRemovedTerminal, paneContext, revealShell } = await import("./bottomActions");
const { getBottom, markPendingFocus, useBottomStore } = await import("./bottomPanel");
const { usePanelStore } = await import("./panel");
const { useTerminalsStore } = await import("./terminals");
const { useUiStore } = await import("./ui");
const { useViewsStore } = await import("./views");

function term(id: string, labels: Record<string, string>, extra: Partial<TerminalView> = {}): TerminalView {
  return { id, argv: ["/bin/zsh"], cwd: "/src/app", cols: 80, rows: 24, title: "", state: "running", exitCode: 0, startedAtMs: null, exitedAtMs: null, altScreen: false, labels, ...extra };
}
const shell = (session: string, worktree = "/src/app") => ({ kind: "shell", repo: "r1", worktree, ...(session ? { session } : {}) });

function setTerminals(list: TerminalView[]): void {
  useTerminalsStore.setState({ byId: Object.fromEntries(list.map((t) => [t.id, t])), order: list.map((t) => t.id), loaded: true });
}

const closedPalette = { open: false, query: "", commandName: null, page: "commands" as const, returnTo: "content" as const };

beforeEach(() => {
  vi.clearAllMocks();
  commands.runCommandForResult.mockResolvedValue({ message: "created terminal t-new", resultJson: JSON.stringify({ id: "t-new" }) });
  commands.invokeConfirmed.mockResolvedValue({ message: "", resultJson: "" });
  useBottomStore.setState({ byKey: {}, pendingFocus: null, pendingFocusId: null });
  usePanelStore.setState({ byKey: {} });
  useViewsStore.setState({ settingsOpen: false, usageOpen: false, helpOpen: false });
  useUiStore.setState({ selection: { kind: "session", id: "s1" }, focus: "terminal", bottomFocusSeq: 0, palette: closedPalette });
  setTerminals([term("claude", { session: "s1" }), term("a", shell("s1")), term("w", shell("", "/src/app.worktrees/x"))]);
});

describe("onNewTerminal", () => {
  it("opens the owner's panel with the shell active, without focus when nobody asked", () => {
    onNewTerminal(term("b", shell("s2")));
    expect(getBottom("session:s2")).toEqual({ open: true, activeTerminalId: "b" });
    expect(getBottom("session:s1").open).toBe(false);
    expect(useUiStore.getState().bottomFocusSeq).toBe(0);
  });

  it("a worktree's shell opens the Projects page's panel", () => {
    onNewTerminal(term("w2", shell("")));
    expect(getBottom("view:projects")).toEqual({ open: true, activeTerminalId: "w2" });
  });

  const ignored: [string, TerminalView][] = [
    ["a Claude terminal", term("c2", { session: "s1" })],
    ["an unlabelled terminal", term("loose", {})],
    ["an exited shell", term("gone", shell("s1"), { state: "exited" })],
  ];
  it.each(ignored)("ignores %s", (_name, t) => {
    onNewTerminal(t);
    expect(useBottomStore.getState().byKey).toEqual({});
  });

  const focus: [string, string, string, number][] = [
    ["this window started it for the selected key: focus", "session:s1", "s1", 1],
    ["started for another key: no focus", "session:s2", "s1", 0],
    ["started for this key but another is selected now: no focus", "session:s1", "s3", 0],
  ];
  it.each(focus)("%s", (_name, pending, selected, want) => {
    markPendingFocus(pending);
    useUiStore.setState({ selection: { kind: "session", id: selected } });
    onNewTerminal(term("b", shell("s1")));
    expect(useUiStore.getState().bottomFocusSeq).toBe(want);
    expect(getBottom("session:s1").activeTerminalId).toBe("b");
  });

  it("the pending focus is used once", () => {
    markPendingFocus("session:s1");
    onNewTerminal(term("b", shell("s1")));
    onNewTerminal(term("c", shell("s1")));
    expect(useUiStore.getState().bottomFocusSeq).toBe(1);
  });

  it("with the palette open, its return target moves to the panel instead", () => {
    markPendingFocus("session:s1");
    useUiStore.setState({ palette: { ...closedPalette, open: true, returnTo: "terminal" } });
    onNewTerminal(term("b", shell("s1")));
    expect(useUiStore.getState().palette.returnTo).toBe("bottom");
    expect(useUiStore.getState().bottomFocusSeq).toBe(0);
  });
});

describe("revealShell (focusTerminal)", () => {
  it("a thread's shell: selects the thread, opens its panel on the shell, focuses it", () => {
    useUiStore.setState({ selection: { kind: "view", name: "pullrequests" } });
    useViewsStore.setState({ settingsOpen: true });
    usePanelStore.setState({ byKey: { "session:s1": { open: true, tabs: [], activeTabId: null, expanded: true } } });
    expect(revealShell("a")).toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "s1" });
    expect(getBottom("session:s1")).toEqual({ open: true, activeTerminalId: "a" });
    expect(useUiStore.getState().bottomFocusSeq).toBe(1);
    expect(useViewsStore.getState().settingsOpen).toBe(false);
    expect(usePanelStore.getState().byKey["session:s1"]?.expanded).toBeUndefined();
  });

  it("a worktree's shell: the Projects page", () => {
    expect(revealShell("w")).toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "view", name: "projects" });
    expect(getBottom("view:projects")).toEqual({ open: true, activeTerminalId: "w" });
  });

  it("not a shell: false, nothing changes", () => {
    expect(revealShell("claude")).toBe(false);
    expect(useBottomStore.getState().byKey).toEqual({});
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "s1" });
  });

  it("an unknown terminal is revealed when it arrives as a shell", () => {
    expect(revealShell("later")).toBe(false);
    useUiStore.setState({ selection: { kind: "view", name: "dashboard" } });
    // The events handler adds the terminal to the store, then calls onNewTerminal.
    const later = term("later", shell("s2"));
    setTerminals([later]);
    onNewTerminal(later);
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "s2" });
    expect(getBottom("session:s2")).toEqual({ open: true, activeTerminalId: "later" });
    expect(useUiStore.getState().bottomFocusSeq).toBe(1);
  });
});

describe("paneContext and newBottomTerminal", () => {
  it("a thread's panel runs in the thread's context", () => {
    expect(paneContext("session:s1")).toMatchObject({ activeSessionId: "s1", activeView: "session" });
  });

  it("the Projects page's panel runs in its active tab's worktree, or nowhere without tabs", () => {
    expect(paneContext("view:projects")).toMatchObject({ activeRepoId: "r1", activeWorktreePath: "/src/app.worktrees/x", activeSessionId: "" });
    setTerminals([]);
    expect(paneContext("view:projects")).toBeNull();
    expect(paneContext("view:pullrequests")).toBeNull();
  });

  it("newBottomTerminal runs terminal.new there; no context, no run", async () => {
    expect(await newBottomTerminal("session:s1")).toBe(true);
    expect(commands.runCommandForResult).toHaveBeenCalledWith("terminal.new", {}, { ctx: expect.objectContaining({ activeSessionId: "s1" }) as unknown });
    commands.runCommandForResult.mockClear();
    setTerminals([]);
    expect(await newBottomTerminal("view:projects")).toBe(false);
    expect(commands.runCommandForResult).not.toHaveBeenCalled();
  });
});

describe("focus for this window's own shells (by id)", () => {
  it("a shell that arrives after the result takes focus then", async () => {
    await newBottomTerminal("session:s1");
    expect(useBottomStore.getState().pendingFocusId?.id).toBe("t-new");
    expect(useUiStore.getState().bottomFocusSeq).toBe(0);
    const t = term("t-new", shell("s1"));
    setTerminals([term("a", shell("s1")), t]);
    onNewTerminal(t);
    expect(getBottom("session:s1")).toEqual({ open: true, activeTerminalId: "t-new" });
    expect(useUiStore.getState().bottomFocusSeq).toBe(1);
    expect(useBottomStore.getState().pendingFocusId).toBeNull();
  });

  it("a shell that arrived before the result (while the keyboard was in the panel) is activated and focused by the result", async () => {
    useBottomStore.setState({ byKey: { "session:s1": { open: true } } });
    useUiStore.setState({ focus: "bottom" });
    const t = term("t-new", shell("s1"));
    setTerminals([term("a", shell("s1")), t]);
    onNewTerminal(t);
    expect(getBottom("session:s1").activeTerminalId).toBe("a");
    await newBottomTerminal("session:s1");
    expect(getBottom("session:s1").activeTerminalId).toBe("t-new");
    expect(useUiStore.getState().bottomFocusSeq).toBe(1);
  });

  it("a shell for a thread that is not selected opens there without focus", async () => {
    commands.runCommandForResult.mockResolvedValue({ message: "", resultJson: JSON.stringify({ id: "t-b" }) });
    await newThreadTerminal("s2");
    const t = term("t-b", shell("s2"));
    setTerminals([t]);
    onNewTerminal(t);
    expect(getBottom("session:s2")).toEqual({ open: true, activeTerminalId: "t-b" });
    expect(useUiStore.getState().bottomFocusSeq).toBe(0);
  });

  it.each<[string, string | undefined, Record<string, string>]>([
    ["the row menu: the thread's worktree", undefined, {}],
    ["a workspace member in the thread's panel: that member's worktree", "/src/api.worktrees/x", { cwd: "/src/api.worktrees/x" }],
  ])("newThreadTerminal from %s runs in the thread's context", async (_name, cwd, args) => {
    await newThreadTerminal("s2", cwd);
    expect(commands.runCommandForResult).toHaveBeenCalledWith("terminal.new", args, { ctx: expect.objectContaining({ activeSessionId: "s2", activeView: "session" }) as unknown });
  });

  it("a failed run leaves nothing pending", async () => {
    commands.runCommandForResult.mockResolvedValue(null);
    expect(await newBottomTerminal("session:s1")).toBe(false);
    expect(useBottomStore.getState().pendingFocusId).toBeNull();
    expect(useBottomStore.getState().pendingFocus).toBeNull();
  });
});

describe("a shell this window did not start", () => {
  it("while the keyboard is in that panel: gets a tab, the active one stays", () => {
    useBottomStore.setState({ byKey: { "session:s1": { open: true } } });
    useUiStore.setState({ focus: "bottom" });
    const t = term("b", shell("s1"));
    setTerminals([term("a", shell("s1")), t]);
    onNewTerminal(t);
    expect(getBottom("session:s1")).toEqual({ open: true, activeTerminalId: "a" });
    expect(useUiStore.getState().bottomFocusSeq).toBe(0);
  });

  const activates: [string, () => void][] = [
    ["the keyboard elsewhere", () => useBottomStore.setState({ byKey: { "session:s1": { open: true } } })],
    ["the panel hidden", () => useUiStore.setState({ focus: "bottom" })],
    ["the settings page up", () => {
      useBottomStore.setState({ byKey: { "session:s1": { open: true } } });
      useUiStore.setState({ focus: "bottom" });
      useViewsStore.setState({ settingsOpen: true });
    }],
  ];
  it.each(activates)("with %s: becomes active", (_name, arrange) => {
    arrange();
    const t = term("b", shell("s1"));
    setTerminals([term("a", shell("s1")), t]);
    onNewTerminal(t);
    expect(getBottom("session:s1").activeTerminalId).toBe("b");
    expect(useUiStore.getState().bottomFocusSeq).toBe(0);
  });
});

describe("onRemovedTerminal", () => {
  const before = (ids: string[]) => ({ byId: Object.fromEntries(ids.map((id) => [id, term(id, shell("s1"))])), order: ids });
  const cases: [string, string | undefined, string, string | undefined][] = [
    ["the active middle tab: the one after it", "b", "b", "c"],
    ["the active last tab: the one before it", "c", "c", "b"],
    ["the active tab by fallback (none remembered): the one before it", undefined, "c", "b"],
    ["another tab: the active one stays", "a", "b", "a"],
  ];
  it.each(cases)("%s", (_name, remembered, removed, want) => {
    useBottomStore.setState({ byKey: { "session:s1": remembered === undefined ? { open: true } : { open: true, activeTerminalId: remembered } } });
    onRemovedTerminal(term(removed, shell("s1")), before(["a", "b", "c"]));
    expect(getBottom("session:s1").activeTerminalId).toBe(want);
  });
});

describe("closeBottomTerminal", () => {
  it("runs terminal.close with --id and that terminal as the active one", async () => {
    await closeBottomTerminal("a");
    expect(commands.invokeConfirmed).toHaveBeenCalledWith("terminal.close", { id: "a" }, expect.objectContaining({ activeTerminalId: "a", activeSessionId: "s1" }));
    expect(toastError).not.toHaveBeenCalled();
  });

  const errors: [string, unknown, boolean, boolean][] = [
    ["NotFound is no error", new ConnectError("gone", Code.NotFound), true, false],
    ["any error once the terminal is gone is no error", new ConnectError("not a shell", Code.FailedPrecondition), false, false],
    ["another error while it is still there is toasted", new ConnectError("boom", Code.Internal), true, true],
  ];
  it.each(errors)("%s", async (_name, err, stillThere, toasted) => {
    commands.invokeConfirmed.mockRejectedValue(err);
    if (!stillThere) setTerminals([]);
    await closeBottomTerminal("a");
    expect(toastError).toHaveBeenCalledTimes(toasted ? 1 : 0);
  });
});
