import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TerminalView } from "@/api/terminal";
import type { ThreadView } from "@/api/threads";
import { needsList } from "@/lib/shellSections";
import { layoutOf, pane, seedLayout, space, tab } from "@/test/shellLayout";
import { decodeThreadListKeys, deriveContext, encodeThreadListKey, getListOptions, getListThreads, getUiContext } from "./context";
import { resetLayout } from "./layout";
import { useProjectsStore } from "./projects";
import { useTerminalsStore } from "./terminals";
import { useThreadsStore } from "./threads";
import { HOME, useUiStore } from "./ui";

describe("getUiContext", () => {
  beforeEach(() => {
    useProjectsStore.setState({ byId: {}, order: [] });
    useThreadsStore.setState({ byId: {}, order: [] });
    useUiStore.setState({ selection: { kind: "thread", id: "s1" } });
  });

  it("is the window's selection's context, or an explicit selection's", () => {
    expect(getUiContext()).toEqual(deriveContext({ kind: "thread", id: "s1" }, useProjectsStore.getState()));
    expect(getUiContext()).toMatchObject({ activeThreadId: "s1", activeTerminalId: "" });
    expect(getUiContext({ kind: "view", name: "projects" })).toMatchObject({ activeThreadId: "", activeView: "projects" });
  });
});

describe("the terminal the user is on, in the command context", () => {
  const term = (id: string, labels: Record<string, string>): TerminalView => ({ id, argv: ["/bin/zsh"], cwd: "/src/app", cols: 80, rows: 24, title: "", state: "running", exitCode: 0, startedAtMs: null, exitedAtMs: null, altScreen: false, liveCwd: "", foreground: "", lastCommand: "", labels });
  const terminals = [
    term("own", { kind: "shell", thread: "s1", project: "r1", worktree: "/src/app" }),
    term("wt", { kind: "shell", project: "r1", worktree: "/src/app.worktrees/x" }),
    term("home", { kind: "shell" }),
    term("quick", { kind: "shell", thread: "s1", project: "r1", worktree: "/src/app", slot: "quick" }),
  ];
  /** One pane: s1's tab and a terminal tab, `active` shown and focused. */
  const seed = (active: string, terminal: string, thread: string) =>
    seedLayout(layoutOf([space(pane("p-1", [tab("t-th", "thread", "s1"), tab("t-term", "terminal", thread, { params: { terminal } })], active), "p-1")]));
  let box: HTMLElement;

  beforeEach(() => {
    useProjectsStore.setState({ byId: {}, order: [] });
    useThreadsStore.setState({ byId: {}, order: [] });
    useTerminalsStore.setState({ byId: Object.fromEntries(terminals.map((t) => [t.id, t])), order: terminals.map((t) => t.id), loaded: true });
    // The quick terminal's drawing, with a field that can hold the keyboard.
    box = document.createElement("div");
    box.setAttribute("data-quick-terminal", "s1");
    box.append(document.createElement("textarea"));
    document.body.append(box);
  });
  afterEach(() => {
    box.remove();
    resetLayout();
    useUiStore.getState().closePalette();
  });

  const cases: [string, () => Promise<void>, Parameters<typeof getUiContext>[0] & object, Record<string, string>][] = [
    ["a focused thread's shell tab: the shell, with the thread's place", () => seed("t-term", "own", "s1"), { kind: "thread", id: "s1" }, { activeTerminalId: "own", activeThreadId: "s1" }],
    ["a focused worktree shell's tab (no thread): the shell, its project and worktree", () => seed("t-term", "wt", ""), HOME, { activeTerminalId: "wt", activeProjectId: "r1", activeWorktreePath: "/src/app.worktrees/x", activeThreadId: "" }],
    ["a focused home shell's tab: the shell only", () => seed("t-term", "home", ""), HOME, { activeTerminalId: "home", activeProjectId: "", activeWorktreePath: "" }],
    ["the thread's tab focused: no terminal", () => seed("t-th", "own", "s1"), { kind: "thread", id: "s1" }, { activeTerminalId: "", activeThreadId: "s1" }],
    [
      "the thread's tab focused, the keyboard in its quick terminal: the quick terminal",
      async () => {
        await seed("t-th", "own", "s1");
        box.querySelector("textarea")?.focus();
      },
      { kind: "thread", id: "s1" },
      { activeTerminalId: "quick", activeThreadId: "s1" },
    ],
    [
      "the palette opened from the quick terminal: still the quick terminal",
      async () => {
        await seed("t-th", "own", "s1");
        box.querySelector("textarea")?.focus();
        useUiStore.getState().openPalette();
        (document.activeElement as HTMLElement | null)?.blur();
      },
      { kind: "thread", id: "s1" },
      { activeTerminalId: "quick" },
    ],
  ];
  it.each(cases)("%s", async (_name, arrange, sel, want) => {
    useUiStore.setState({ selection: sel });
    await arrange();
    expect(getUiContext()).toMatchObject(want);
    // An explicit selection's context has no terminal.
    expect(getUiContext(sel).activeTerminalId).toBe("");
  });
});

