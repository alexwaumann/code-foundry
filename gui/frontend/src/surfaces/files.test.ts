import { afterEach, describe, expect, it } from "vitest";
import { lastTabOf, openDiffInPanel, openFileInPanel } from "@/stores/filePanel";
import { getPanel, makeTab, usePanelStore } from "@/stores/panel";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { diffSurface } from "./diff";
import { COMMITTED_HEAD, DEFAULT_BASE, DEFAULT_HEAD, type DiffTarget } from "./diffTarget";
import { FILE_KIND, fileOfTab, fileTab } from "./fileTarget";
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

  it("a tab can ask to open editing, and the param round-trips without changing the tab's id", () => {
    const t = fileTab({ project: "", base: "/w", path: "a.ts", edit: true });
    expect(t.params.edit).toBe("1");
    expect(fileOfTab(t)?.edit).toBe(true);
    expect(t.id).toBe(fileTab({ project: "", base: "/w", path: "a.ts" }).id);
    expect(fileOfTab(fileTab({ project: "", base: "/w", path: "a.ts" }))).not.toHaveProperty("edit");
  });

  it("a no-project file, no line, a bad line", () => {
    const t = fileTab({ project: "", base: "/Users/me", path: "notes.md", line: 0 });
    expect(t.params).toEqual({ project: "", base: "/Users/me", path: "/Users/me/notes.md" });
    expect(fileOfTab(t)).toEqual({ project: "", base: "/Users/me", path: "/Users/me/notes.md" });
    expect(fileOfTab({ params: { path: "/a", line: "x" } })).toEqual({ project: "", base: "", path: "/a" });
    expect(fileOfTab({ params: {} })).toBeNull();
  });

  it("a thread's own page (view.panel.page): flagged, titled with its title, the same tab as the file", () => {
    const t = fileTab({ project: "", base: "/Users/me", path: "/Users/me/p/welcome.html", page: { title: "Welcome" } });
    expect(t).toMatchObject({ id: fileTab({ project: "", base: "", path: "/Users/me/p/welcome.html" }).id, title: "Welcome" });
    expect(t.params).toMatchObject({ page: "1", title: "Welcome" });
    expect(fileOfTab(t)).toMatchObject({ page: { title: "Welcome" } });
    const untitled = fileTab({ project: "", base: "", path: "/Users/me/p/a.html", page: { title: "" } });
    expect(untitled.title).toBe("a.html");
    expect(untitled.params).not.toHaveProperty("title");
    expect(fileOfTab(untitled)?.page).toEqual({ title: "" });
  });

  it("opening the page's file again another way (a path chip) keeps it the thread's page", () => {
    openFileInPanel(KEY, { project: "", base: "", path: "/Users/me/p/welcome.html", page: { title: "Welcome" } });
    openFileInPanel(KEY, { project: "", base: "", path: "/Users/me/p/welcome.html", line: 3 });
    const t = lastTabOf(FILE_KIND, KEY);
    expect(t).toMatchObject({ title: "Welcome", params: { page: "1", title: "Welcome", line: "3" } });
    openFileInPanel(KEY, { project: "", base: "", path: "/Users/me/p/other.html" });
    expect(lastTabOf(FILE_KIND, KEY)?.params).not.toHaveProperty("page");
  });
});

const diff: DiffTarget = { project: "web", worktree: "/w", base: DEFAULT_BASE, head: DEFAULT_HEAD, file: "b.ts", oldPath: "", own: true };

describe("opening and the surfaces' availability", () => {
  it("opening the same file again activates its tab with the new line; new sources keep the diff's tab", () => {
    openFileInPanel(KEY, { project: "web", base: "/w", path: "a.ts", line: 3 });
    openDiffInPanel(KEY, diff, "b vs main");
    openFileInPanel(KEY, { project: "web", base: "/w", path: "/w/a.ts", line: 9 });
    const e = getPanel(KEY);
    expect(e.groups[0]?.tabs.map((t) => t.title)).toEqual(["a.ts", "b vs main"]);
    expect(e.groups[0]?.tabs[0]?.params.line).toBe("9");
    expect(e.groups[0]?.activeTabId).toBe(e.groups[0]?.tabs[0]?.id);
    openDiffInPanel(KEY, { ...diff, head: COMMITTED_HEAD });
    expect(getPanel(KEY).groups[0]?.tabs.map((t) => t.params.head ?? "")).toEqual(["", "ref:HEAD"]);
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
    const g = e?.groups[0];
    if (!e || !g) return s;
    return { byKey: { ...s.byKey, [KEY]: { ...e, groups: [{ ...g, tabs: [...g.tabs, makeTab("pullrequest", "#1", { number: "1" })] }] } } };
  });
}
