// @vitest-environment node
import { describe, expect, it } from "vitest";
import { intoUsersDiff, panelItemCommands, type ItemThread } from "./panelItemVerbs";
import type { State } from "./layout";

const thread: ItemThread = {
  projectId: "r1",
  worktreePath: "/w/a",
  githubSlug: "",
  checkouts: [{ projectId: "r2", path: "/w/b" }],
  changed: (root) => (root === "/w/a" ? ["x.go", "src/app.ts", "src/lib/util.ts"] : root === "/w/b" ? ["api.go"] : undefined),
};
const ctx = { activeThreadId: "t1" } as never;

/** Runs an item verb; params are its tab's. */
function run(name: string, args: Record<string, string>): { out: unknown; params: Record<string, string> | undefined } {
  let params: Record<string, string> | undefined;
  const cmds = panelItemCommands(
    (id) => (id === "t1" ? thread : undefined),
    (op) => {
      params = (op.tab as { params?: Record<string, string> }).params;
    },
  );
  const cmd = cmds.find((c) => c.cmd.name === name);
  if (!cmd) throw new Error(`no ${name}`);
  return { out: cmd.run(ctx, args), params };
}

describe("the panel verbs' --title, like the daemon's", () => {
  const verbs: [string, Record<string, string>][] = [
    ["view.panel.page", { path: "/w/a/p.html" }],
    ["view.panel.diff", { path: "/w/a/x.go" }],
  ];
  for (const [name, args] of verbs) {
    it(`${name} takes 100 characters, cleaned`, () => {
      const { params } = run(name, { ...args, title: ` ${"é".repeat(98)}\n\t x ` });
      expect(params?.title).toBe(`${"é".repeat(98)} x`);
    });
    it(`${name} refuses 101 with the daemon's message`, () => {
      expect(() => run(name, { ...args, title: "x".repeat(101) })).toThrow("101 characters, at most 100");
    });
  }
});

describe("view.panel.diff's params, like the daemon's (commands_view_diff.go diffCheck)", () => {
  const diff = (args: Record<string, string>) => run("view.panel.diff", args).params;
  const own = { project: "r1", worktree: "/w/a", own: "1" };

  it.each<[string, Record<string, string>, Record<string, string>]>([
    ["nothing: the checkout's own tab", {}, own],
    ["one changed file: picked in the whole list", { path: "/w/a/x.go" }, { ...own, path: "x.go" }],
    ["the checkout's root: every file", { path: "/w/a" }, own],
    ["the root among other paths: every file", { path: "/w/a/x.go\n/w/a" }, own],
    ["a directory: a list of its own", { path: "/w/a/src" }, { ...own, paths: "src", thread: "t1" }],
    ["several files: a list of their own", { path: "/w/a/x.go\n/w/a/src/app.ts" }, { ...own, paths: "x.go\nsrc/app.ts", thread: "t1" }],
    ["a file in another of its checkouts: not its own", { path: "/w/b/api.go" }, { project: "r2", worktree: "/w/b", path: "api.go" }],
    ["the default sides named: no params, but a tab of its own", { base: "merge-base", head: "working" }, { ...own, thread: "t1" }],
    ["other sides", { base: "staged", head: "main" }, { ...own, base: "staged", head: "ref:main", thread: "t1" }],
    ["--scope working", { scope: "working" }, { ...own, thread: "t1" }],
    ["--scope branch", { scope: "branch" }, { ...own, head: "ref:HEAD", thread: "t1" }],
    ["--hide", { hide: "compare\nfiles" }, { ...own, hide: "compare,files", thread: "t1" }],
  ])("%s", (_name, args, want) => {
    expect(diff(args)).toEqual(want);
  });

  it.each<[string, Record<string, string>, string]>([
    ["--scope with --base", { scope: "branch", base: "main" }, "says the same as --base and --head: give one or the other"],
    ["--scope with --head", { scope: "working", head: "HEAD" }, "says the same as --base and --head"],
    ["a bad --hide", { hide: "compare\ntoolbar" }, 'want compare or files, got "toolbar"'],
    ["a path in no checkout", { path: "/w/c/x.go" }, "/w/c/x.go is not a file in thread t1's worktree /w/a"],
    ["paths in two checkouts", { path: "/w/a/x.go\n/w/b/api.go" }, "/w/b/api.go is in /w/b and the paths before it in /w/a: one tab shows one checkout"],
  ])("refuses %s", (_name, args, message) => {
    expect(() => diff(args)).toThrow(message);
  });
});

