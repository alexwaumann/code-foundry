import { afterEach, describe, expect, it } from "vitest";
import { diffOfChange, lastTabOf, openDiffInPanel, openFileInPanel } from "@/stores/filePanel";
import { getPanel, makeTab, usePanelStore } from "@/stores/panel";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { diffSurface } from "./diff";
import { DIFF_KIND, diffOfTab, diffTab, FILE_KIND, fileOfTab, fileTab } from "./fileTarget";
import { filesSurface } from "./files";
import type { SurfaceContext } from "./types";

const KEY = "thread:s-1";
const ctx: SurfaceContext = { selection: { kind: "thread", id: "s-1" }, panelKey: KEY };

afterEach(() => {
  usePanelStore.setState({ byKey: {} });
});

describe("fileTab", () => {
  it("makes the path absolute against base and keys the tab by it alone", () => {
    const t = fileTab({ project: "web", base: "/w", path: "src/../src/a.ts", line: 12 });
    expect(t).toEqual({ id: "files?path=%2Fw%2Fsrc%2Fa.ts", kind: FILE_KIND, title: "a.ts", params: { project: "web", base: "/w", path: "/w/src/a.ts", line: "12" } });
    // Another line, or the same file named absolutely: the same tab.
    expect(fileTab({ project: "web", base: "/w", path: "/w/src/a.ts" }).id).toBe(t.id);
    expect(fileOfTab(t)).toEqual({ project: "web", base: "/w", path: "/w/src/a.ts", line: 12 });
  });

  it("a no-project file, no line, a bad line", () => {
    const t = fileTab({ project: "", base: "/Users/me", path: "notes.md", line: 0 });
    expect(t.params).toEqual({ project: "", base: "/Users/me", path: "/Users/me/notes.md" });
    expect(fileOfTab(t)).toEqual({ project: "", base: "/Users/me", path: "/Users/me/notes.md" });
    expect(fileOfTab({ params: { path: "/a", line: "x" } })).toEqual({ project: "", base: "", path: "/a" });
    expect(fileOfTab({ params: {} })).toBeNull();
  });
});

describe("diffTab", () => {
  it("keys by project, worktree and path; scope and oldPath are params only", () => {
    const t = diffTab({ project: "web", worktree: "/w", path: "docs/new.md", oldPath: "docs/old.md", scope: "branch" });
    expect(t.kind).toBe(DIFF_KIND);
    expect(t.title).toBe("new.md");
    expect(t.id).toBe(diffTab({ project: "web", worktree: "/w", path: "docs/new.md", oldPath: "", scope: "working" }).id);
    expect(t.params).toEqual({ project: "web", worktree: "/w", path: "docs/new.md", oldPath: "docs/old.md", scope: "branch" });
    expect(diffOfTab(t)).toEqual({ project: "web", worktree: "/w", path: "docs/new.md", oldPath: "docs/old.md", scope: "branch" });
    expect(diffOfTab({ params: { project: "web", worktree: "/w", path: "a", scope: "?" } })?.scope).toBe("working");
    expect(diffOfTab({ params: { project: "web", path: "a" } })).toBeNull();
  });

  it("diffOfChange: uncommitted opens the working tree, else the branch", () => {
    expect(diffOfChange("web", "/w", { path: "a.ts", oldPath: "", uncommitted: true }).scope).toBe("working");
    expect(diffOfChange("web", "/w", { path: "a.ts", oldPath: "", uncommitted: false }).scope).toBe("branch");
  });
});

describe("opening and the surfaces' availability", () => {
  it("opening the same file again activates its tab with the new line; a scope switch keeps the diff's tab", () => {
    openFileInPanel(KEY, { project: "web", base: "/w", path: "a.ts", line: 3 });
    openDiffInPanel(KEY, { project: "web", worktree: "/w", path: "b.ts", oldPath: "", scope: "working" });
    openFileInPanel(KEY, { project: "web", base: "/w", path: "/w/a.ts", line: 9 });
    const e = getPanel(KEY);
    expect(e.tabs.map((t) => t.title)).toEqual(["a.ts", "b.ts"]);
    expect(e.tabs[0]?.params.line).toBe("9");
    expect(e.activeTabId).toBe(e.tabs[0]?.id);
    openDiffInPanel(KEY, { project: "web", worktree: "/w", path: "b.ts", oldPath: "", scope: "branch" });
    expect(getPanel(KEY).tabs.map((t) => t.params.scope ?? "")).toEqual(["", "branch"]);
  });

  it("File and Diff are dimmed until the panel has such a tab; then F and D bring back the last one", () => {
    useProjectsStore.setState({ byId: {}, order: [] });
    useThreadsStore.setState({ byId: {}, order: [] });
    expect([filesSurface.available(ctx), diffSurface.available(ctx)]).toEqual(["disabled", "disabled"]);
    expect(filesSurface.openDefault(ctx)).toBeNull();
    openFileInPanel(KEY, { project: "web", base: "/w", path: "a.ts" });
    openSurface2();
    openFileInPanel(KEY, { project: "web", base: "/w", path: "c.ts" });
    expect(filesSurface.available(ctx)).toBe("enabled");
    expect(filesSurface.openDefault(ctx)?.title).toBe("c.ts");
    expect(diffSurface.available(ctx)).toBe("disabled");
    expect(lastTabOf(FILE_KIND, "thread:other")).toBeNull();
  });
});

/** A non-file tab between the two file tabs. */
function openSurface2() {
  usePanelStore.setState((s) => {
    const e = s.byKey[KEY];
    if (!e) return s;
    return { byKey: { ...s.byKey, [KEY]: { ...e, tabs: [...e.tabs, makeTab("pullrequest", "#1", { number: "1" })] } } };
  });
}
