import { beforeEach, describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import type { TerminalView } from "@/api/terminal";
import { useBottomStore } from "./bottomPanel";
import { decodeThreadListKeys, deriveContext, encodeThreadListKey, getListOptions, getListThreads, getUiContext } from "./context";
import { useProjectsStore } from "./projects";
import { useThreadsStore } from "./threads";
import { useTerminalsStore } from "./terminals";
import { useUiStore } from "./ui";

function term(id: string, labels: Record<string, string>): TerminalView {
  return { id, argv: ["/bin/zsh"], cwd: "/src/app", cols: 80, rows: 24, title: "", state: "running", exitCode: 0, startedAtMs: null, exitedAtMs: null, altScreen: false, labels };
}

const shell = { kind: "shell", thread: "s1", project: "r1", worktree: "/src/app" };
const closed = { open: false, query: "", commandName: null, page: "commands" as const, returnTo: "content" as const };

describe("the bottom panel's shell in the command context", () => {
  beforeEach(() => {
    const list = [term("claude", { thread: "s1" }), term("a", shell), term("b", shell)];
    useTerminalsStore.setState({ byId: Object.fromEntries(list.map((t) => [t.id, t])), order: list.map((t) => t.id), loaded: true });
    useProjectsStore.setState({ byId: {}, order: [] });
    useThreadsStore.setState({ byId: {}, order: [] });
    useBottomStore.setState({ byKey: { "thread:s1": { open: true, activeTerminalId: "a" } }, pendingFocus: null, pendingFocusId: null });
    useUiStore.setState({ selection: { kind: "thread", id: "s1" }, focus: "bottom", palette: closed });
  });

  it("deriveContext puts the focused shell in activeTerminalId and keeps the rest", () => {
    const sel = { kind: "thread", id: "s1" } as const;
    const plain = deriveContext(sel, useProjectsStore.getState());
    const focused = deriveContext(sel, useProjectsStore.getState(), undefined, { id: "a", labels: shell });
    expect(focused).toEqual({ ...plain, activeTerminalId: "a" });
    expect(focused.activeThreadId).toBe("s1");
  });

  const cases: [string, () => void, string][] = [
    ["keyboard in the bottom panel: its active shell", () => undefined, "a"],
    ["the palette opened from there: still that shell", () => useUiStore.setState({ focus: "palette", palette: { ...closed, open: true, returnTo: "bottom" } }), "a"],
    ["keyboard in the content pane: nothing from the bottom panel", () => useUiStore.setState({ focus: "content" }), ""],
    ["the panel closed", () => useBottomStore.setState({ byKey: { "thread:s1": { open: false, activeTerminalId: "a" } } }), ""],
  ];
  it.each(cases)("getUiContext: %s", (_name, arrange, want) => {
    arrange();
    expect(getUiContext().activeTerminalId).toBe(want);
    expect(getUiContext().activeThreadId).toBe("s1");
  });

  it("an explicit selection gets that selection's context only", () => {
    expect(getUiContext({ kind: "thread", id: "s1" }).activeTerminalId).toBe("");
  });
});

describe("a Projects-page shell in the command context", () => {
  const wtShell = { kind: "shell", project: "r1", worktree: "/src/app.worktrees/x" };
  beforeEach(() => {
    const list = [term("p", wtShell), term("q", { kind: "shell", worktree: "/src/y" })];
    useTerminalsStore.setState({ byId: Object.fromEntries(list.map((t) => [t.id, t])), order: list.map((t) => t.id), loaded: true });
    useProjectsStore.setState({ byId: {}, order: [] });
    useThreadsStore.setState({ byId: {}, order: [] });
    useUiStore.setState({ selection: { kind: "view", name: "projects" }, focus: "bottom", palette: closed });
  });

  const cases: [string, string, Partial<ReturnType<typeof getUiContext>>][] = [
    ["its project and worktree become the context (terminal.new starts beside it)", "p", { activeTerminalId: "p", activeProjectId: "r1", activeWorktreePath: "/src/app.worktrees/x", activeView: "projects" }],
    ["without a project label: the terminal only", "q", { activeTerminalId: "q", activeProjectId: "", activeWorktreePath: "", activeView: "projects" }],
  ];
  it.each(cases)("%s", (_name, active, want) => {
    useBottomStore.setState({ byKey: { "view:projects": { open: true, activeTerminalId: active } }, pendingFocus: null, pendingFocusId: null });
    expect(getUiContext()).toMatchObject(want);
  });

  it("a thread's shell keeps the thread's place", () => {
    const ctx = deriveContext({ kind: "thread", id: "s1" }, useProjectsStore.getState(), undefined, { id: "a", labels: shell });
    expect(ctx).toMatchObject({ activeTerminalId: "a", activeThreadId: "s1", activeProjectId: "", activeWorktreePath: "" });
  });

  it("the keyboard elsewhere on the page: no shell, no worktree", () => {
    useBottomStore.setState({ byKey: { "view:projects": { open: true, activeTerminalId: "p" } }, pendingFocus: null, pendingFocusId: null });
    useUiStore.setState({ focus: "content" });
    expect(getUiContext()).toMatchObject({ activeTerminalId: "", activeWorktreePath: "" });
  });
});

describe("the sidebar list's keys", () => {
  const thread = (o: Partial<ThreadView>) =>
    ({ id: "s1", state: "connected", status: "idle", statusReason: "", pinned: false, archivedAtMs: null, snoozedUntilMs: null, createdBy: "", inSidebar: null, ...o }) as ThreadView;
  type Want = { pinned: boolean; group: string; archivedAtMs: number | null; snoozedUntilMs: number | null; hidden?: true };

  it.each<[string, Partial<ThreadView>, boolean, Want]>([
    ["idle", {}, false, { pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null }],
    ["pinned and busy", { pinned: true, status: "busy" }, false, { pinned: true, group: "working", archivedAtMs: null, snoozedUntilMs: null }],
    ["archived", { state: "disconnected", archivedAtMs: 1760352000123 }, false, { pinned: false, group: "idle", archivedAtMs: 1760352000123, snoozedUntilMs: null }],
    ["snoozed", { state: "disconnected", snoozedUntilMs: 1760518800000 }, false, { pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: 1760518800000 }],
    [
      "woken (snooze ended)",
      { state: "disconnected", status: "attention", statusReason: "snooze ended" },
      false,
      { pinned: false, group: "prompt", archivedAtMs: null, snoozedUntilMs: null },
    ],
    ["created by a thread, setting off: hidden", { createdBy: "p" }, false, { pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null, hidden: true }],
    ["created by a thread, setting on: shown", { createdBy: "p" }, true, { pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null }],
    ["created by a thread, shown by its override", { createdBy: "p", inSidebar: true }, false, { pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null }],
    ["created by a thread, hidden by its override", { createdBy: "p", inSidebar: false }, true, { pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null, hidden: true }],
  ])("round-trips %s", (_name, o, showCreated, want) => {
    expect(decodeThreadListKeys([encodeThreadListKey("s1", thread(o), showCreated)])).toEqual([{ id: "s1", ...want }]);
  });

  it("an unknown thread decodes as an idle, unarchived, unsnoozed, shown thread", () => {
    expect(decodeThreadListKeys([encodeThreadListKey("s9", undefined, false)])).toEqual([{ id: "s9", pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null }]);
  });

  it("getListThreads and getListOptions read the stores (archive and snooze times, hidden threads, the collapsed states)", () => {
    useThreadsStore.setState({ byId: { s1: thread({ archivedAtMs: 5 }), s2: thread({ id: "s2", snoozedUntilMs: 7 }), s3: thread({ id: "s3", createdBy: "s1" }) }, order: ["s1", "s2", "s3"] });
    useUiStore.setState({ workingCollapsed: true, archivedCollapsed: false, snoozedCollapsed: true });
    expect(getListThreads(false)).toEqual([
      { id: "s1", pinned: false, group: "idle", archivedAtMs: 5, snoozedUntilMs: null },
      { id: "s2", pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: 7 },
      { id: "s3", pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null, hidden: true },
    ]);
    expect(getListThreads(true)[2]).toEqual({ id: "s3", pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null });
    expect(getListOptions()).toEqual({ workingCollapsed: true, archivedCollapsed: false, snoozedCollapsed: true });
  });
});