describe("the sidebar list's keys", () => {
  const thread = (o: Partial<ThreadView>) =>
    ({ id: "s1", state: "connected", status: "idle", statusReason: "", pinned: false, archivedAtMs: null, snoozedUntilMs: null, createdBy: "", statusChangedAtMs: 100, lastActivityAtMs: 200, ...o }) as ThreadView;
  type Want = { pinned: boolean; group: string; archivedAtMs: number | null; snoozedUntilMs: number | null; statusChangedAtMs: number | null; lastActivityAtMs: number | null; hidden?: true; nudge?: true };
  // The keys carry only the band's sort time: the last activity for idle, the status change for attention and done.
  const IDLE = { statusChangedAtMs: null, lastActivityAtMs: 200 };
  const BY_STATUS = { statusChangedAtMs: 100, lastActivityAtMs: null };
  const NONE = { statusChangedAtMs: null, lastActivityAtMs: null };
  // The thread list the rule looks creators up in: "p" exists, "gone" was removed.
  const BY_ID = { p: {} };

  it.each<[string, Partial<ThreadView>, Want]>([
    ["idle", {}, { pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null, ...IDLE }],
    ["finished", { status: "attention", statusReason: "finished" }, { pinned: false, group: "done", archivedAtMs: null, snoozedUntilMs: null, ...BY_STATUS }],
    ["error", { state: "disconnected", status: "error", statusReason: "crashed" }, { pinned: false, group: "error", archivedAtMs: null, snoozedUntilMs: null, ...BY_STATUS }],
    ["working", { status: "busy" }, { pinned: false, group: "working", archivedAtMs: null, snoozedUntilMs: null, ...NONE }],
    ["pinned and idle", { pinned: true }, { pinned: true, group: "idle", archivedAtMs: null, snoozedUntilMs: null, ...NONE }],
    ["idle, times unknown", { statusChangedAtMs: null, lastActivityAtMs: null }, { pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null, ...NONE }],
    ["pinned and busy", { pinned: true, status: "busy" }, { pinned: true, group: "working", archivedAtMs: null, snoozedUntilMs: null, ...NONE }],
    // Needs you lists a pinned thread that asks by its ask's time, like any other.
    ["pinned and asking", { pinned: true, status: "attention", statusReason: "permission: Bash" }, { pinned: true, group: "prompt", archivedAtMs: null, snoozedUntilMs: null, ...BY_STATUS }],
    ["archived", { state: "disconnected", archivedAtMs: 1760352000123 }, { pinned: false, group: "idle", archivedAtMs: 1760352000123, snoozedUntilMs: null, ...NONE }],
    ["snoozed", { state: "disconnected", snoozedUntilMs: 1760518800000 }, { pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: 1760518800000, ...NONE }],
    // Needs you lists only actionable asks; the rest of the prompt group calls without blocking
    // (nudge): the top of Active rather than Needs you.
    ...(
      [
        ["woken (snooze ended)", { state: "disconnected", status: "attention", statusReason: "snooze ended" }],
        ["a terminal notification", { status: "attention", statusReason: "notification: Build done" }],
        ["a bell", { status: "attention", statusReason: "bell" }],
        ["an API error at the prompt", { status: "attention", statusReason: "error: overloaded_error" }],
        ["another attention reason", { status: "attention", statusReason: "blocked: waiting on a lock" }],
        ["an unknown attention reason", { status: "attention", statusReason: "something new" }],
        ["a plugin's attention flag", { flags: [{ plugin: "p", pluginName: "P", level: "attention", reason: "Look" }] } as unknown as Partial<ThreadView>],
      ] as const
    ).map(([name, o]): [string, Partial<ThreadView>, Want] => [`${name}: a nudge`, o, { pinned: false, group: "prompt", archivedAtMs: null, snoozedUntilMs: null, ...BY_STATUS, nudge: true }]),
    ...(
      [
        ["a permission", "permission: Bash"],
        ["a question", "question: Which?"],
        ["a plan", "plan: Ready?"],
        ["a folder trust dialog", "trust: Trust this folder?"],
      ] as const
    ).map(([name, reason]): [string, Partial<ThreadView>, Want] => [`${name}: an actionable ask`, { status: "attention", statusReason: reason }, { pinned: false, group: "prompt", archivedAtMs: null, snoozedUntilMs: null, ...BY_STATUS }]),
    ["created by a thread, its creator present: hidden", { createdBy: "p" }, { pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null, ...IDLE, hidden: true }],
    ["created by a thread, its creator removed: shown", { createdBy: "gone" }, { pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null, ...IDLE }],
  ])("round-trips %s", (_name, o, want) => {
    expect(decodeThreadListKeys([encodeThreadListKey("s1", thread(o), BY_ID)])).toEqual([{ id: "s1", ...want }]);
  });

  it("an unknown thread decodes as an idle, unarchived, unsnoozed, shown thread", () => {
    expect(decodeThreadListKeys([encodeThreadListKey("s9", undefined, BY_ID)])).toEqual([{ id: "s9", pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null, ...NONE }]);
  });

  it("getListThreads and getListOptions read the stores (archive and snooze times, hidden and orphaned threads, the collapsed states)", () => {
    useThreadsStore.setState({ byId: { s1: thread({ archivedAtMs: 5 }), s2: thread({ id: "s2", snoozedUntilMs: 7 }), s3: thread({ id: "s3", createdBy: "s1" }), s4: thread({ id: "s4", createdBy: "gone" }) }, order: ["s1", "s2", "s3", "s4"] });
    useUiStore.setState({ workingCollapsed: true, archivedCollapsed: false, snoozedCollapsed: true, selection: HOME });
    // What the keys decode to: the band's sort times only, as the list is drawn from.
    expect(getListThreads()).toEqual([
      { id: "s1", pinned: false, group: "idle", archivedAtMs: 5, snoozedUntilMs: null, ...NONE },
      { id: "s2", pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: 7, ...NONE },
      // Its creator (s1, archived) still exists: hidden.
      { id: "s3", pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null, ...IDLE, hidden: true },
      // Its creator was removed: shown.
      { id: "s4", pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null, ...IDLE },
    ]);
    expect(getListOptions()).toEqual({ workingCollapsed: true, archivedCollapsed: false, snoozedCollapsed: true, openThreadId: null });
    // The open thread keeps its row under a collapsed header, so cmd+1..9 count it as the sidebar shows it.
    useUiStore.setState({ selection: { kind: "thread", id: "s2" } });
    expect(getListOptions().openThreadId).toBe("s2");
  });

  it("Needs you is one order, drawn and walked by the keys: most recent ask first, a pinned asker too", () => {
    const ask = (id: string, at: number, pinned = false) => thread({ id, pinned, status: "attention", statusReason: "question: Which?", statusChangedAtMs: at });
    useThreadsStore.setState({ byId: { a: ask("a", 100), b: ask("b", 300, true), c: ask("c", 200) }, order: ["a", "b", "c"] });
    const opts = { needsScope: "all" as const, currentSpaceId: "sp" };
    const s = useThreadsStore.getState();
    const drawn = needsList(decodeThreadListKeys(s.order.map((id) => encodeThreadListKey(id, s.byId[id], s.byId))).map((t) => ({ ...t, spaceId: "sp" })), opts).ids;
    const walked = needsList(getListThreads().map((t) => ({ ...t, spaceId: "sp" })), opts).ids;
    expect(drawn).toEqual(["b", "c", "a"]);
    expect(walked).toEqual(drawn);
  });
});
