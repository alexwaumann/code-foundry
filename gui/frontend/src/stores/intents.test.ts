import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import type { TerminalView } from "@/api/terminal";

const toastInfo = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { info: toastInfo, error: toastError, warning: vi.fn() } }));
const playAlertSound = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/api/app", () => ({ playAlertSound }));

const { applyIntent, clearPendingFocus } = await import("./intents");
const { getBottom, PENDING_FOCUS_MS, useBottomStore } = await import("./bottomPanel");
const { onNewTerminal, revealArrived } = await import("./bottomActions");
const { usePanelStore } = await import("./panel");
const { useThreadsStore } = await import("./threads");
const { useTerminalsStore } = await import("./terminals");
const { HOME, useUiStore } = await import("./ui");
const { getDraft, updateDraft } = await import("./compose");
const { threadDraftKey } = await import("./threadActions");

function term(id: string, labels: Record<string, string>): TerminalView {
  return { id, argv: ["/bin/zsh"], cwd: "/src/app", cols: 80, rows: 24, title: "", state: "running", exitCode: 0, startedAtMs: null, exitedAtMs: null, altScreen: false, labels };
}
const thread = (id: string) => ({ id, projectId: "r1", worktreePath: "/src/app", workspaceId: "", state: "connected" }) as ThreadView;
const shell = { kind: "shell", thread: "s1", project: "r1", worktree: "/src/app" };

function setTerminals(list: TerminalView[]): void {
  useTerminalsStore.setState({ byId: Object.fromEntries(list.map((t) => [t.id, t])), order: list.map((t) => t.id), loaded: true });
}
const focusTerminal = (terminalId: string) => {
  applyIntent({ kind: "focusTerminal", terminalId });
};

beforeEach(() => {
  vi.clearAllMocks();
  useBottomStore.setState({ byKey: {}, pendingFocus: null, pendingFocusId: null });
  usePanelStore.setState({ byKey: {} });
  useThreadsStore.setState({ byId: { s1: thread("s1") }, order: ["s1"] });
  setTerminals([term("sh", shell), term("raw", {})]);
  useUiStore.setState({ selection: HOME, promptFocusSeq: 0, bottomFocusSeq: 0 });
  clearPendingFocus();
});

