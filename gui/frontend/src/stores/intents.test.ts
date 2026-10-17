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
const { useUiStore } = await import("./ui");

function term(id: string, labels: Record<string, string>): TerminalView {
  return { id, argv: ["/bin/zsh"], cwd: "/src/app", cols: 80, rows: 24, title: "", state: "running", exitCode: 0, startedAtMs: null, exitedAtMs: null, altScreen: false, labels };
}
const thread = (id: string) => ({ id, repoId: "r1", worktreePath: "/src/app", workspaceId: "", state: "connected" }) as ThreadView;
const shell = { kind: "shell", thread: "s1", repo: "r1", worktree: "/src/app" };

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
  useUiStore.setState({ selection: { kind: "view", name: "dashboard" }, promptFocusSeq: 0, bottomFocusSeq: 0 });
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
    expect(useUiStore.getState().selection).toEqual({ kind: "view", name: "dashboard" });
    expect(useUiStore.getState().bottomFocusSeq).toBe(0);
  });

  it("a terminal that arrives as no shell is not shown, and the wait ends without a toast", () => {
    vi.useFakeTimers();
    focusTerminal("c9");
    const c9 = term("c9", { thread: "s1" });
    setTerminals([c9]);
    onNewTerminal(c9);
    expect(useUiStore.getState().selection).toEqual({ kind: "view", name: "dashboard" });
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
    const later = term("later", { kind: "shell", thread: "s2", repo: "r1", worktree: "/src/app" });
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
    useUiStore.setState({ selection: { kind: "view", name: "dashboard" } });
    revealArrived();
    expect(useUiStore.getState().selection).toEqual({ kind: "view", name: "dashboard" });
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
    expect(useUiStore.getState().selection).toEqual({ kind: "view", name: "dashboard" });
    expect(toastInfo).toHaveBeenCalledWith(`Terminal ${id} belongs to no thread or project`, expect.anything());
  });

  it("an unknown terminal that arrives as a shell is revealed there, not in the thread's prompt", () => {
    focusTerminal("later");
    expect(useUiStore.getState().selection).toEqual({ kind: "view", name: "dashboard" });
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
    expect(useUiStore.getState().selection).toEqual({ kind: "view", name: "dashboard" });
  });
});
