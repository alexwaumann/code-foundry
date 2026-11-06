import { beforeEach, describe, expect, it } from "vitest";
import { diffOfChange, lastTabOf, openDiffInPanel, openFileInPanel, openLooseFile } from "./filePanel";
import { usePanelStore } from "./panel";
import { HOME, useUiStore } from "./ui";

/** Diff tabs as a Changes row opens them (docs/notes/file-viewer-3-tabs.md). */

const W = "/Users/dev/src/code-foundry";
const KEY = "thread:s-1";

function strip(): [string, string, string][] {
  const g = usePanelStore.getState().byKey[KEY]?.groups[0];
  return (g?.tabs ?? []).map((t) => [t.title, t.params.scope ?? "", t.id === g?.activeTabId ? "active" : ""]);
}

beforeEach(() => {
  useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
  usePanelStore.setState({ byKey: {} });
});

describe("diffOfChange", () => {
  it.each([
    ["an uncommitted change opens on the working tree", true, "working"],
    ["a committed one on the branch", false, "branch"],
  ] as const)("%s", (_, uncommitted, scope) => {
    expect(diffOfChange("repo-cf", W, { path: "docs/notes/sidebar.md", oldPath: "docs/sidebar.md", uncommitted })).toEqual({
      project: "repo-cf",
      worktree: W,
      path: "docs/notes/sidebar.md",
      oldPath: "docs/sidebar.md",
      scope,
    });
  });
});

describe("openDiffInPanel", () => {
  it("one tab per file: the same row again activates it, on the row's scope", () => {
    openDiffInPanel("current", diffOfChange("repo-cf", W, { path: "README.md", oldPath: "", uncommitted: true }));
    // The tab's own switch moved it to the branch.
    openDiffInPanel("current", { project: "repo-cf", worktree: W, path: "README.md", oldPath: "", scope: "branch" });
    openDiffInPanel("current", diffOfChange("repo-cf", W, { path: "notes/plan.md", oldPath: "", uncommitted: true }));
    expect(strip()).toEqual([
      ["README.md", "branch", ""],
      ["plan.md", "working", "active"],
    ]);
    openDiffInPanel("current", diffOfChange("repo-cf", W, { path: "README.md", oldPath: "", uncommitted: true }));
    expect(strip()).toEqual([
      ["README.md", "working", "active"],
      ["plan.md", "working", ""],
    ]);
    expect(usePanelStore.getState().byKey[KEY]?.open).toBe(true);
  });

  it("the letters bring back a panel's last tab of a kind", () => {
    expect(lastTabOf("diff", KEY)).toBeNull();
    openDiffInPanel("current", diffOfChange("repo-cf", W, { path: "README.md", oldPath: "", uncommitted: true }));
    openFileInPanel("current", { project: "repo-cf", base: W, path: "README.md" });
    expect(lastTabOf("diff", KEY)?.title).toBe("README.md");
    expect(lastTabOf("files", KEY)?.params.path).toBe(`${W}/README.md`);
  });
});

describe("openLooseFile", () => {
  const DIR = "/Users/dev/.claude/skills/pr-review";
  const shown = (key: string) => {
    const e = usePanelStore.getState().byKey[key];
    const g = e?.groups[0];
    return { open: e?.open, expanded: e?.expanded, tab: g?.tabs.find((t) => t.id === g.activeTabId)?.params };
  };

  it.each([
    ["a thread", { kind: "thread", id: "s-1" }, "thread:s-1"],
    ["the home composer", HOME, "compose:home:"],
    ["a project's composer", { kind: "compose", projectId: "p-1" }, "compose:p-1"],
    ["the Pull Requests page", { kind: "view", name: "pullrequests" }, "view:pullrequests"],
    ["a project's page", { kind: "view", name: "projects", projectId: "p-1" }, "view:projects:project:p-1"],
  ] as const)("opens in %s's panel, as nobody's file", (_name, selection, key) => {
    useUiStore.setState({ selection, windowWidth: 1600 });
    expect(openLooseFile(DIR, "SKILL.md")).toBe(true);
    expect(shown(key)).toMatchObject({ open: true, tab: { project: "", base: DIR, path: `${DIR}/SKILL.md` } });
    expect(shown(key).expanded).toBeUndefined();
  });

  it("with nothing that has a panel selected, the home composer takes it", () => {
    useUiStore.setState({ selection: { kind: "none" }, windowWidth: 1600 });
    expect(openLooseFile(DIR, "SKILL.md")).toBe(true);
    expect(useUiStore.getState().selection).toEqual(HOME);
    expect(shown("compose:home:")).toMatchObject({ open: true, tab: { path: `${DIR}/SKILL.md` } });
  });

  it("a window too narrow for a panel beside the content gets it expanded, so it shows", () => {
    useUiStore.setState({ selection: { kind: "thread", id: "s-1" }, windowWidth: 700 });
    expect(openLooseFile(DIR, "SKILL.md")).toBe(true);
    expect(shown(KEY)).toMatchObject({ open: true, expanded: true });
  });
});
