// @vitest-environment node
import { describe, expect, it } from "vitest";
import { panelItemCommands, type ItemThread } from "./panelItemVerbs";

const thread: ItemThread = {
  projectId: "r1",
  worktreePath: "/w/a",
  githubSlug: "",
  checkouts: [{ projectId: "r2", path: "/w/b" }],
  changed: (root) => (root === "/w/a" ? ["x.go", "src/app.ts", "src/lib/util.ts"] : root === "/w/b" ? ["api.go"] : undefined),
};
const ctx = { activeThreadId: "t1" } as never;

function run(name: string, args: Record<string, string>): { out: unknown; params: Record<string, string> | undefined } {
  let params: Record<string, string> | undefined;
  const cmds = panelItemCommands(
    (id) => (id === "t1" ? thread : undefined),
    (i) => {
      if (i.intent?.case === "showView") params = i.intent.value.params as Record<string, string>;
      return 1;
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

describe("view.open.* in the mock: a linked tab in the layout, and the classic ShowView", () => {
  type Placed = { op: Record<string, unknown>; keepFocus: boolean };
  function open(name: string, args: Record<string, string>, from: unknown = ctx): { placed: Placed[]; shown: string[] } {
    const placed: Placed[] = [];
    const shown: string[] = [];
    const cmds = panelItemCommands(
      (id) => (id === "t1" ? thread : undefined),
      (i) => {
        if (i.intent?.case === "showView") shown.push(i.intent.value.name ?? "");
        return 1;
      },
      (op, keepFocus) => placed.push({ op, keepFocus }),
    );
    const cmd = cmds.find((c) => c.cmd.name === name);
    if (!cmd) throw new Error(`no ${name}`);
    void cmd.run(from as never, args);
    return { placed, shown };
  }

  it.each<[string, Record<string, string>, string, string]>([
    ["view.open.file", { path: "/w/a/x.go" }, "file", "panel.file"],
    ["view.open.page", { path: "/w/a/p.html" }, "file", "panel.file"],
    ["view.open.diff", {}, "diff", "panel.diff"],
    ["view.open.gallery", { title: "Shots", images: "[]" }, "gallery", "panel.gallery"],
  ])("%s opens a %s tab linked to the thread and still shows %s", (name, args, kind, view) => {
    for (const verb of [name, name.replace("view.open.", "view.panel.")]) {
      const { placed, shown } = open(verb, args);
      expect(placed).toHaveLength(1);
      expect(placed[0]?.op).toMatchObject({ op: "open_surface", tab: { kind, thread: "t1" } });
      expect(shown).toEqual([view]);
    }
  });

  it("the alias is unlisted, the new name is not", () => {
    const cmds = panelItemCommands(() => thread, () => 1);
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
    const cmds = panelItemCommands(() => thread, () => 1, (op) => placed.push(op));
    expect(() => cmds.find((c) => c.cmd.name === "view.open.page")?.run(ctx, { path: "/w/a/p.txt" })).toThrow();
    expect(placed).toEqual([]);
  });
});
