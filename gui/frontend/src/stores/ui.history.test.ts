import { beforeEach, describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import { useProjectsStore } from "./projects";
import { useThreadsStore } from "./threads";
import { DASHBOARD, HISTORY_MAX, pruneHistory, useUiStore, type Selection } from "./ui";
import { historyCommand, showView, useViewsStore } from "./views";
import { useWorkspacesStore } from "./workspaces";

const thread = (id: string): Selection => ({ kind: "thread", id });
const projects: Selection = { kind: "view", name: "projects" };
const prs: Selection = { kind: "view", name: "pullrequests" };

/** The threads store holding these ids (only membership matters to history). */
function threadsExist(...ids: string[]): void {
  useThreadsStore.setState({ loaded: true, byId: Object.fromEntries(ids.map((id) => [id, { id } as unknown as ThreadView])), order: ids });
}

function state() {
  const s = useUiStore.getState();
  return { selection: s.selection, history: s.history, index: s.historyIndex };
}

describe("selection history", () => {
  beforeEach(() => {
    threadsExist("a", "b", "c");
    useProjectsStore.setState({ loaded: false, byId: {}, order: [] });
    useWorkspacesStore.setState({ loaded: false, byId: {}, order: [] });
    useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false, helpOpen: false });
    useUiStore.setState({ selection: DASHBOARD, history: [DASHBOARD], historyIndex: 0, promptFocusSeq: 0 });
  });

  it("starts on the dashboard as entry 0, with nothing to go back or forward to", () => {
    expect(useUiStore.getInitialState().history).toEqual([DASHBOARD]);
    expect(useUiStore.getInitialState().historyIndex).toBe(0);
    expect(useUiStore.getState().back()).toBe(false);
    expect(useUiStore.getState().forward()).toBe(false);
    expect(state()).toEqual({ selection: DASHBOARD, history: [DASHBOARD], index: 0 });
  });

  it("select pushes every kind of selection after the current entry", () => {
    const ui = useUiStore.getState();
    ui.select(thread("a"));
    ui.select(projects);
    ui.select({ kind: "compose", projectId: "", noProject: true });
    ui.select(thread("b"));
    expect(state().history).toEqual([DASHBOARD, thread("a"), projects, { kind: "compose", projectId: "", noProject: true }, thread("b")]);
    expect(state().index).toBe(4);
  });

  it("does not push a selection equal to the current entry", () => {
    const ui = useUiStore.getState();
    ui.select(thread("a"));
    ui.select({ kind: "thread", id: "a" }, { focusPrompt: true });
    ui.select(DASHBOARD);
    ui.select({ kind: "view", name: "dashboard" });
    expect(state().history).toEqual([DASHBOARD, thread("a"), DASHBOARD]);
  });

  it("back and forward move through the entries without pushing", () => {
    const ui = useUiStore.getState();
    ui.select(thread("a"));
    ui.select(projects);
    ui.select(thread("b"));
    expect(ui.back()).toBe(true);
    expect(state()).toMatchObject({ selection: projects, index: 2 });
    expect(ui.back()).toBe(true);
    expect(ui.back()).toBe(true);
    expect(state()).toMatchObject({ selection: DASHBOARD, index: 0 });
    expect(ui.back()).toBe(false);
    expect(ui.forward()).toBe(true);
    expect(ui.forward()).toBe(true);
    expect(ui.forward()).toBe(true);
    expect(state()).toEqual({ selection: thread("b"), history: [DASHBOARD, thread("a"), projects, thread("b")], index: 3 });
    expect(ui.forward()).toBe(false);
  });

  it("stepping onto a thread asks its prompt for focus, like a sidebar pick", () => {
    const ui = useUiStore.getState();
    ui.select(thread("a"));
    ui.select(projects);
    const before = useUiStore.getState().promptFocusSeq;
    ui.back();
    expect(useUiStore.getState().promptFocusSeq).toBe(before + 1);
    ui.forward();
    expect(useUiStore.getState().promptFocusSeq).toBe(before + 1);
  });

  it("a select after going back drops the forward entries", () => {
    const ui = useUiStore.getState();
    ui.select(thread("a"));
    ui.select(thread("b"));
    ui.select(thread("c"));
    ui.back();
    ui.back();
    ui.select(prs);
    expect(state()).toEqual({ selection: prs, history: [DASHBOARD, thread("a"), prs], index: 2 });
    expect(ui.forward()).toBe(false);
  });

  it("re-selecting the current entry after going back keeps the forward entries", () => {
    const ui = useUiStore.getState();
    ui.select(thread("a"));
    ui.select(thread("b"));
    ui.back();
    ui.select(thread("a"));
    expect(state()).toMatchObject({ history: [DASHBOARD, thread("a"), thread("b")], index: 1 });
    expect(ui.forward()).toBe(true);
  });

  it(`keeps the last ${String(HISTORY_MAX)} entries, dropping the oldest`, () => {
    const ids = Array.from({ length: HISTORY_MAX + 5 }, (_, i) => `t${String(i)}`);
    threadsExist(...ids);
    for (const id of ids) useUiStore.getState().select(thread(id));
    const { history, index } = state();
    expect(history).toHaveLength(HISTORY_MAX);
    expect(index).toBe(HISTORY_MAX - 1);
    expect(history[0]).toEqual(thread(`t${String(ids.length - HISTORY_MAX)}`));
    expect(history[HISTORY_MAX - 1]).toEqual(thread(`t${String(ids.length - 1)}`));
  });

  it("skips and drops removed threads; archived ones are still in the store, so they stay", () => {
    const ui = useUiStore.getState();
    ui.select(thread("a"));
    ui.select(thread("b"));
    ui.select(thread("c"));
    threadsExist("a", "c"); // b removed
    expect(ui.back()).toBe(true);
    expect(state()).toEqual({ selection: thread("a"), history: [DASHBOARD, thread("a"), thread("c")], index: 1 });
    expect(ui.forward()).toBe(true);
    expect(state().selection).toEqual(thread("c"));
  });

  it("collapses the duplicates a removed thread leaves next to each other", () => {
    const ui = useUiStore.getState();
    ui.select(thread("a"));
    ui.select(thread("b"));
    ui.select(thread("a"));
    ui.select(projects);
    threadsExist("a"); // b removed
    expect(ui.back()).toBe(true);
    expect(state()).toEqual({ selection: thread("a"), history: [DASHBOARD, thread("a"), projects], index: 1 });
    expect(ui.back()).toBe(true);
    expect(state().selection).toEqual(DASHBOARD);
  });

  it("with only removed threads behind, back stays put and drops them", () => {
    const ui = useUiStore.getState();
    useUiStore.setState({ history: [thread("x"), thread("y"), projects], historyIndex: 2, selection: projects });
    expect(ui.back()).toBe(false);
    expect(state()).toEqual({ selection: projects, history: [projects], index: 0 });
  });

  it("skips a composer whose project or workspace was removed", () => {
    const ui = useUiStore.getState();
    ui.select({ kind: "compose", projectId: "p1" });
    ui.select({ kind: "compose", projectId: "p1", workspaceId: "w1" });
    ui.select({ kind: "compose", projectId: "", noProject: true });
    ui.select(thread("a"));
    useProjectsStore.setState({ loaded: true, byId: {}, order: [] });
    useWorkspacesStore.setState({ loaded: true, byId: {}, order: [] });
    expect(ui.back()).toBe(true);
    expect(state().selection).toEqual({ kind: "compose", projectId: "", noProject: true });
    expect(ui.back()).toBe(true);
    expect(state().selection).toEqual(DASHBOARD);
  });

  it("pruneHistory keeps the current entry even when it is gone", () => {
    const gone = (s: Selection) => s.kind === "thread";
    expect(pruneHistory([DASHBOARD, thread("a"), projects], 1, gone)).toEqual({ history: [DASHBOARD, thread("a"), projects], index: 1 });
    expect(pruneHistory([thread("a"), DASHBOARD, thread("b"), DASHBOARD, thread("c")], 3, gone)).toEqual({ history: [DASHBOARD], index: 0 });
  });

  it("is not persisted", () => {
    useUiStore.getState().select(thread("a"));
    const saved = useUiStore.persist.getOptions().partialize?.(useUiStore.getState());
    expect(saved).not.toHaveProperty("history");
    expect(saved).not.toHaveProperty("historyIndex");
    const merged = useUiStore.persist.getOptions().merge?.({ history: [thread("a")], historyIndex: 3 }, useUiStore.getInitialState());
    expect(merged).toMatchObject({ history: [DASHBOARD], historyIndex: 0 });
  });
});

