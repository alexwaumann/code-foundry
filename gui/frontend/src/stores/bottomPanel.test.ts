import { beforeEach, describe, expect, it } from "vitest";
import type { TerminalView } from "@/api/terminal";
import {
  activate,
  bottomVisible,
  clearStarting,
  emptyOpenKeys,
  isStarting,
  markStarting,
  focusedBottomShell,
  markPendingFocusId,
  neighbourOf,
  takePendingFocusId,
  activeTabOf,
  bottomKeyOf,
  bottomTabIds,
  bottomTabTitle,
  bottomTabTitleOf,
  bottomTabTitles,
  emptyBottom,
  getBottom,
  markPendingFocus,
  openOn,
  ownerKeyOf,
  PENDING_FOCUS_MS,
  setBottomHeight,
  setHeight,
  setOpen,
  takePendingFocus,
  toggleBottom,
  useBottomStore,
  type BottomEntry,
} from "./bottomPanel";
import type { TerminalsData } from "./terminals";
import { DASHBOARD, useUiStore, type Selection } from "./ui";

function term(id: string, labels: Record<string, string>, extra: Partial<TerminalView> = {}): TerminalView {
  return { id, argv: ["/bin/zsh"], cwd: "/src/app", cols: 80, rows: 24, title: "", state: "running", exitCode: 0, startedAtMs: null, exitedAtMs: null, altScreen: false, labels, ...extra };
}

const shell = (thread: string, worktree = "/src/app") => ({ kind: "shell", repo: "r", worktree, ...(thread ? { thread } : {}) });

function data(list: TerminalView[]): TerminalsData {
  return { byId: Object.fromEntries(list.map((t) => [t.id, t])), order: list.map((t) => t.id) };
}

describe("bottomKeyOf", () => {
  const cases: [string, Selection, string | null][] = [
    ["a thread", { kind: "thread", id: "s1" }, "thread:s1"],
    ["the Projects page", { kind: "view", name: "projects" }, "view:projects"],
    ["the dashboard", DASHBOARD, null],
    ["nothing", { kind: "none" }, null],
    ["the Pull Requests page", { kind: "view", name: "pullrequests" }, null],
    ["the composer", { kind: "compose", repoId: "r" }, null],
  ];
  it.each(cases)("%s", (_name, sel, want) => {
    expect(bottomKeyOf(sel)).toBe(want);
  });
});

describe("ownerKeyOf", () => {
  const cases: [string, Record<string, string>, string | null][] = [
    ["a thread's shell", shell("s1"), "thread:s1"],
    ["a worktree's shell", shell(""), "view:projects"],
    ["a thread-labelled terminal that is no shell (thread, no kind)", { thread: "s1", worktree: "/src/app" }, null],
    ["an unlabelled terminal", {}, null],
    ["another kind", { kind: "job", thread: "s1" }, null],
    ["a thread's action run", { kind: "action", thread: "s1", action: "a-1", "action.name": "Test", "action.run": "r-1" }, "thread:s1"],
    ["a worktree's action run", { kind: "action", repo: "r", worktree: "/src/app", action: "a-1" }, "view:projects"],
  ];
  it.each(cases)("%s", (_name, labels, want) => {
    expect(ownerKeyOf({ labels })).toBe(want);
  });
});

describe("bottomTabIds", () => {
  const terminals = data([
    term("claude", { thread: "s1", worktree: "/src/app" }),
    term("a", shell("s1")),
    term("w1", shell("")),
    term("b", shell("s2")),
    term("loose", {}),
    term("c", shell("s1")),
    term("w2", shell("", "/src/app.worktrees/x")),
    term("run", { kind: "action", thread: "s1", "action.name": "Test" }, { state: "exited", exitCode: 1 }),
  ]);
  const cases: [string, string, string[]][] = [
    ["a thread: its shells and action runs (exited too) in store order, not a non-shell terminal", "thread:s1", ["a", "c", "run"]],
    ["another thread", "thread:s2", ["b"]],
    ["a thread without shells", "thread:s3", []],
    ["the Projects page: every shell no thread owns", "view:projects", ["w1", "w2"]],
    ["any other key", "view:pullrequests", []],
  ];
  it.each(cases)("%s", (_name, key, want) => {
    expect(bottomTabIds(terminals, key)).toEqual(want);
  });
});

