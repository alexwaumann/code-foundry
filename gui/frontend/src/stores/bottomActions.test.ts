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
const writeTerminal = vi.hoisted(() => vi.fn());
vi.mock("@/api/terminal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/api/terminal")>()), writeTerminal }));

const { closeBottomTerminal, closeEmptyPanels, newBottomTerminal, newThreadTerminal, onNewTerminal, onRemovedTerminal, openBottomShell, paneContext, revealShell, runInThreadTerminal, toggleBottomFromHere } =
  await import("./bottomActions");
const { getBottom, markPendingFocus, markStarting, useBottomStore } = await import("./bottomPanel");
const { usePanelStore } = await import("./panel");
const { useTerminalsStore } = await import("./terminals");
const { useUiStore } = await import("./ui");
const { useViewsStore } = await import("./views");

function term(id: string, labels: Record<string, string>, extra: Partial<TerminalView> = {}): TerminalView {
  return { id, argv: ["/bin/zsh"], cwd: "/src/app", cols: 80, rows: 24, title: "", state: "running", exitCode: 0, startedAtMs: null, exitedAtMs: null, altScreen: false, labels, ...extra };
}
const shell = (thread: string, worktree = "/src/app") => ({ kind: "shell", project: "r1", worktree, ...(thread ? { thread } : {}) });

function setTerminals(list: TerminalView[]): void {
  useTerminalsStore.setState({ byId: Object.fromEntries(list.map((t) => [t.id, t])), order: list.map((t) => t.id), loaded: true });
}

const closedPalette = { open: false, query: "", commandName: null, page: "commands" as const, returnTo: "content" as const };

beforeEach(() => {
  vi.clearAllMocks();
  commands.runCommandForResult.mockResolvedValue({ message: "created terminal t-new", resultJson: JSON.stringify({ id: "t-new" }) });
  commands.invokeConfirmed.mockResolvedValue({ message: "", resultJson: "" });
  writeTerminal.mockResolvedValue(undefined);
  useBottomStore.setState({ byKey: {}, pendingFocus: null, pendingFocusId: null, starting: {} });
  usePanelStore.setState({ byKey: {} });
  useViewsStore.setState({ settingsOpen: false, usageOpen: false, helpOpen: false });
  useUiStore.setState({ selection: { kind: "thread", id: "s1" }, focus: "content", bottomFocusSeq: 0, contentFocusSeq: 0, palette: closedPalette });
  setTerminals([term("claude", { thread: "s1" }), term("a", shell("s1")), term("w", shell("", "/src/app.worktrees/x"))]);
});

describe("onNewTerminal", () => {
  it("opens the owner's panel with the shell active, without focus when nobody asked", () => {
    onNewTerminal(term("b", shell("s2")));
    expect(getBottom("thread:s2")).toEqual({ open: true, activeTerminalId: "b" });
    expect(getBottom("thread:s1").open).toBe(false);
    expect(useUiStore.getState().bottomFocusSeq).toBe(0);
  });

  it("a worktree's shell opens the Projects page's panel", () => {
    onNewTerminal(term("w2", shell("")));
    expect(getBottom("view:projects")).toEqual({ open: true, activeTerminalId: "w2" });
  });

  const ignored: [string, TerminalView][] = [
    ["a thread-labelled terminal that is no shell", term("c2", { thread: "s1" })],
    ["an unlabelled terminal", term("loose", {})],
    ["an exited shell", term("gone", shell("s1"), { state: "exited" })],
  ];
  it.each(ignored)("ignores %s", (_name, t) => {
    onNewTerminal(t);
    expect(useBottomStore.getState().byKey).toEqual({});
  });

  const focus: [string, string, string, number][] = [
    ["this window started it for the selected key: focus", "thread:s1", "s1", 1],
    ["started for another key: no focus", "thread:s2", "s1", 0],
    ["started for this key but another is selected now: no focus", "thread:s1", "s3", 0],
  ];
  it.each(focus)("%s", (_name, pending, selected, want) => {
    markPendingFocus(pending);
    useUiStore.setState({ selection: { kind: "thread", id: selected } });
    onNewTerminal(term("b", shell("s1")));
    expect(useUiStore.getState().bottomFocusSeq).toBe(want);
    expect(getBottom("thread:s1").activeTerminalId).toBe("b");
  });

  it("the pending focus is used once", () => {
    markPendingFocus("thread:s1");
    onNewTerminal(term("b", shell("s1")));
    onNewTerminal(term("c", shell("s1")));
    expect(useUiStore.getState().bottomFocusSeq).toBe(1);
  });

  it("with the palette open, its return target moves to the panel instead", () => {
    markPendingFocus("thread:s1");
    useUiStore.setState({ palette: { ...closedPalette, open: true, returnTo: "content" } });
    onNewTerminal(term("b", shell("s1")));
    expect(useUiStore.getState().palette.returnTo).toBe("bottom");
    expect(useUiStore.getState().bottomFocusSeq).toBe(0);
  });
});

