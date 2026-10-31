import { beforeEach, describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import { useProjectsStore } from "./projects";
import { useThreadsStore } from "./threads";
import { HOME, HISTORY_MAX, projectPage, PROJECTS_INDEX as projectsIndex, pruneHistory, useUiStore, workspacePage, type Selection } from "./ui";
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
    useUiStore.setState({ selection: HOME, history: [HOME], historyIndex: 0, promptFocusSeq: 0 });
  });

  it("starts on HOME (the No project composer) as entry 0, with nothing to go back or forward to", () => {
    expect(useUiStore.getInitialState().history).toEqual([HOME]);
    expect(useUiStore.getInitialState().historyIndex).toBe(0);
    expect(useUiStore.getState().back()).toBe(false);
    expect(useUiStore.getState().forward()).toBe(false);
    expect(state()).toEqual({ selection: HOME, history: [HOME], index: 0 });
  });

  it("select pushes every kind of selection after the current entry", () => {
    const ui = useUiStore.getState();
    ui.select(thread("a"));
    ui.select(projects);
    ui.select({ kind: "compose", projectId: "p1" });
    ui.select(thread("b"));
    expect(state().history).toEqual([HOME, thread("a"), projects, { kind: "compose", projectId: "p1" }, thread("b")]);
    expect(state().index).toBe(4);
  });

  it("does not push a selection equal to the current entry", () => {
    const ui = useUiStore.getState();
    ui.select(thread("a"));
    ui.select({ kind: "thread", id: "a" }, { focusPrompt: true });
    ui.select(HOME);
    ui.select({ kind: "compose", projectId: "", noProject: true });
    expect(state().history).toEqual([HOME, thread("a"), HOME]);
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
    expect(state()).toMatchObject({ selection: HOME, index: 0 });
    expect(ui.back()).toBe(false);
    expect(ui.forward()).toBe(true);
    expect(ui.forward()).toBe(true);
    expect(ui.forward()).toBe(true);
    expect(state()).toEqual({ selection: thread("b"), history: [HOME, thread("a"), projects, thread("b")], index: 3 });
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
    expect(state()).toEqual({ selection: prs, history: [HOME, thread("a"), prs], index: 2 });
    expect(ui.forward()).toBe(false);
  });

  it("re-selecting the current entry after going back keeps the forward entries", () => {
    const ui = useUiStore.getState();
    ui.select(thread("a"));
    ui.select(thread("b"));
    ui.back();
    ui.select(thread("a"));
    expect(state()).toMatchObject({ history: [HOME, thread("a"), thread("b")], index: 1 });
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
    expect(state()).toEqual({ selection: thread("a"), history: [HOME, thread("a"), thread("c")], index: 1 });
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
    expect(state()).toEqual({ selection: thread("a"), history: [HOME, thread("a"), projects], index: 1 });
    expect(ui.back()).toBe(true);
    expect(state().selection).toEqual(HOME);
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
    ui.select(projects);
    ui.select(thread("a"));
    useProjectsStore.setState({ loaded: true, byId: {}, order: [] });
    useWorkspacesStore.setState({ loaded: true, byId: {}, order: [] });
    expect(ui.back()).toBe(true);
    expect(state().selection).toEqual(projects);
    expect(ui.back()).toBe(true);
    expect(state().selection).toEqual(HOME);
  });

  it("never drops HOME (no project to lose); back past it stays on it", () => {
    const ui = useUiStore.getState();
    ui.select(thread("a"));
    useProjectsStore.setState({ loaded: true, byId: {}, order: [] });
    useWorkspacesStore.setState({ loaded: true, byId: {}, order: [] });
    expect(ui.back()).toBe(true);
    expect(ui.back()).toBe(false);
    expect(state()).toEqual({ selection: HOME, history: [HOME, thread("a")], index: 0 });
  });

  it("pruneHistory keeps the current entry even when it is gone", () => {
    const gone = (s: Selection) => s.kind === "thread";
    expect(pruneHistory([HOME, thread("a"), projects], 1, gone)).toEqual({ history: [HOME, thread("a"), projects], index: 1 });
    expect(pruneHistory([thread("a"), HOME, thread("b"), HOME, thread("c")], 3, gone)).toEqual({ history: [HOME], index: 0 });
  });

  it("is not persisted", () => {
    useUiStore.getState().select(thread("a"));
    const saved = useUiStore.persist.getOptions().partialize?.(useUiStore.getState());
    expect(saved).not.toHaveProperty("history");
    expect(saved).not.toHaveProperty("historyIndex");
    const merged = useUiStore.persist.getOptions().merge?.({ history: [thread("a")], historyIndex: 3 }, useUiStore.getInitialState());
    expect(merged).toMatchObject({ history: [HOME], historyIndex: 0 });
  });
});

describe("view.back and view.forward", () => {
  beforeEach(() => {
    threadsExist("a", "b");
    useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false, helpOpen: false });
    useUiStore.setState({ selection: HOME, history: [HOME], historyIndex: 0 });
  });

  it("are what ShowView back and forward run", () => {
    useUiStore.getState().select(thread("a"));
    expect(showView("back")).toBe(true);
    expect(useUiStore.getState().selection).toEqual(HOME);
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

describe("Projects pages", () => {
  beforeEach(() => {
    threadsExist("a");
    useProjectsStore.setState({ loaded: true, byId: { "repo-cf": { id: "repo-cf" } as never, "repo-gp": { id: "repo-gp" } as never }, order: ["repo-cf", "repo-gp"] });
    useWorkspacesStore.setState({ loaded: true, byId: { "w-1": { id: "w-1" } as never }, order: ["w-1"] });
    useUiStore.setState({ selection: HOME, history: [HOME], historyIndex: 0, projectsLast: "" });
  });

  it("each page is its own history entry; back and forward walk them", () => {
    const ui = useUiStore.getState();
    ui.select(projectsIndex);
    ui.select(projectPage("repo-cf"));
    ui.select(workspacePage("w-1"));
    expect(useUiStore.getState().history).toEqual([HOME, projectsIndex, projectPage("repo-cf"), workspacePage("w-1")]);
    expect(useUiStore.getState().back()).toBe(true);
    expect(useUiStore.getState().selection).toEqual(projectPage("repo-cf"));
    expect(useUiStore.getState().back()).toBe(true);
    expect(useUiStore.getState().selection).toEqual(projectsIndex);
  });

  it("the sidebar row reopens the last Projects page, and goes to the index from a page", () => {
    const ui = () => useUiStore.getState();
    ui().openProjects();
    expect(ui().selection).toEqual(projectsIndex);
    ui().select(projectPage("repo-gp"));
    expect(ui().projectsLast).toBe("project:repo-gp");
    ui().select(thread("a"));
    ui().openProjects();
    expect(ui().selection).toEqual(projectPage("repo-gp"));
    ui().openProjects();
    expect(ui().selection).toEqual(projectsIndex);
    expect(ui().projectsLast).toBe("");
    ui().select(workspacePage("w-1"));
    ui().select(thread("a"));
    ui().openProjects();
    expect(ui().selection).toEqual(workspacePage("w-1"));
  });

  it("a removed project's page is gone: the row opens the index, history skips it", () => {
    const ui = () => useUiStore.getState();
    ui().select(projectPage("repo-gp"));
    ui().select(thread("a"));
    useProjectsStore.setState({ byId: { "repo-cf": { id: "repo-cf" } as never }, order: ["repo-cf"] });
    expect(pruneHistory(ui().history, ui().historyIndex).history).toEqual([HOME, thread("a")]);
    ui().openProjects();
    expect(ui().selection).toEqual(projectsIndex);
  });
});
