import { beforeEach, describe, expect, it } from "vitest";
import type { TerminalView } from "@/api/terminal";
import {
  activate,
  bottomVisible,
  focusedBottomShell,
  markPendingFocusId,
  neighbourOf,
  takePendingFocusId,
  activeTabOf,
  bottomKeyOf,
  bottomTabIds,
  bottomTabTitle,
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

const shell = (session: string, worktree = "/src/app") => ({ kind: "shell", repo: "r", worktree, ...(session ? { session } : {}) });

function data(list: TerminalView[]): TerminalsData {
  return { byId: Object.fromEntries(list.map((t) => [t.id, t])), order: list.map((t) => t.id) };
}

describe("bottomKeyOf", () => {
  const cases: [string, Selection, string | null][] = [
    ["a thread", { kind: "session", id: "s1" }, "session:s1"],
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
    ["a thread's shell", shell("s1"), "session:s1"],
    ["a worktree's shell", shell(""), "view:projects"],
    ["a thread's Claude terminal (session, no kind)", { session: "s1", worktree: "/src/app" }, null],
    ["an unlabelled terminal", {}, null],
    ["another kind", { kind: "job", session: "s1" }, null],
  ];
  it.each(cases)("%s", (_name, labels, want) => {
    expect(ownerKeyOf({ labels })).toBe(want);
  });
});

describe("bottomTabIds", () => {
  const terminals = data([
    term("claude", { session: "s1", worktree: "/src/app" }),
    term("a", shell("s1")),
    term("w1", shell("")),
    term("b", shell("s2")),
    term("loose", {}),
    term("c", shell("s1")),
    term("w2", shell("", "/src/app.worktrees/x")),
  ]);
  const cases: [string, string, string[]][] = [
    ["a thread: its shells in store order, not its Claude terminal", "session:s1", ["a", "c"]],
    ["another thread", "session:s2", ["b"]],
    ["a thread without shells", "session:s3", []],
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
    ["a thread's shell: its title", { title: "vim main.go", cwd: "/src/app/cmd" }, "session:s1", "vim main.go"],
    ["a thread's shell without a title: its cwd's last segment", { cwd: "/src/app/cmd/" }, "session:s1", "cmd"],
    ["the Projects page: the worktree's folder, whatever the title", { title: "vim", cwd: "/src/app.worktrees/x/sub", labels: shell("", "/src/app.worktrees/x") }, "view:projects", "x"],
    ["the Projects page without a worktree label: the cwd's", { cwd: "/src/other", labels: { kind: "shell" } }, "view:projects", "other"],
  ];
  it.each(cases)("%s", (_name, extra, key, want) => {
    expect(bottomTabTitle(term("t", shell("s1"), extra), key)).toBe(want);
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
    ["open, nothing over it", "session:a", true, false, false, true],
    ["no key", null, true, false, false, false],
    ["closed", "session:a", false, false, false, false],
    ["settings or usage up", "session:a", true, true, false, false],
    ["side panel expanded", "session:a", true, false, true, false],
  ];
  it.each(cases)("%s", (_name, key, open, page, side, want) => {
    expect(bottomVisible(key, open, page, side)).toBe(want);
  });
});

describe("focusedBottomShell", () => {
  const terminals = data([term("claude", { session: "s1" }), term("a", shell("s1")), term("b", shell("s1"))]);
  const closed = { open: false, returnTo: "content" };
  const cases: [string, Selection, string, { open: boolean; returnTo: string }, Record<string, BottomEntry>, string][] = [
    ["keyboard in the panel: its active shell", { kind: "session", id: "s1" }, "bottom", closed, { "session:s1": { open: true, activeTerminalId: "a" } }, "a"],
    ["no remembered tab: the last", { kind: "session", id: "s1" }, "bottom", closed, { "session:s1": { open: true } }, "b"],
    ["the palette returns there", { kind: "session", id: "s1" }, "palette", { open: true, returnTo: "bottom" }, { "session:s1": { open: true } }, "b"],
    ["keyboard in the content pane", { kind: "session", id: "s1" }, "terminal", closed, { "session:s1": { open: true } }, ""],
    ["panel closed", { kind: "session", id: "s1" }, "bottom", closed, { "session:s1": { open: false } }, ""],
    ["no tabs", { kind: "session", id: "s2" }, "bottom", closed, { "session:s2": { open: true } }, ""],
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

describe("store", () => {
  beforeEach(() => {
    useBottomStore.setState({ byKey: {}, pendingFocus: null, pendingFocusId: null });
    useUiStore.setState({ selection: { kind: "session", id: "s1" }, bottomFocusSeq: 0 });
  });

  it("toggleBottom works on the current selection's key and asks for focus only when showing", () => {
    expect(toggleBottom("current", undefined, { focus: true })).toBe(true);
    expect(getBottom("session:s1").open).toBe(true);
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
    setBottomHeight("session:s1", 333.4);
    expect(getBottom("session:s1").height).toBe(333);
    expect(getBottom("session:s2").height).toBeUndefined();
  });

  it("pending focus is taken once, for its key, while recent", () => {
    markPendingFocus("session:s1", 1000);
    expect(takePendingFocus("session:s2", 1001)).toBe(false);
    expect(takePendingFocus("session:s1", 1000 + PENDING_FOCUS_MS + 1)).toBe(false);
    expect(takePendingFocus("session:s1", 1002)).toBe(true);
    expect(takePendingFocus("session:s1", 1003)).toBe(false);
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

  it("persists byKey (not the pending focus) and rehydrates it", async () => {
    toggleBottom("session:s1", true);
    setBottomHeight("session:s1", 360);
    markPendingFocus("session:s1");
    const raw = localStorage.getItem("code-foundry.bottom") ?? "{}";
    expect((JSON.parse(raw) as { state: unknown }).state).toEqual({ byKey: { "session:s1": { open: true, height: 360 } } });
    // Clearing the store saves too; put the saved value back before loading it.
    useBottomStore.setState({ byKey: {}, pendingFocus: null, pendingFocusId: null });
    localStorage.setItem("code-foundry.bottom", raw);
    await useBottomStore.persist.rehydrate();
    expect(getBottom("session:s1")).toEqual({ open: true, height: 360 });
  });
});