describe("revealShell (focusTerminal)", () => {
  it("a thread's shell: selects the thread, opens its panel on the shell, focuses it", () => {
    useUiStore.setState({ selection: { kind: "view", name: "pullrequests" } });
    useViewsStore.setState({ settingsOpen: true });
    usePanelStore.setState({ byKey: { "thread:s1": { open: true, groups: [{ tabs: [], activeTabId: null }], expanded: true } } });
    expect(revealShell("a")).toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s1" });
    expect(getBottom("thread:s1")).toEqual({ open: true, activeTerminalId: "a" });
    expect(useUiStore.getState().bottomFocusSeq).toBe(1);
    expect(useViewsStore.getState().settingsOpen).toBe(false);
    expect(usePanelStore.getState().byKey["thread:s1"]?.expanded).toBeUndefined();
  });

  it("a worktree's shell: the Projects page", () => {
    expect(revealShell("w")).toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "view", name: "projects" });
    expect(getBottom("view:projects")).toEqual({ open: true, activeTerminalId: "w" });
  });

  it("not a shell: false, nothing changes", () => {
    expect(revealShell("claude")).toBe(false);
    expect(useBottomStore.getState().byKey).toEqual({});
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s1" });
  });

  it("an unknown terminal is revealed when it arrives as a shell", () => {
    expect(revealShell("later")).toBe(false);
    useUiStore.setState({ selection: { kind: "view", name: "dashboard" } });
    // The events handler adds the terminal to the store, then calls onNewTerminal.
    const later = term("later", shell("s2"));
    setTerminals([later]);
    onNewTerminal(later);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s2" });
    expect(getBottom("thread:s2")).toEqual({ open: true, activeTerminalId: "later" });
    expect(useUiStore.getState().bottomFocusSeq).toBe(1);
  });
});

describe("paneContext and newBottomTerminal", () => {
  it("a thread's panel runs in the thread's context", () => {
    expect(paneContext("thread:s1")).toMatchObject({ activeThreadId: "s1", activeView: "thread" });
  });

  it("the Projects page's panel runs in its active tab's worktree, or nowhere without tabs", () => {
    expect(paneContext("view:projects")).toMatchObject({ activeProjectId: "r1", activeWorktreePath: "/src/app.worktrees/x", activeThreadId: "" });
    setTerminals([]);
    expect(paneContext("view:projects")).toBeNull();
    expect(paneContext("view:pullrequests")).toBeNull();
  });

  it("newBottomTerminal runs terminal.new there; no context, no run", async () => {
    expect(await newBottomTerminal("thread:s1")).toBe(true);
    expect(commands.runCommandForResult).toHaveBeenCalledWith("terminal.new", {}, { ctx: expect.objectContaining({ activeThreadId: "s1" }) as unknown, quiet: true });
    commands.runCommandForResult.mockClear();
    setTerminals([]);
    expect(await newBottomTerminal("view:projects")).toBe(false);
    expect(commands.runCommandForResult).not.toHaveBeenCalled();
  });
});