describe("view.open.* in the mock: a linked tab in the layout, the whole effect", () => {
  type Placed = { op: Record<string, unknown>; keepFocus: boolean };
  function open(name: string, args: Record<string, string>, from: unknown = ctx): { placed: Placed[] } {
    const placed: Placed[] = [];
    const cmds = panelItemCommands(
      (id) => (id === "t1" ? thread : undefined),
      (op, keepFocus) => placed.push({ op, keepFocus }),
    );
    const cmd = cmds.find((c) => c.cmd.name === name);
    if (!cmd) throw new Error(`no ${name}`);
    void cmd.run(from as never, args);
    return { placed };
  }

  it.each<[string, Record<string, string>, string]>([
    ["view.open.file", { path: "/w/a/x.go" }, "file"],
    ["view.open.page", { path: "/w/a/p.html" }, "file"],
    ["view.open.diff", {}, "diff"],
    ["view.open.gallery", { title: "Shots", images: "[]" }, "gallery"],
    ["view.open.pr", { number: "7" }, "pullrequest"],
  ])("%s opens a %s tab linked to the thread, under both names", (name, args, kind) => {
    const withSlug = { ...thread, githubSlug: "o/r" };
    for (const verb of [name, name.replace("view.open.", "view.panel.")]) {
      const placed: Placed[] = [];
      const cmd = panelItemCommands((id) => (id === "t1" ? withSlug : undefined), (op, keepFocus) => placed.push({ op, keepFocus })).find((c) => c.cmd.name === verb);
      void cmd?.run(ctx, args);
      expect(placed).toHaveLength(1);
      expect(placed[0]?.op).toMatchObject({ op: "open_surface", tab: { kind, thread: "t1" } });
    }
  });

  it("a request to edit a file carries its asker and a fresh id in the tab, like the daemon's fileAskParams", () => {
    const first = run("view.open.file", { path: "/w/a/.env", edit: "true", note: "Key on line 2" }).params;
    const second = run("view.open.file", { path: "/w/a/.env", edit: "true", note: "Key on line 2" }).params;
    expect(first).toMatchObject({ edit: "1", asker: "t1", note: "Key on line 2" });
    expect(first?.askId).toMatch(/^[0-9a-f]{12}$/);
    expect(second?.askId).not.toBe(first?.askId);
    expect(first?.focus).toBeUndefined();
    expect(run("view.open.file", { path: "/w/a/.env", edit: "true", focus: "true" }).params?.focus).toBe("1");
    expect(run("view.open.file", { path: "/w/a/x.go" }).params).toEqual({ path: "/w/a/x.go", project: "r1", base: "/w/a" });
  });

  it("the alias is unlisted, the new name is not", () => {
    const cmds = panelItemCommands(() => thread);
    expect(cmds.find((c) => c.cmd.name === "view.panel.diff")?.cmd.noPalette).toBe(true);
    expect(cmds.find((c) => c.cmd.name === "view.panel.diff")?.cmd.description).toMatch(/^The old name of view.open.diff/);
  });

  it("from the app it takes the focus; from a caller with no view only with --focus; --pane goes along", () => {
    expect(open("view.open.file", { path: "/w/a/x.go" }, { activeThreadId: "t1", activeView: "thread" }).placed[0]).toMatchObject({ op: { focus: true }, keepFocus: false });
    expect(open("view.open.file", { path: "/w/a/x.go" }).placed[0]).toMatchObject({ op: { focus: false }, keepFocus: true });
    expect(open("view.open.file", { path: "/w/a/x.go", focus: "true" }).placed[0]).toMatchObject({ op: { focus: true }, keepFocus: false });
    expect(open("view.open.file", { path: "/w/a/x.go", pane: "p-1" }).placed[0]?.op.pane).toBe("p-1");
  });

  it("a refused call opens nothing", () => {
    expect(() => open("view.open.page", { path: "/w/a/p.txt" })).toThrow("is not an .html or .htm file");
    const placed: unknown[] = [];
    const cmds = panelItemCommands(() => thread, (op) => placed.push(op));
    expect(() => cmds.find((c) => c.cmd.name === "view.open.page")?.run(ctx, { path: "/w/a/p.txt" })).toThrow();
    expect(placed).toEqual([]);
  });
});

describe("intoUsersDiff, like the daemon's (commands_view_diff_pick.go)", () => {
  const mine = { project: "r1", worktree: "/w/a", own: "1", filter: "go", fold: "1", path: "b.go" };
  const state = (params: Record<string, string>): State => ({
    v: 1,
    spaces: [{ id: "sp-1", name: "Main", root: { t: "pane", id: "p-1", tabs: [{ id: "t-1", kind: "thread", thread: "t1" }, { id: "t-d", kind: "diff", thread: "t1", params }], active: "t-1" }, mru: [] }],
    current_space: "sp-1",
    default_space: "sp-1",
  });
  const op = (params: Record<string, string>) => ({ op: "open_surface", tab: { id: "", kind: "diff", thread: "t1", params } });
  const pick = { project: "r1", worktree: "/w/a", own: "1", path: "x.go" };

  it("a pick on the user's open tab picks the file there and keeps what the user has", () => {
    expect(intoUsersDiff(state(mine), op(pick), "t1")).toMatchObject({ tab: { params: { ...mine, path: "x.go" } } });
  });

  it("no file: the user's tab as it is", () => {
    expect(intoUsersDiff(state(mine), op({ project: "r1", worktree: "/w/a", own: "1" }), "t1")).toMatchObject({ tab: { params: mine } });
  });

  it("out of a commit, back to the sides it came from", () => {
    const inCommit = { project: "r1", worktree: "/w/a", own: "1", commit: "abc", backBase: "staged", backPath: "b.go" };
    expect(intoUsersDiff(state(inCommit), op(pick), "t1", () => true)).toMatchObject({ tab: { params: { project: "r1", worktree: "/w/a", own: "1", base: "staged", path: "x.go" } } });
  });

  it("other sides that do not list it: a tab of the asker's own", () => {
    const other = { ...mine, base: "ref:v1" };
    expect(intoUsersDiff(state(other), op(pick), "t1", () => false)).toMatchObject({ tab: { params: { ...pick, thread: "t1" } } });
    expect(intoUsersDiff(state(other), op(pick), "t1", () => true)).toMatchObject({ tab: { params: { ...other, path: "x.go" } } });
  });

  it.each([
    ["a framed call (its own tab)", { project: "r1", worktree: "/w/a", thread: "t1", note: "Why" }],
    ["another checkout", { project: "r2", worktree: "/w/b", path: "api.go" }],
  ])("%s goes as it is", (_name, params) => {
    const o = op(params);
    expect(intoUsersDiff(state(mine), o, "t1")).toBe(o);
  });
});
