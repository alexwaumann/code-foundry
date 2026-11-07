import { afterEach, describe, expect, it } from "vitest";
import { getPanel, migratePanelV5, sanitizePanelState, tabId, usePanelStore, type PanelEntry, type Tab } from "./panel";

/**
 * Version 5 to 6 (docs/notes/diff-viewer-2.md): stored Changes tabs and one-file Diff tabs are
 * real users' panels, so nothing here may be lost or left pointing at a surface that is gone.
 */

const W = "/u/web.wt/feat";
const X = "/u/web.wt/other";
const changes = (path: string, title = "Changes"): Tab => ({ id: tabId("changes", { path, project: "web" }), kind: "changes", title, params: { project: "web", path } });
const oldDiff = (path: string, scope = "working", worktree = W, oldPath?: string): Tab => {
  const key = { project: "web", worktree, path };
  return { id: tabId("diff", key), kind: "diff", title: path, params: { ...key, scope, ...(oldPath ? { oldPath } : {}) } };
};
const file: Tab = { id: "files?path=%2Fu%2Fa.ts", kind: "files", title: "a.ts", params: { project: "web", base: W, path: "/u/a.ts" } };
const newId = (worktree: string) => tabId("diff", { project: "web", worktree });
const entry = (tabs: Tab[], activeTabId: string | null = tabs[0]?.id ?? null): PanelEntry => ({ open: true, groups: [{ tabs, activeTabId }] });
const migrated = (e: PanelEntry): PanelEntry => {
  const out = migratePanelV5({ k: e }).k;
  if (!out) throw new Error("the entry went");
  return out;
};
const tabsOf = (e: PanelEntry, g = 0) => e.groups[g]?.tabs ?? [];