describe("focus for this window's own shells (by id)", () => {
  it("a shell that arrives after the result takes focus then", async () => {
    // "+" in the panel on screen: the keyboard stays put until the shell arrives.
    useBottomStore.setState({ byKey: { "thread:s1": { open: true } } });
    await newBottomTerminal("thread:s1");
    expect(useBottomStore.getState().pendingFocusId?.id).toBe("t-new");
    expect(useUiStore.getState().bottomFocusSeq).toBe(0);
    const t = term("t-new", shell("s1"));
    setTerminals([term("a", shell("s1")), t]);
    onNewTerminal(t);
    expect(getBottom("thread:s1")).toEqual({ open: true, activeTerminalId: "t-new" });
    expect(useUiStore.getState().bottomFocusSeq).toBe(1);
    expect(useBottomStore.getState().pendingFocusId).toBeNull();
  });

  it("a shell that arrived before the result (while the keyboard was in the panel) is activated and focused by the result", async () => {
    useBottomStore.setState({ byKey: { "thread:s1": { open: true } } });
    useUiStore.setState({ focus: "bottom" });
    const t = term("t-new", shell("s1"));
    setTerminals([term("a", shell("s1")), t]);
    onNewTerminal(t);
    expect(getBottom("thread:s1").activeTerminalId).toBe("a");
    await newBottomTerminal("thread:s1");
    expect(getBottom("thread:s1").activeTerminalId).toBe("t-new");
    expect(useUiStore.getState().bottomFocusSeq).toBe(1);
  });

  it("a shell for a thread that is not selected opens there without focus", async () => {
    commands.runCommandForResult.mockResolvedValue({ message: "", resultJson: JSON.stringify({ id: "t-b" }) });
    await newThreadTerminal("s2");
    const t = term("t-b", shell("s2"));
    setTerminals([t]);
    onNewTerminal(t);
    expect(getBottom("thread:s2")).toEqual({ open: true, activeTerminalId: "t-b" });
    expect(useUiStore.getState().bottomFocusSeq).toBe(0);
  });

  it.each<[string, string | undefined, Record<string, string>]>([
    ["the row menu: the thread's worktree", undefined, {}],
    ["a workspace member in the thread's panel: that member's worktree", "/src/api.worktrees/x", { cwd: "/src/api.worktrees/x" }],
  ])("newThreadTerminal from %s runs in the thread's context", async (_name, cwd, args) => {
    await newThreadTerminal("s2", cwd);
    expect(commands.runCommandForResult).toHaveBeenCalledWith("terminal.new", args, { ctx: expect.objectContaining({ activeThreadId: "s2", activeView: "thread" }) as unknown, quiet: true });
  });

  const uncover: [string, string, boolean, boolean][] = [
    ["already arrived, for the selected thread: uncovered and focused", "a", true, true],
    ["arriving later, for the selected thread: uncovered and focused", "t-late", true, true],
    ["for another thread: nothing uncovered", "t-other", false, false],
  ];
  it.each(uncover)("a shell this window started %s", async (_name, id, uncovered, focused) => {
    useViewsStore.setState({ settingsOpen: true });
    usePanelStore.setState({ byKey: { "thread:s1": { open: true, groups: [{ tabs: [], activeTabId: null }], expanded: true } } });
    commands.runCommandForResult.mockResolvedValue({ message: "", resultJson: JSON.stringify({ id }) });
    await newThreadTerminal(id === "t-other" ? "s2" : "s1", "/src/api");
    if (id !== "a") {
      const t = term(id, shell(id === "t-other" ? "s2" : "s1"));
      setTerminals([term("a", shell("s1")), t]);
      onNewTerminal(t);
    }
    expect(usePanelStore.getState().byKey["thread:s1"]?.expanded === undefined).toBe(uncovered);
    expect(useViewsStore.getState().settingsOpen).toBe(!uncovered);
    expect(useUiStore.getState().bottomFocusSeq).toBe(focused ? 1 : 0);
  });

  it("a failed run leaves nothing pending", async () => {
    commands.runCommandForResult.mockResolvedValue(null);
    expect(await newBottomTerminal("thread:s1")).toBe(false);
    expect(useBottomStore.getState().pendingFocusId).toBeNull();
    expect(useBottomStore.getState().pendingFocus).toBeNull();
  });
});