describe("a pending focusTerminal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires after PENDING_FOCUS_MS: a toast, and a late shell only gets its tab", () => {
    vi.useFakeTimers();
    focusTerminal("late");
    vi.advanceTimersByTime(PENDING_FOCUS_MS + 1);
    expect(toastError).toHaveBeenCalledWith("Terminal late not found");
    const late = term("late", shell);
    setTerminals([late]);
    onNewTerminal(late);
    expect(useUiStore.getState().selection).toEqual(HOME);
    expect(useUiStore.getState().bottomFocusSeq).toBe(0);
  });

  it("a terminal that arrives as no shell is not shown, and the wait ends without a toast", () => {
    vi.useFakeTimers();
    focusTerminal("c9");
    const c9 = term("c9", { thread: "s1" });
    setTerminals([c9]);
    onNewTerminal(c9);
    expect(useUiStore.getState().selection).toEqual(HOME);
    vi.advanceTimersByTime(PENDING_FOCUS_MS + 1);
    expect(toastError).not.toHaveBeenCalled();
  });

  const cancels: [string, () => void][] = [
    ["the user selects something", () => { useUiStore.getState().select({ kind: "view", name: "pullrequests" }); }],
    ["a focusThread intent", () => { applyIntent({ kind: "focusThread", threadId: "s1" }); }],
    ["a showView intent", () => { applyIntent({ kind: "showView", name: "projects" }); }],
    ["another focusTerminal", () => { focusTerminal("sh"); }],
  ];
  it.each(cancels)("is dropped when %s", (_name, act) => {
    vi.useFakeTimers();
    focusTerminal("later");
    act();
    const selected = useUiStore.getState().selection;
    const later = term("later", { kind: "shell", thread: "s2", project: "r1", worktree: "/src/app" });
    setTerminals([later]);
    onNewTerminal(later);
    expect(useUiStore.getState().selection).toEqual(selected);
    vi.advanceTimersByTime(PENDING_FOCUS_MS + 1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("the reconnect's List reveals a pending shell once (revealArrived)", () => {
    focusTerminal("relist");
    setTerminals([term("relist", shell)]);
    revealArrived();
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s1" });
    expect(getBottom("thread:s1")).toEqual({ open: true, activeTerminalId: "relist" });
    useUiStore.setState({ selection: HOME });
    revealArrived();
    expect(useUiStore.getState().selection).toEqual(HOME);
  });
});

describe("the focusTerminal intent", () => {
  it("a shell shows in its owner's bottom panel, focused there", () => {
    focusTerminal("sh");
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s1" });
    expect(getBottom("thread:s1")).toEqual({ open: true, activeTerminalId: "sh" });
    expect(useUiStore.getState().bottomFocusSeq).toBe(1);
    expect(useUiStore.getState().promptFocusSeq).toBe(0);
  });

  it.each([
    ["no labels", "raw", {}],
    ["a thread's label but no shell", "labelled", { thread: "s1" }],
  ])("a known terminal with %s changes nothing and says why", (_name, id, labels) => {
    setTerminals([term(id, labels)]);
    focusTerminal(id);
    expect(useUiStore.getState().selection).toEqual(HOME);
    expect(toastInfo).toHaveBeenCalledWith(`Terminal ${id} belongs to no thread or project`, expect.anything());
  });

  it("an unknown terminal that arrives as a shell is revealed there, not in the thread's prompt", () => {
    focusTerminal("later");
    expect(useUiStore.getState().selection).toEqual(HOME);
    const later = term("later", shell);
    setTerminals([later]);
    onNewTerminal(later);
    expect(getBottom("thread:s1")).toEqual({ open: true, activeTerminalId: "later" });
    expect(useUiStore.getState().bottomFocusSeq).toBe(1);
    expect(useUiStore.getState().promptFocusSeq).toBe(0);
  });
});

describe("a playAlertSound intent (notifications.test)", () => {
  it("plays the sound at the intent's volume, without moving the window", () => {
    applyIntent({ kind: "playAlertSound", volume: 15 });
    expect(playAlertSound).toHaveBeenCalledExactlyOnceWith(15);
    expect(useUiStore.getState().selection).toEqual(HOME);
  });
});

describe("the focusThread intent (child threads, docs/notes/no-sidebar-override-1-gui.md)", () => {
  const now = Date.now();
  const made = (id: string, over: Partial<ThreadView>): ThreadView => ({ ...thread(id), createdBy: "", createdAtMs: now, ...over });
  const selected = () => useUiStore.getState().selection;
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each<[string, Partial<ThreadView>, boolean]>([
    ["the user's new thread", {}, true],
    ["a new child (its creator exists)", { createdBy: "s1" }, false],
    ["a new child whose creator was removed", { createdBy: "gone" }, true],
    ["an older child (thread.focus)", { createdBy: "s1", createdAtMs: now - 60_000 }, true],
  ])("%s: switches the view %s", (_name, over, switches) => {
    useThreadsStore.setState({ byId: { s1: thread("s1"), n: made("n", over) }, order: ["s1", "n"] });
    applyIntent({ kind: "focusThread", threadId: "n" });
    expect(selected()).toEqual(switches ? { kind: "thread", id: "n" } : HOME);
    expect(useUiStore.getState().promptFocusSeq).toBe(switches ? 1 : 0);
  });

  it("an explicit one (--focus: the user asked) selects even a new hidden child, when it arrives too", () => {
    useThreadsStore.setState({ byId: { s1: thread("s1"), n: made("n", { createdBy: "s1" }) }, order: ["s1", "n"] });
    applyIntent({ kind: "focusThread", threadId: "n", explicit: true });
    expect(selected()).toEqual({ kind: "thread", id: "n" });

    applyIntent({ kind: "focusThread", threadId: "late", explicit: true });
    expect(selected()).toEqual({ kind: "thread", id: "n" });
    useThreadsStore.setState((s) => ({ byId: { ...s.byId, late: made("late", { createdBy: "s1" }) }, order: [...s.order, "late"] }));
    expect(selected()).toEqual({ kind: "thread", id: "late" });
  });

  it.each<[string, Partial<ThreadView>, boolean]>([
    ["a shown thread", {}, true],
    ["a hidden child", { createdBy: "s1" }, false],
  ])("one not in the list yet is decided when it arrives: %s", (_name, over, switches) => {
    applyIntent({ kind: "focusThread", threadId: "late" });
    expect(selected()).toEqual(HOME);
    useThreadsStore.setState({ byId: { s1: thread("s1"), late: made("late", over) }, order: ["s1", "late"] });
    expect(selected()).toEqual(switches ? { kind: "thread", id: "late" } : HOME);
  });

  it("a pending one is dropped by a selection, another intent, or PENDING_FOCUS_MS", () => {
    vi.useFakeTimers();
    applyIntent({ kind: "focusThread", threadId: "late" });
    useUiStore.getState().select({ kind: "view", name: "projects" });
    useThreadsStore.setState({ byId: { s1: thread("s1"), late: made("late", {}) }, order: ["s1", "late"] });
    expect(selected()).toEqual({ kind: "view", name: "projects" });

    applyIntent({ kind: "focusThread", threadId: "later" });
    applyIntent({ kind: "showView", name: "projects" });
    useThreadsStore.setState((s) => ({ byId: { ...s.byId, later: made("later", {}) }, order: [...s.order, "later"] }));
    expect(selected()).not.toEqual({ kind: "thread", id: "later" });

    useUiStore.setState({ selection: HOME });
    applyIntent({ kind: "focusThread", threadId: "latest" });
    vi.advanceTimersByTime(PENDING_FOCUS_MS + 1);
    useThreadsStore.setState((s) => ({ byId: { ...s.byId, latest: made("latest", {}) }, order: [...s.order, "latest"] }));
    expect(selected()).toEqual(HOME);
  });
});

describe("the stageComposer intent (composer.stage)", () => {
  const stage = (text: string, threadId = "s1") => {
    applyIntent({ kind: "stageComposer", threadId, text });
  };
  beforeEach(() => {
    updateDraft(threadDraftKey("s1"), { text: "" });
  });

  it("fills an empty draft of the thread the window shows and focuses its prompt", () => {
    useUiStore.setState({ selection: { kind: "thread", id: "s1" } });
    stage("Add my first project");
    expect(getDraft(threadDraftKey("s1")).text).toBe("Add my first project");
    expect(useUiStore.getState().promptFocusSeq).toBe(1);
  });

  it("goes on a new line after a draft that has text", () => {
    useUiStore.setState({ selection: { kind: "thread", id: "s1" } });
    updateDraft(threadDraftKey("s1"), { text: "I was typing  \n" });
    stage("then this");
    expect(getDraft(threadDraftKey("s1")).text).toBe("I was typing\nthen this");
  });

  it("a window showing something else leaves the thread and its selection alone", () => {
    stage("hello");
    expect(getDraft(threadDraftKey("s1")).text).toBe("");
    expect(useUiStore.getState()).toMatchObject({ selection: HOME, promptFocusSeq: 0 });
  });
});

describe("notify", () => {
  it("a link it carries is a button that opens its target", async () => {
    const { useViewsStore } = await import("./views");
    useViewsStore.setState({ settingsOpen: false, settingsPage: "general", usageOpen: true });
    applyIntent({ kind: "notify", level: "info", title: "Remembered: Use tabs", body: 'By thread "Fix login".', link: "settings:memory", linkLabel: "Show in Settings" });
    const [title, opts] = toastInfo.mock.calls[0] as [string, { description: string; action: { label: string; onClick: () => void } }];
    expect(title).toBe("Remembered: Use tabs");
    expect(opts.description).toBe('By thread "Fix login".');
    expect(opts.action.label).toBe("Show in Settings");
    opts.action.onClick();
    expect(useViewsStore.getState()).toMatchObject({ settingsOpen: true, settingsPage: "memory", usageOpen: false });
  });

  it("a second link is a button before the first; a page showing the change skips the toast", async () => {
    const { useViewsStore } = await import("./views");
    useViewsStore.setState({ themesOpen: false });
    const intent = {
      kind: "notify" as const,
      level: "info" as const,
      title: "Ocean Dusk applied to dark",
      body: "",
      link: "theme-undo:dark:ocean-dusk:nord",
      linkLabel: "Undo",
      secondaryLink: "theme-edit:ocean-dusk",
      secondaryLinkLabel: "Edit",
      unlessShowing: "themes",
    };
    applyIntent(intent);
    const [title, opts] = toastInfo.mock.calls[0] as [string, { action: { label: string }; cancel: { label: string } }];
    expect(title).toBe("Ocean Dusk applied to dark");
    expect(opts.action.label).toBe("Undo");
    expect(opts.cancel.label).toBe("Edit");
    toastInfo.mockClear();
    useViewsStore.setState({ themesOpen: true });
    applyIntent(intent);
    expect(toastInfo).not.toHaveBeenCalled();
    useViewsStore.setState({ themesOpen: false });
  });

  it.each([
    ["no link", undefined, undefined],
    ["a link this window does not know", "nowhere:at-all", { description: "b" }],
  ])("%s: no button", (_name, link, want) => {
    applyIntent({ kind: "notify", level: "info", title: "t", body: link ? "b" : "", ...(link ? { link, linkLabel: "Go" } : {}) });
    expect(toastInfo).toHaveBeenCalledWith("t", want);
  });
});

describe("showView from the daemon", () => {
  it("settings opens the sheet, thread.next selects the next thread and closes it, help opens the overlay", async () => {
    const { startViewSync, useViewsStore } = await import("./views");
    const full = (id: string) => ({ ...thread(id), name: id, status: "idle", statusReason: "", pinned: false, archivedAtMs: null, snoozedUntilMs: null, createdBy: "", flags: [], createdAtMs: 1, lastActivityAtMs: null }) as unknown as ThreadView;
    useThreadsStore.setState({ byId: { s1: full("s1"), s2: full("s2") }, order: ["s1", "s2"] });
    useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false, helpOpen: false });
    const stop = startViewSync();
    try {
      applyIntent({ kind: "showView", name: "settings" });
      expect(useViewsStore.getState().settingsOpen).toBe(true);
      applyIntent({ kind: "showView", name: "thread.next" });
      expect(useUiStore.getState().selection.kind).toBe("thread");
      expect(useViewsStore.getState().settingsOpen).toBe(false);
      applyIntent({ kind: "showView", name: "help" });
      expect(useViewsStore.getState().helpOpen).toBe(true);
    } finally {
      stop();
    }
  });
});