describe("migratePanelV5", () => {
  it("a Changes tab is the checkout's Diff tab, on the default sources", () => {
    const [t] = tabsOf(migrated(entry([changes(W)])));
    expect(t).toEqual({ id: newId(W), kind: "diff", title: "Diff", params: { project: "web", worktree: W, own: "1" } });
  });

  it("another checkout's Changes tab keeps its project in the title and is not the thread's own", () => {
    const [t] = tabsOf(migrated(entry([changes(W, "Changes · web · cf/demo")])));
    expect(t?.title).toBe("Diff · web · cf/demo");
    expect(t?.params.own).toBeUndefined();
  });

  it("a one-file Diff tab keeps its file, and working stays on the default sources", () => {
    const [t] = tabsOf(migrated(entry([oldDiff("a.ts")])));
    expect(t?.id).toBe(newId(W));
    expect(t?.params).toEqual({ project: "web", worktree: W, path: "a.ts", own: "1" });
  });

  it("the branch scope is the merge base against HEAD", () => {
    expect(tabsOf(migrated(entry([oldDiff("a.ts", "branch")])))[0]?.params.head).toBe("ref:HEAD");
  });

  it("a rename keeps its source", () => {
    expect(tabsOf(migrated(entry([oldDiff("new.ts", "working", W, "old.ts")])))[0]?.params.oldPath).toBe("old.ts");
  });

  it("a checkout's tabs are one tab where the first stood, showing the file the group showed", () => {
    const a = oldDiff("a.ts");
    const b = oldDiff("b.ts", "branch");
    const e = migrated(entry([file, changes(W), a, b], a.id));
    expect(tabsOf(e).map((t) => t.id)).toEqual([file.id, newId(W)]);
    expect(e.groups[0]?.activeTabId).toBe(newId(W));
    expect(tabsOf(e)[1]?.params.path).toBe("a.ts");
    expect(tabsOf(e)[1]?.params.head).toBeUndefined();
  });

  it("with none of them showing, the last opened file decides", () => {
    const e = migrated(entry([file, oldDiff("a.ts"), oldDiff("b.ts", "branch")], file.id));
    expect(e.groups[0]?.activeTabId).toBe(file.id);
    expect(tabsOf(e)[1]?.params).toMatchObject({ path: "b.ts", head: "ref:HEAD" });
  });

  it("two checkouts stay two tabs", () => {
    const e = migrated(entry([changes(W), changes(X, "Changes · web · other"), oldDiff("c.ts", "working", X)]));
    expect(tabsOf(e).map((t) => t.id)).toEqual([newId(W), newId(X)]);
    expect(tabsOf(e)[1]?.params.path).toBe("c.ts");
  });

  it("the file of a split panel's other group decides too, and the split survives while a group has tabs", () => {
    const b = oldDiff("b.ts");
    const e: PanelEntry = { open: true, groups: [{ tabs: [file, changes(W)], activeTabId: file.id }, { tabs: [b, { ...file, id: "files?x", title: "x" }], activeTabId: b.id }] };
    const out = migrated(e);
    expect(out.groups).toHaveLength(2);
    expect(tabsOf(out, 0)[1]?.params.path).toBe("b.ts");
    expect(tabsOf(out, 1).map((t) => t.kind)).toEqual(["files"]);
  });

  it("a group left empty folds the split", () => {
    const e: PanelEntry = { open: true, groups: [{ tabs: [changes(W)], activeTabId: changes(W).id }, { tabs: [oldDiff("b.ts")], activeTabId: oldDiff("b.ts").id }], ratio: 0.4, focused: 1 };
    const out = migrated(e);
    expect(out.groups).toHaveLength(1);
    expect(tabsOf(out).map((t) => t.id)).toEqual([newId(W)]);
  });

  it("picking from a tab that merged keeps picking from the new tab", () => {
    const a = oldDiff("a.ts");
    const e = migrated({ open: true, groups: [{ tabs: [a], activeTabId: null, pickFrom: a.id }] });
    expect(e.groups[0]).toMatchObject({ activeTabId: null, pickFrom: newId(W) });
  });

  it("a Changes tab that names no worktree goes; other surfaces are untouched", () => {
    const bad: Tab = { id: "changes", kind: "changes", title: "Changes", params: {} };
    expect(tabsOf(migrated(entry([bad, file]))).map((t) => t.id)).toEqual([file.id]);
  });

  it("runs twice to the same place: a store an older build renumbered comes through again", () => {
    const once = migratePanelV5({ k: entry([changes(W), oldDiff("a.ts", "branch")]) });
    expect(migratePanelV5(sanitizePanelState(once))).toEqual(once);
  });

  it("no tab of a removed kind survives, in any entry", () => {
    const out = migratePanelV5({ a: entry([changes(W)]), b: entry([oldDiff("a.ts"), changes(X)]) });
    expect(Object.values(out).flatMap((e) => e.groups.flatMap((g) => g.tabs)).filter((t) => t.kind === "changes")).toEqual([]);
  });

  describe("through the store", () => {
    afterEach(() => {
      localStorage.clear();
      usePanelStore.setState({ byKey: {} });
    });

    it("a version 5 store rehydrates to one Diff tab and saves as version 6", async () => {
      const a = oldDiff("a.ts");
      localStorage.setItem("code-foundry.panel", JSON.stringify({ version: 5, state: { byKey: { "thread:s-1": entry([changes(W), a], a.id) } } }));
      await usePanelStore.persist.rehydrate();
      expect(getPanel("thread:s-1").groups[0]?.tabs.map((t) => [t.kind, t.params.path])).toEqual([["diff", "a.ts"]]);
      expect(getPanel("thread:s-1").groups[0]?.activeTabId).toBe(newId(W));
      expect(JSON.parse(localStorage.getItem("code-foundry.panel") ?? "{}")).toMatchObject({ version: 6 });
    });

    it("a store from a newer build is not migrated again", async () => {
      const t = { id: newId(W), kind: "diff", title: "feat vs main", params: { project: "web", worktree: W, path: "a.ts" } };
      localStorage.setItem("code-foundry.panel", JSON.stringify({ version: 7, state: { byKey: { "thread:s-1": entry([t]) } } }));
      await usePanelStore.persist.rehydrate();
      expect(getPanel("thread:s-1").groups[0]?.tabs).toEqual([t]);
    });
  });
});