describe("a shell this window did not start", () => {
  it("while the keyboard is in that panel: gets a tab, the active one stays", () => {
    useBottomStore.setState({ byKey: { "thread:s1": { open: true } } });
    useUiStore.setState({ focus: "bottom" });
    const t = term("b", shell("s1"));
    setTerminals([term("a", shell("s1")), t]);
    onNewTerminal(t);
    expect(getBottom("thread:s1")).toEqual({ open: true, activeTerminalId: "a" });
    expect(useUiStore.getState().bottomFocusSeq).toBe(0);
  });

  const activates: [string, () => void][] = [
    ["the keyboard elsewhere", () => useBottomStore.setState({ byKey: { "thread:s1": { open: true } } })],
    ["the panel hidden", () => useUiStore.setState({ focus: "bottom" })],
    ["the settings page up", () => {
      useBottomStore.setState({ byKey: { "thread:s1": { open: true } } });
      useUiStore.setState({ focus: "bottom" });
      useViewsStore.setState({ settingsOpen: true });
    }],
  ];
  it.each(activates)("with %s: becomes active", (_name, arrange) => {
    arrange();
    const t = term("b", shell("s1"));
    setTerminals([term("a", shell("s1")), t]);
    onNewTerminal(t);
    expect(getBottom("thread:s1").activeTerminalId).toBe("b");
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
    useBottomStore.setState({ byKey: { "thread:s1": remembered === undefined ? { open: true } : { open: true, activeTerminalId: remembered } } });
    onRemovedTerminal(term(removed, shell("s1")), before(["a", "b", "c"]));
    expect(getBottom("thread:s1").activeTerminalId).toBe(want);
  });
});

/** The events handler's order: the store loses the terminal, then onRemovedTerminal runs. */
function removeTerminal(id: string): void {
  const before = useTerminalsStore.getState();
  const t = before.byId[id];
  if (!t) throw new Error(`no terminal ${id}`);
  setTerminals(before.order.filter((x) => x !== id).flatMap((x) => (before.byId[x] ? [before.byId[x]] : [])));
  onRemovedTerminal(t, before);
}

describe("the last tab going hides its panel", () => {
  it("shown with the keyboard in it: hidden, the content pane takes the keyboard", () => {
    useBottomStore.setState({ byKey: { "thread:s1": { open: true, height: 300, activeTerminalId: "a" } } });
    useUiStore.setState({ focus: "bottom" });
    removeTerminal("a");
    expect(getBottom("thread:s1")).toEqual({ open: false, height: 300, activeTerminalId: "a" });
    expect(useUiStore.getState().contentFocusSeq).toBe(1);
  });

  const cases: [string, () => void, number, string][] = [
    ["shown, the keyboard elsewhere: focus stays", () => useUiStore.setState({ focus: "sidebar" }), 0, "content"],
    ["another thread selected: hidden all the same", () => useUiStore.setState({ selection: { kind: "thread", id: "s9" }, focus: "bottom" }), 0, "content"],
    ["the palette open over it: it returns to the content pane", () => useUiStore.setState({ palette: { ...closedPalette, open: true, returnTo: "bottom" } }), 0, "content"],
  ];
  it.each(cases)("%s", (_name, arrange, contentFocus, returnTo) => {
    useBottomStore.setState({ byKey: { "thread:s1": { open: true } } });
    arrange();
    removeTerminal("a");
    expect(getBottom("thread:s1").open).toBe(false);
    expect(useUiStore.getState().contentFocusSeq).toBe(contentFocus);
    expect(useUiStore.getState().palette.returnTo).toBe(returnTo);
  });

  it("a tab left: the panel stays open", () => {
    setTerminals([term("a", shell("s1")), term("b", shell("s1"))]);
    useBottomStore.setState({ byKey: { "thread:s1": { open: true } } });
    removeTerminal("b");
    expect(getBottom("thread:s1").open).toBe(true);
  });

  it("a shell this window is starting for it: the panel stays open", () => {
    useBottomStore.setState({ byKey: { "thread:s1": { open: true } } });
    markStarting("thread:s1");
    removeTerminal("a");
    expect(getBottom("thread:s1").open).toBe(true);
  });

  it("the Projects page's last worktree shell", () => {
    useUiStore.setState({ selection: { kind: "view", name: "projects" }, focus: "bottom" });
    useBottomStore.setState({ byKey: { "view:projects": { open: true } } });
    removeTerminal("w");
    expect(getBottom("view:projects").open).toBe(false);
    expect(useUiStore.getState().contentFocusSeq).toBe(1);
  });

  it("the Claude terminal is no tab: nothing changes", () => {
    useBottomStore.setState({ byKey: { "thread:s1": { open: true } } });
    removeTerminal("claude");
    expect(getBottom("thread:s1").open).toBe(true);
  });
});

