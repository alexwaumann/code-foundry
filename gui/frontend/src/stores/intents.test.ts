import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "@/api/session";
import type { TerminalView } from "@/api/terminal";

const toastInfo = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { info: toastInfo, error: toastError, warning: vi.fn() } }));

const { applyIntent, clearPendingFocus, retryFocusTerminal } = await import("./intents");
const { getBottom, PENDING_FOCUS_MS, useBottomStore } = await import("./bottomPanel");
const { onNewTerminal, revealArrived } = await import("./bottomActions");
const { usePanelStore } = await import("./panel");
const { useSessionsStore } = await import("./sessions");
const { useTerminalsStore } = await import("./terminals");
const { useUiStore } = await import("./ui");

function term(id: string, labels: Record<string, string>): TerminalView {
  return { id, argv: ["/bin/zsh"], cwd: "/src/app", cols: 80, rows: 24, title: "", state: "running", exitCode: 0, startedAtMs: null, exitedAtMs: null, altScreen: false, labels };
}
const thread = (id: string, terminalId: string) => ({ id, terminalId, repoId: "r1", worktreePath: "/src/app", workspaceId: "", state: "connected" }) as SessionView;
const shell = { kind: "shell", session: "s1", repo: "r1", worktree: "/src/app" };

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
  useSessionsStore.setState({ byId: { s1: thread("s1", "claude") }, order: ["s1"] });
  setTerminals([term("claude", { session: "s1" }), term("sh", shell), term("raw", {})]);
  useUiStore.setState({ selection: { kind: "view", name: "dashboard" }, terminalFocusSeq: 0, bottomFocusSeq: 0 });
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
    retryFocusTerminal();
    expect(useUiStore.getState().selection).toEqual({ kind: "view", name: "dashboard" });
    expect(useUiStore.getState().bottomFocusSeq).toBe(0);
  });

  it("a known terminal whose thread never shows up expires without a toast", () => {
    vi.useFakeTimers();
    setTerminals([term("c9", { session: "s9" })]);
    focusTerminal("c9");
    vi.advanceTimersByTime(PENDING_FOCUS_MS + 1);
    expect(toastError).not.toHaveBeenCalled();
    useSessionsStore.setState({ byId: { s9: thread("s9", "c9") }, order: ["s9"] });
    retryFocusTerminal();
    expect(useUiStore.getState().selection).toEqual({ kind: "view", name: "dashboard" });
  });

  const cancels: [string, () => void][] = [
    ["the user selects something", () => { useUiStore.getState().select({ kind: "view", name: "pullrequests" }); }],
    ["a focusSession intent", () => { applyIntent({ kind: "focusSession", sessionId: "s1" }); }],
    ["a showView intent", () => { applyIntent({ kind: "showView", name: "projects" }); }],
    ["another focusTerminal", () => { focusTerminal("claude"); }],
  ];
  it.each(cancels)("is dropped when %s", (_name, act) => {
    vi.useFakeTimers();
    focusTerminal("later");
    act();
    const selected = useUiStore.getState().selection;
    const later = term("later", { kind: "shell", session: "s2", repo: "r1", worktree: "/src/app" });
    setTerminals([later]);
    onNewTerminal(later);
    retryFocusTerminal();
    expect(useUiStore.getState().selection).toEqual(selected);
    vi.advanceTimersByTime(PENDING_FOCUS_MS + 1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("the reconnect's List reveals a pending shell once (revealArrived)", () => {
    focusTerminal("relist");
    setTerminals([term("relist", shell)]);
    revealArrived();
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "s1" });
    expect(getBottom("session:s1")).toEqual({ open: true, activeTerminalId: "relist" });
    useUiStore.setState({ selection: { kind: "view", name: "dashboard" } });
    revealArrived();
    expect(useUiStore.getState().selection).toEqual({ kind: "view", name: "dashboard" });
  });
});

describe("the focusTerminal intent", () => {
  it("a thread's Claude terminal selects the thread and focuses its terminal", () => {
    focusTerminal("claude");
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "s1" });
    expect(useUiStore.getState().terminalFocusSeq).toBe(1);
  });

  it("a shell shows in its owner's bottom panel, focused there", () => {
    focusTerminal("sh");
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "s1" });
    expect(getBottom("session:s1")).toEqual({ open: true, activeTerminalId: "sh" });
    expect(useUiStore.getState().bottomFocusSeq).toBe(1);
    expect(useUiStore.getState().terminalFocusSeq).toBe(0);
  });

  it("a terminal with no owner changes nothing and says why", () => {
    focusTerminal("raw");
    expect(useUiStore.getState().selection).toEqual({ kind: "view", name: "dashboard" });
    expect(toastInfo).toHaveBeenCalledWith("Terminal raw belongs to no thread or project", expect.anything());
  });

  it("an unknown terminal that arrives as a shell is revealed, and the retry leaves the keyboard there", () => {
    focusTerminal("later");
    expect(useUiStore.getState().selection).toEqual({ kind: "view", name: "dashboard" });
    const later = term("later", shell);
    setTerminals([term("claude", { session: "s1" }), later]);
    onNewTerminal(later);
    retryFocusTerminal();
    expect(getBottom("session:s1")).toEqual({ open: true, activeTerminalId: "later" });
    expect(useUiStore.getState().bottomFocusSeq).toBe(1);
    expect(useUiStore.getState().terminalFocusSeq).toBe(0);
  });

  it("an unknown Claude terminal selects its thread once the thread knows it", () => {
    focusTerminal("c2");
    setTerminals([term("c2", { session: "s2" })]);
    retryFocusTerminal();
    expect(useUiStore.getState().selection).toEqual({ kind: "view", name: "dashboard" });
    useSessionsStore.setState({ byId: { s2: thread("s2", "c2") }, order: ["s2"] });
    retryFocusTerminal();
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "s2" });
    // Done: a later retry does nothing.
    useUiStore.setState({ selection: { kind: "view", name: "dashboard" } });
    retryFocusTerminal();
    expect(useUiStore.getState().selection).toEqual({ kind: "view", name: "dashboard" });
  });
});