// From e2e/panel.spec.ts: view.panel.new-tab from the palette and the CLI (ShowView "panel.new-tab").
describe("showView panel.new-tab", () => {
  const files = { id: "files", kind: "files", title: "Files", params: {} };
  const closedPalette = { open: false, query: "", commandName: null, page: "commands" as const, returnTo: "content" as const };

  beforeEach(() => {
    usePanelStore.setState({ byKey: { "thread:s1": { open: false, groups: [{ tabs: [files], activeTabId: files.id }] } } });
    useUiStore.setState({ selection: { kind: "thread", id: "s1" }, focus: "content", panelFocusSeq: 0, palette: closedPalette });
  });

  it("shows the hidden panel picking (no tab added) and asks for the keyboard there", () => {
    applyIntent({ kind: "showView", name: "panel.new-tab" });
    expect(usePanelStore.getState().byKey["thread:s1"]).toEqual({ open: true, groups: [{ tabs: [files], activeTabId: null, pickFrom: files.id }] });
    expect(useUiStore.getState().panelFocusSeq).toBe(1);
  });

  it("with the palette open, the palette's return target moves to the panel instead", () => {
    useUiStore.setState({ focus: "palette", palette: { ...closedPalette, open: true } });
    applyIntent({ kind: "showView", name: "panel.new-tab" });
    expect(usePanelStore.getState().byKey["thread:s1"]?.groups[0]?.activeTabId).toBeNull();
    expect(useUiStore.getState().palette.returnTo).toBe("panel");
    expect(useUiStore.getState().panelFocusSeq).toBe(0);
  });
});