describe("closeEmptyPanels (after the reconnect's List)", () => {
  it("hides every open panel without tabs, keeps the rest, and moves the keyboard out of the shown one", () => {
    useBottomStore.setState({
      byKey: { "thread:s1": { open: true }, "thread:s2": { open: true, height: 200 }, "view:projects": { open: true }, "thread:s3": { open: true } },
    });
    markStarting("thread:s3");
    useUiStore.setState({ selection: { kind: "thread", id: "s1" }, focus: "bottom" });
    // The restarted daemon has none of s1's shells: only the worktree shell is left.
    setTerminals([term("claude", { thread: "s1" }), term("w", shell("", "/src/app.worktrees/x"))]);
    closeEmptyPanels();
    expect(useBottomStore.getState().byKey).toEqual({
      "thread:s1": { open: false },
      "thread:s2": { open: false, height: 200 },
      "view:projects": { open: true },
      "thread:s3": { open: true },
    });
    expect(useUiStore.getState().contentFocusSeq).toBe(1);
  });
});

describe("openBottomShell", () => {
  it("a panel with an active tab: shown on it and focused, no new shell", async () => {
    expect(await openBottomShell("thread:s1")).toBe("a");
    expect(commands.runCommandForResult).not.toHaveBeenCalled();
    expect(getBottom("thread:s1")).toEqual({ open: true, activeTerminalId: "a" });
    expect(useUiStore.getState().bottomFocusSeq).toBe(1);
  });

  it("no tab: opens at once, blank while the shell starts, and the shell takes it when it arrives", async () => {
    setTerminals([term("claude", { thread: "s1" })]);
    useViewsStore.setState({ usageOpen: true });
    const pending = openBottomShell("thread:s1");
    // Before terminal.new returns: open, uncovered, focused (the panel), waiting.
    expect(getBottom("thread:s1").open).toBe(true);
    expect(useViewsStore.getState().usageOpen).toBe(false);
    expect(useUiStore.getState().bottomFocusSeq).toBe(1);
    expect("thread:s1" in useBottomStore.getState().starting).toBe(true);
    expect(await pending).toBe("t-new");
    expect(commands.runCommandForResult).toHaveBeenCalledWith("terminal.new", {}, { ctx: expect.objectContaining({ activeThreadId: "s1" }) as unknown, quiet: true });
    expect("thread:s1" in useBottomStore.getState().starting).toBe(true);
    const t = term("t-new", shell("s1"));
    setTerminals([term("claude", { thread: "s1" }), t]);
    onNewTerminal(t);
    expect(getBottom("thread:s1")).toEqual({ open: true, activeTerminalId: "t-new" });
    expect(useBottomStore.getState().starting).toEqual({});
    expect(useUiStore.getState().bottomFocusSeq).toBe(2);
  });

  it("fresh: a new shell beside the tabs, with args and the command as terminal.new --run (the daemon types it)", async () => {
    expect(await openBottomShell("thread:s1", { fresh: true, args: { cwd: "/src/app/docs" }, command: "make test\n" })).toBe("t-new");
    expect(commands.runCommandForResult).toHaveBeenCalledWith("terminal.new", { cwd: "/src/app/docs", run: "make test\n" }, expect.anything());
    expect(writeTerminal).not.toHaveBeenCalled();
  });

  it("--run: the shell arriving while terminal.new waits for its prompt takes the tab and the keyboard, once", async () => {
    let finish: (v: unknown) => void = () => undefined;
    commands.runCommandForResult.mockReturnValue(new Promise((r) => (finish = r)));
    useUiStore.setState({ focus: "bottom" });
    const pending = openBottomShell("thread:s1", { fresh: true, command: "ls" });
    const t = term("t-new", shell("s1"));
    setTerminals([term("claude", { thread: "s1" }), term("a", shell("s1")), t]);
    onNewTerminal(t);
    expect(getBottom("thread:s1")).toEqual({ open: true, activeTerminalId: "t-new" });
    const focused = useUiStore.getState().bottomFocusSeq;
    expect(focused).toBe(2); // the panel as it opened, then the shell on arrival
    finish({ message: "", resultJson: JSON.stringify({ id: "t-new" }) });
    expect(await pending).toBe("t-new");
    expect(useUiStore.getState().bottomFocusSeq).toBe(focused);
    expect(useBottomStore.getState().pendingFocus).toBeNull();
  });

  it("--run: no shell arrived before terminal.new returned: the id takes focus on arrival, nothing else is left pending", async () => {
    expect(await openBottomShell("thread:s1", { fresh: true, command: "ls" })).toBe("t-new");
    expect(useBottomStore.getState().pendingFocus).toBeNull();
    expect(useBottomStore.getState().pendingFocusId?.id).toBe("t-new");
  });

  it("runInThreadTerminal: a fresh shell in the thread's panel with the command", async () => {
    expect(await runInThreadTerminal("s2", "go test ./...")).toBe("t-new");
    expect(commands.runCommandForResult).toHaveBeenCalledWith(
      "terminal.new",
      { run: "go test ./..." },
      { ctx: expect.objectContaining({ activeThreadId: "s2" }) as unknown, quiet: true },
    );
    expect(getBottom("thread:s2").open).toBe(true);
  });

  it("terminal.new failed: null, nothing pending, the panel stays open on its empty state", async () => {
    commands.runCommandForResult.mockResolvedValue(null);
    setTerminals([]);
    expect(await openBottomShell("thread:s1", { command: "ls" })).toBeNull();
    expect(getBottom("thread:s1").open).toBe(true);
    expect(useBottomStore.getState().starting).toEqual({});
    expect(writeTerminal).not.toHaveBeenCalled();
  });

  it("no context to own a shell (the Projects page without tabs): null, nothing changes", async () => {
    setTerminals([]);
    expect(await openBottomShell("view:projects")).toBeNull();
    expect(commands.runCommandForResult).not.toHaveBeenCalled();
    expect(useBottomStore.getState().byKey).toEqual({});
  });

  it("for a thread that is not selected: opens there without focus or uncovering", async () => {
    useViewsStore.setState({ settingsOpen: true });
    expect(await openBottomShell("thread:s2")).toBe("t-new");
    expect(getBottom("thread:s2").open).toBe(true);
    expect(useUiStore.getState().bottomFocusSeq).toBe(0);
    expect(useViewsStore.getState().settingsOpen).toBe(true);
  });
});