describe("activeTabOf", () => {
  const cases: [string, BottomEntry, string[], string | null][] = [
    ["the remembered tab", { open: true, activeTerminalId: "a" }, ["a", "b"], "a"],
    ["none remembered: the last tab", { open: true }, ["a", "b"], "b"],
    ["the remembered tab is gone: the last tab", { open: true, activeTerminalId: "x" }, ["a", "b"], "b"],
    ["no tabs", { open: true, activeTerminalId: "a" }, [], null],
  ];
  it.each(cases)("%s", (_name, entry, ids, want) => {
    expect(activeTabOf(entry, ids)).toBe(want);
  });
});

describe("bottomTabTitle", () => {
  const cases: [string, Partial<TerminalView>, string, string][] = [
    ["a thread's shell: its title", { title: "vim main.go", cwd: "/src/app/cmd" }, "thread:s1", "vim main.go"],
    ["a thread's shell without a title: its cwd's last segment", { cwd: "/src/app/cmd/" }, "thread:s1", "cmd"],
    ["the Projects page: the worktree's folder, whatever the title", { title: "vim", cwd: "/src/app.worktrees/x/sub", labels: shell("", "/src/app.worktrees/x") }, "view:projects", "x"],
    ["the Projects page without a worktree label: the cwd's", { cwd: "/src/other", labels: { kind: "shell" } }, "view:projects", "other"],
    ["an action run: the action's name, not its OSC title", { title: "zsh", labels: { kind: "action", thread: "s1", "action.name": "Test" } }, "thread:s1", "Test"],
    ["an action run on the Projects page: the action's name", { labels: { kind: "action", worktree: "/src/app", "action.name": "Build" } }, "view:projects", "Build"],
  ];
  it.each(cases)("%s", (_name, extra, key, want) => {
    expect(bottomTabTitle(term("t", shell("s1"), extra), key)).toBe(want);
  });
  it.each([
    ["a shell in the thread's home: No project", { cwd: "/Users/dev", labels: { kind: "shell", thread: "s1", repo: "", worktree: "/Users/dev" } }, "No project"],
    ["one elsewhere: its folder", { cwd: "/Users/dev/notes", labels: { kind: "shell", thread: "s1", repo: "", worktree: "/Users/dev" } }, "notes"],
    ["its own title wins", { title: "htop", cwd: "/Users/dev", labels: { kind: "shell", thread: "s1", repo: "", worktree: "/Users/dev" } }, "htop"],
  ] as [string, Partial<TerminalView>, string][])("a thread without a project: %s", (_name, extra, want) => {
    expect(bottomTabTitle(term("t", {}, extra), "thread:s1", true)).toBe(want);
  });
});

describe("bottomTabTitles (duplicates numbered)", () => {
  const terms = (list: TerminalView[]) => ({ byId: Object.fromEntries(list.map((t) => [t.id, t])), order: list.map((t) => t.id) });
  const cases: [string, TerminalView[], string, Record<string, string>][] = [
    [
      "two runs of one action: the second is numbered",
      [term("a", { kind: "action", thread: "s1", "action.name": "Test" }, { title: "zsh" }), term("b", shell("s1")), term("c", { kind: "action", thread: "s1", "action.name": "Test" })],
      "thread:s1",
      { a: "Test", b: "app", c: "Test 2" },
    ],
    [
      "two shells in one folder: the second is numbered",
      [term("a", shell("s1")), term("b", shell("s1"))],
      "thread:s1",
      { a: "app", b: "app 2" },
    ],
    [
      "an OSC title wins and takes no number",
      [term("a", shell("s1")), term("b", shell("s1"), { title: "vim" }), term("c", shell("s1"))],
      "thread:s1",
      { a: "app", b: "vim", c: "app 2" },
    ],
    [
      "different folders are not numbered; other keys' shells do not count",
      [term("a", shell("s1")), term("x", shell("s2")), term("b", shell("s1"), { cwd: "/src/app/cmd" }), term("c", shell("s1"))],
      "thread:s1",
      { a: "app", b: "cmd", c: "app 2" },
    ],
    [
      "the Projects page numbers by worktree folder, in store order",
      [term("w1", shell("", "/src/x")), term("w2", shell("", "/src/y")), term("w3", shell("", "/src/x"), { title: "top" }), term("w4", shell("", "/src/x"))],
      "view:projects",
      { w1: "x", w2: "y", w3: "x 2", w4: "x 3" },
    ],
  ];
  it.each(cases)("%s", (_name, list, key, want) => {
    expect(bottomTabTitles(terms(list), key)).toEqual(want);
  });
  it("bottomTabTitleOf: one tab's title, the id for a stranger", () => {
    const t = terms([term("a", shell("s1")), term("b", shell("s1"))]);
    expect(bottomTabTitleOf(t, "thread:s1", "b")).toBe("app 2");
    expect(bottomTabTitleOf(t, "thread:s1", "zz")).toBe("zz");
  });
});

