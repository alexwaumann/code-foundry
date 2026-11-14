import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMMITTED_HEAD, DEFAULT_BASE, DEFAULT_HEAD, type DiffTarget } from "./diffTarget";
import { FILE_KIND, fileOfTab, fileTab } from "./fileTarget";
import type { SurfaceContext } from "./types";

vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));

const { layoutSettled, resetFakeLayout, threadSeed } = await import("@/test/fakeLayout");
const { makeTab, openTab, shownTab, tabPlace } = await import("@/shell/host");
const { lastTabOf, openDiffInPanel, openFileInPanel } = await import("@/stores/filePanel");
const { useProjectsStore } = await import("@/stores/projects");
const { useThreadsStore } = await import("@/stores/threads");
const { diffSurface } = await import("./diff");
const { filesSurface } = await import("./files");

const KEY = "thread:s-1";
const ctx: SurfaceContext = { selection: { kind: "thread", id: "s-1" }, panelKey: KEY };

beforeEach(async () => {
  await resetFakeLayout(threadSeed("s-1"));
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

  it("opening the page's file again another way (a path chip) keeps it the thread's page", async () => {
    openFileInPanel(KEY, { project: "", base: "", path: "/Users/me/p/welcome.html", page: { title: "Welcome" } });
    await layoutSettled();
    openFileInPanel(KEY, { project: "", base: "", path: "/Users/me/p/welcome.html", line: 3 });
    await layoutSettled();
    const t = lastTabOf(FILE_KIND, KEY);
    expect(t).toMatchObject({ title: "Welcome", params: { page: "1", title: "Welcome", line: "3" } });
    openFileInPanel(KEY, { project: "", base: "", path: "/Users/me/p/other.html" });
    await layoutSettled();
    expect(lastTabOf(FILE_KIND, KEY)?.params).not.toHaveProperty("page");
  });
});

const diff: DiffTarget = { project: "web", worktree: "/w", base: DEFAULT_BASE, head: DEFAULT_HEAD, file: "b.ts", oldPath: "", own: true };

describe("opening and the surfaces' availability", () => {
  it("opening the same file again activates its tab with the new line; new sources keep the diff's tab", async () => {
    openFileInPanel(KEY, { project: "web", base: "/w", path: "a.ts", line: 3 });
    openDiffInPanel(KEY, diff, "b vs main");
    await layoutSettled();
    openFileInPanel(KEY, { project: "web", base: "/w", path: "/w/a.ts", line: 9 });
    await layoutSettled();
    const p = tabPlace(KEY);
    expect(p.tabs.map((t) => t.title)).toEqual(["a.ts", "b vs main"]);
    expect(p.tabs[0]?.params.line).toBe("9");
    expect(shownTab(p)?.id).toBe(p.tabs[0]?.id);
    openDiffInPanel(KEY, { ...diff, head: COMMITTED_HEAD });
    await layoutSettled();
    expect(tabPlace(KEY).tabs.map((t) => t.params.head ?? "")).toEqual(["", "ref:HEAD"]);
  });

  it("File and Diff are dimmed until the thread has such a tab; then F and D bring back the last one", async () => {
    useProjectsStore.setState({ byId: {}, order: [] });
    useThreadsStore.setState({ byId: {}, order: [] });
    expect([filesSurface.available(ctx), diffSurface.available(ctx)]).toEqual(["disabled", "disabled"]);
    expect(filesSurface.openDefault(ctx)).toBeNull();
    openFileInPanel(KEY, { project: "web", base: "/w", path: "a.ts" });
    await layoutSettled();
    // A non-file tab between the two file tabs.
    openTab(KEY, makeTab("pullrequest", "#1", { slug: "o/r", number: "1" }));
    await layoutSettled();
    openFileInPanel(KEY, { project: "web", base: "/w", path: "c.ts" });
    await layoutSettled();
    expect(filesSurface.available(ctx)).toBe("enabled");
    expect(filesSurface.openDefault(ctx)?.title).toBe("c.ts");
    expect(diffSurface.available(ctx)).toBe("disabled");
    expect(lastTabOf(FILE_KIND, "thread:other")).toBeNull();
  });
});