describe("toggleBottomFromHere (cmd+j, the header toggle, the palette)", () => {
  const cases: [string, () => void, boolean, boolean][] = [
    ["a thread's panel without tabs opens with a new shell", () => { setTerminals([term("claude", { thread: "s1" })]); }, true, true],
    ["a thread's panel with a tab just opens", () => undefined, true, false],
    ["an open panel just hides", () => useBottomStore.setState({ byKey: { "thread:s1": { open: true } } }), false, false],
    [
      "the Projects page without tabs opens on its empty state",
      () => {
        useUiStore.setState({ selection: { kind: "view", name: "projects" } });
        setTerminals([]);
      },
      true,
      false,
    ],
    [
      "under the settings page: a no-op",
      () => {
        setTerminals([]);
        useViewsStore.setState({ settingsOpen: true });
      },
      false,
      false,
    ],
    ["the dashboard: a no-op", () => useUiStore.setState({ selection: { kind: "view", name: "dashboard" } }), false, false],
    [
      "before the terminals are listed: just opens",
      () => {
        useTerminalsStore.setState({ byId: {}, order: [], loaded: false });
      },
      true,
      false,
    ],
    [
      "already starting a shell for it: just opens",
      () => {
        setTerminals([]);
        markStarting("thread:s1");
      },
      true,
      false,
    ],
  ];
  it.each(cases)("%s", async (_name, arrange, open, started) => {
    arrange();
    expect(toggleBottomFromHere()).toBe(open);
    await Promise.resolve();
    expect(commands.runCommandForResult).toHaveBeenCalledTimes(started ? 1 : 0);
  });

  it("from the palette, its return target moves to the starting panel", () => {
    setTerminals([]);
    useUiStore.setState({ palette: { ...closedPalette, open: true, returnTo: "content" } });
    toggleBottomFromHere();
    expect(useUiStore.getState().palette.returnTo).toBe("bottom");
    expect(useUiStore.getState().bottomFocusSeq).toBe(0);
  });
});

describe("closeBottomTerminal", () => {
  it("runs terminal.close with --id and that terminal as the active one", async () => {
    await closeBottomTerminal("a");
    expect(commands.invokeConfirmed).toHaveBeenCalledWith("terminal.close", { id: "a" }, expect.objectContaining({ activeTerminalId: "a", activeThreadId: "s1" }));
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