describe("neighbourOf", () => {
  const cases: [string, string[], string, string | null][] = [
    ["the one after", ["a", "b", "c"], "b", "c"],
    ["the last: the one before", ["a", "b", "c"], "c", "b"],
    ["the only one: none", ["a"], "a", null],
    ["unknown", ["a"], "x", null],
  ];
  it.each(cases)("%s", (_name, ids, id, want) => {
    expect(neighbourOf(ids, id)).toBe(want);
  });
});

describe("bottomVisible", () => {
  const cases: [string, string | null, boolean, boolean, boolean, boolean][] = [
    ["open, nothing over it", "thread:a", true, false, false, true],
    ["no key", null, true, false, false, false],
    ["closed", "thread:a", false, false, false, false],
    ["settings or usage up", "thread:a", true, true, false, false],
    ["side panel expanded", "thread:a", true, false, true, false],
  ];
  it.each(cases)("%s", (_name, key, open, page, side, want) => {
    expect(bottomVisible(key, open, page, side)).toBe(want);
  });
});

describe("focusedBottomShell", () => {
  const terminals = data([term("claude", { thread: "s1" }), term("a", shell("s1")), term("b", shell("s1"))]);
  const closed = { open: false, returnTo: "content" };
  const cases: [string, Selection, string, { open: boolean; returnTo: string }, Record<string, BottomEntry>, string][] = [
    ["keyboard in the panel: its active shell", { kind: "thread", id: "s1" }, "bottom", closed, { "thread:s1": { open: true, activeTerminalId: "a" } }, "a"],
    ["no remembered tab: the last", { kind: "thread", id: "s1" }, "bottom", closed, { "thread:s1": { open: true } }, "b"],
    ["the palette returns there", { kind: "thread", id: "s1" }, "palette", { open: true, returnTo: "bottom" }, { "thread:s1": { open: true } }, "b"],
    ["keyboard in the content pane", { kind: "thread", id: "s1" }, "terminal", closed, { "thread:s1": { open: true } }, ""],
    ["panel closed", { kind: "thread", id: "s1" }, "bottom", closed, { "thread:s1": { open: false } }, ""],
    ["no tabs", { kind: "thread", id: "s2" }, "bottom", closed, { "thread:s2": { open: true } }, ""],
    ["no bottom key", { kind: "view", name: "pullrequests" }, "bottom", closed, {}, ""],
  ];
  it.each(cases)("%s", (_name, selection, focus, palette, byKey, want) => {
    expect(focusedBottomShell({ selection, focus, palette }, terminals, byKey)).toBe(want);
  });
});

describe("reducers", () => {
  it("setOpen flips or forces, and keeps identity when unchanged", () => {
    const e: BottomEntry = { open: false, height: 300, activeTerminalId: "a" };
    expect(setOpen(e)).toEqual({ open: true, height: 300, activeTerminalId: "a" });
    expect(setOpen(e, false)).toBe(e);
    expect(setOpen(setOpen(e, true))).toEqual(e);
  });

  it("setHeight stores or drops the height, keeping the rest", () => {
    const e: BottomEntry = { open: true, activeTerminalId: "a" };
    const tall = setHeight(e, 400);
    expect(tall).toEqual({ open: true, activeTerminalId: "a", height: 400 });
    expect(setHeight(tall, 400)).toBe(tall);
    expect(setHeight(tall, undefined)).toEqual(e);
    expect("height" in setHeight(tall, undefined)).toBe(false);
  });

  it("activate remembers the tab; openOn also shows the panel", () => {
    expect(activate(emptyBottom, "a")).toEqual({ open: false, activeTerminalId: "a" });
    const e = { open: true, activeTerminalId: "a" };
    expect(activate(e, "a")).toBe(e);
    expect(openOn({ open: false, height: 200 }, "b")).toEqual({ open: true, height: 200, activeTerminalId: "b" });
  });
});

describe("emptyOpenKeys", () => {
  const terminals = data([term("claude", { thread: "s1" }), term("a", shell("s1")), term("w", shell(""))]);
  const cases: [string, Record<string, BottomEntry>, Record<string, number>, string[]][] = [
    ["an open thread panel with a shell stays", { "thread:s1": { open: true } }, {}, []],
    ["an open thread panel without shells (its Claude terminal does not count)", { "thread:s2": { open: true } }, {}, ["thread:s2"]],
    ["a closed one is left alone", { "thread:s2": { open: false } }, {}, []],
    ["one waiting on a shell this window starts", { "thread:s2": { open: true } }, { "thread:s2": 1 }, []],
    ["the Projects page with a worktree shell stays", { "view:projects": { open: true } }, {}, []],
    ["several", { "thread:s1": { open: true }, "thread:s3": { open: true, height: 300 }, "thread:s4": { open: true } }, {}, ["thread:s3", "thread:s4"]],
  ];
  it.each(cases)("%s", (_name, byKey, starting, want) => {
    expect(emptyOpenKeys(byKey, terminals, starting)).toEqual(want);
  });

  it("the Projects page without worktree shells", () => {
    expect(emptyOpenKeys({ "view:projects": { open: true } }, data([term("a", shell("s1"))]))).toEqual(["view:projects"]);
  });
});

