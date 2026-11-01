import { beforeEach, describe, expect, it } from "vitest";
import { diffOfChange, lastTabOf, openDiffInPanel, openFileInPanel } from "./filePanel";
import { usePanelStore } from "./panel";
import { useUiStore } from "./ui";

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