describe("view.back and view.forward", () => {
  beforeEach(() => {
    threadsExist("a", "b");
    useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false, helpOpen: false });
    useUiStore.setState({ selection: DASHBOARD, history: [DASHBOARD], historyIndex: 0 });
  });

  it("are what ShowView back and forward run", () => {
    useUiStore.getState().select(thread("a"));
    expect(showView("back")).toBe(true);
    expect(useUiStore.getState().selection).toEqual(DASHBOARD);
    expect(showView("forward")).toBe(true);
    expect(useUiStore.getState().selection).toEqual(thread("a"));
  });

  it.each(["settingsOpen", "usageOpen", "themesOpen"] as const)("back with %s closes that page and stays on the selection it covered", (page) => {
    useUiStore.getState().select(thread("a"));
    useUiStore.getState().select(thread("b"));
    useViewsStore.setState({ [page]: true });
    expect(historyCommand(-1)).toBe(true);
    expect(useViewsStore.getState()[page]).toBe(false);
    expect(useUiStore.getState().selection).toEqual(thread("b"));
    expect(historyCommand(-1)).toBe(true);
    expect(useUiStore.getState().selection).toEqual(thread("a"));
  });

  it("forward with a page up steps when there is somewhere to go", () => {
    useUiStore.getState().select(thread("a"));
    useUiStore.getState().back();
    useViewsStore.setState({ settingsOpen: true });
    expect(historyCommand(1)).toBe(true);
    expect(useUiStore.getState().selection).toEqual(thread("a"));
  });
});