describe("store", () => {
  beforeEach(() => {
    useBottomStore.setState({ byKey: {}, pendingFocus: null, pendingFocusId: null, starting: {} });
    useUiStore.setState({ selection: { kind: "thread", id: "s1" }, bottomFocusSeq: 0 });
  });

  it("toggleBottom works on the current selection's key and asks for focus only when showing", () => {
    expect(toggleBottom("current", undefined, { focus: true })).toBe(true);
    expect(getBottom("thread:s1").open).toBe(true);
    expect(useUiStore.getState().bottomFocusSeq).toBe(1);
    expect(toggleBottom("current", undefined, { focus: true })).toBe(false);
    expect(useUiStore.getState().bottomFocusSeq).toBe(1);
  });

  it("toggleBottom is a no-op without a key", () => {
    useUiStore.setState({ selection: { kind: "view", name: "pullrequests" } });
    expect(toggleBottom("current", true, { focus: true })).toBe(false);
    expect(useBottomStore.getState().byKey).toEqual({});
    expect(useUiStore.getState().bottomFocusSeq).toBe(0);
  });

  it("keeps heights per key", () => {
    setBottomHeight("thread:s1", 333.4);
    expect(getBottom("thread:s1").height).toBe(333);
    expect(getBottom("thread:s2").height).toBeUndefined();
  });

  it("pending focus is taken once, for its key, while recent", () => {
    markPendingFocus("thread:s1", 1000);
    expect(takePendingFocus("thread:s2", 1001)).toBe(false);
    expect(takePendingFocus("thread:s1", 1000 + PENDING_FOCUS_MS + 1)).toBe(false);
    expect(takePendingFocus("thread:s1", 1002)).toBe(true);
    expect(takePendingFocus("thread:s1", 1003)).toBe(false);
    markPendingFocus(null);
    expect(useBottomStore.getState().pendingFocus).toBeNull();
  });

  it("pending focus by id is taken once, for that shell, while recent", () => {
    markPendingFocusId("t1", 1000);
    expect(takePendingFocusId("t2", 1001)).toBe(false);
    expect(takePendingFocusId("t1", 1000 + PENDING_FOCUS_MS + 1)).toBe(false);
    expect(takePendingFocusId("t1", 1002)).toBe(true);
    expect(takePendingFocusId("t1", 1003)).toBe(false);
  });

  it("a start mark is per key, waits PENDING_FOCUS_MS, and is cleared only by its own start when `at` is given", () => {
    markStarting("thread:s1", 1000);
    expect(isStarting("thread:s1", 1000 + PENDING_FOCUS_MS)).toBe(true);
    expect(isStarting("thread:s1", 1000 + PENDING_FOCUS_MS + 1)).toBe(false);
    expect(isStarting("thread:s2", 1001)).toBe(false);
    clearStarting("thread:s1", 999); // an older start's timer
    expect(useBottomStore.getState().starting).toEqual({ "thread:s1": 1000 });
    clearStarting("thread:s1", 1000);
    expect(useBottomStore.getState().starting).toEqual({});
    markStarting("thread:s1", 2000);
    clearStarting("thread:s1");
    expect(useBottomStore.getState().starting).toEqual({});
  });

  it("persists byKey (not the pending focus or start marks) and rehydrates it", async () => {
    toggleBottom("thread:s1", true);
    setBottomHeight("thread:s1", 360);
    markPendingFocus("thread:s1");
    markStarting("thread:s2");
    const raw = localStorage.getItem("code-foundry.bottom") ?? "{}";
    expect((JSON.parse(raw) as { state: unknown }).state).toEqual({ byKey: { "thread:s1": { open: true, height: 360 } } });
    // Clearing the store saves too; put the saved value back before loading it.
    useBottomStore.setState({ byKey: {}, pendingFocus: null, pendingFocusId: null, starting: {} });
    localStorage.setItem("code-foundry.bottom", raw);
    await useBottomStore.persist.rehydrate();
    expect(getBottom("thread:s1")).toEqual({ open: true, height: 360 });
  });
});
