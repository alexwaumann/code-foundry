import { describe, expect, it } from "vitest";
import {
  collisionBanner,
  collisionHints,
  collisions,
  collisionTip,
  draftCheckouts,
  threadCheckouts,
  unshownHints,
  type Collision,
  type HintProjects,
  type HintThread,
} from "./collisionHints";

const projects: HintProjects = {
  web: {
    name: "web",
    git: true,
    path: "/src/web",
    worktrees: [
      { path: "/src/web", branch: "main", head: "aaaaaaa1", isMain: true },
      { path: "/wt/web/feat-x", branch: "feat/x", head: "bbbbbbb2", isMain: false },
    ],
  },
  api: {
    name: "api",
    git: true,
    path: "/src/api",
    worktrees: [
      { path: "/src/api", branch: "main", head: "ccccccc3", isMain: true },
      { path: "/wt/api/feat-x", branch: "feat/x", head: "ddddddd4", isMain: false },
      // Made for feat/moved, then git switch: listed on its new branch.
      { path: "/wt/api/feat-moved", branch: "other", head: "eeeeeee5", isMain: false },
    ],
  },
  notes: { name: "notes", git: false, path: "/Users/dev/notes", worktrees: [{ path: "/Users/dev/notes", branch: "", head: "", isMain: true }] },
};

const thread = (over: Partial<HintThread>): HintThread => ({
  id: "s-1",
  name: "Fix login",
  projectId: "web",
  projectIds: ["web"],
  worktreePath: "/src/web",
  createdWorktree: false,
  branch: "",
  archived: false,
  ...over,
});

describe("threadCheckouts", () => {
  it.each<[string, Partial<HintThread>, { projectId: string; path: string }[]]>([
    ["a single-project thread: its cwd", {}, [{ projectId: "web", path: "/src/web" }]],
    [
      "worktree mode: the primary's cwd, the others' worktrees on the branch, a folder its folder",
      { projectIds: ["api", "notes", "web"], worktreePath: "/wt/web/feat-x", createdWorktree: true, branch: "feat/x" },
      [
        { projectId: "api", path: "/wt/api/feat-x" },
        { projectId: "notes", path: "/Users/dev/notes" },
        { projectId: "web", path: "/wt/web/feat-x" },
      ],
    ],
    ["worktree mode, a branch not listed: that member is left out", { projectIds: ["api", "web"], worktreePath: "/wt/web/x", createdWorktree: true, branch: "cf/new" }, [{ projectId: "web", path: "/wt/web/x" }]],
    [
      "checkout mode: the main checkouts",
      { projectIds: ["api", "web"] },
      [
        { projectId: "api", path: "/src/api" },
        { projectId: "web", path: "/src/web" },
      ],
    ],
    ["an unknown member is left out", { projectIds: ["gone", "web"] }, [{ projectId: "web", path: "/src/web" }]],
    ["no project set: the primary alone", { projectIds: [] }, [{ projectId: "web", path: "/src/web" }]],
    [
      "recorded: the paths the thread records, whatever they have checked out (not the worktree on the branch)",
      {
        projectIds: ["api", "web"],
        worktreePath: "/wt/web/feat-x",
        createdWorktree: true,
        branch: "feat/x",
        checkoutPaths: [
          { projectId: "api", path: "/wt/api/moved" },
          { projectId: "web", path: "/wt/web/feat-x" },
        ],
      },
      [
        { projectId: "api", path: "/wt/api/moved" },
        { projectId: "web", path: "/wt/web/feat-x" },
      ],
    ],
    [
      "recorded in place: a user's worktree it left, not the main checkout",
      { projectIds: ["api", "web"], checkoutPaths: [{ projectId: "api", path: "/u/api-mine" }] },
      [
        { projectId: "api", path: "/u/api-mine" },
        { projectId: "web", path: "/src/web" },
      ],
    ],
    [
      "recorded empty: resolved like a member with nothing recorded",
      { projectIds: ["api", "web"], worktreePath: "/wt/web/feat-x", createdWorktree: true, branch: "feat/x", checkoutPaths: [{ projectId: "api", path: "" }] },
      [
        { projectId: "api", path: "/wt/api/feat-x" },
        { projectId: "web", path: "/wt/web/feat-x" },
      ],
    ],
    ["recorded, the project unknown: its path still counts", { projectIds: ["gone", "web"], checkoutPaths: [{ projectId: "gone", path: "/x/gone" }] }, [
      { projectId: "gone", path: "/x/gone" },
      { projectId: "web", path: "/src/web" },
    ]],
  ])("%s", (_name, over, want) => {
    expect(threadCheckouts(thread(over), projects)).toEqual(want);
  });
});

describe("draftCheckouts", () => {
  it.each<[string, Parameters<typeof draftCheckouts>[0], { projectId: string; path: string }[]]>([
    [
      "in place: every main checkout, the primary's picked worktree",
      { projectIds: ["api", "web"], primary: "web", worktreeMode: false, primaryPath: "/wt/web/feat-x" },
      [
        { projectId: "api", path: "/src/api" },
        { projectId: "web", path: "/wt/web/feat-x" },
      ],
    ],
    ["fresh copies: only the plain folders", { projectIds: ["api", "notes", "web"], primary: "web", worktreeMode: true }, [{ projectId: "notes", path: "/Users/dev/notes" }]],
    [
      "an existing branch: the plain folders and each listed worktree on it",
      { projectIds: ["api", "notes", "web"], primary: "web", worktreeMode: true, branch: "feat/x" },
      [
        { projectId: "api", path: "/wt/api/feat-x" },
        { projectId: "notes", path: "/Users/dev/notes" },
        { projectId: "web", path: "/wt/web/feat-x" },
      ],
    ],
    ["an existing branch no project has a worktree of: only the plain folders", { projectIds: ["api", "notes"], primary: "api", worktreeMode: true, branch: "fix/y" }, [{ projectId: "notes", path: "/Users/dev/notes" }]],
    // The daemon refuses a branch checked out in the main checkout, and a worktree made for it that was switched away is another thread's.
    ["a branch the main checkout has: not shared", { projectIds: ["api"], primary: "api", worktreeMode: true, branch: "main" }, []],
    ["a worktree made for the branch, switched to another: not shared", { projectIds: ["api"], primary: "api", worktreeMode: true, branch: "feat/moved" }, []],
    [
      "the workspace's folder as the primary takes no project's checkout",
      { projectIds: ["api", "web"], primary: "workspace", worktreeMode: false, primaryPath: "/x" },
      [
        { projectId: "api", path: "/src/api" },
        { projectId: "web", path: "/src/web" },
      ],
    ],
  ])("%s", (_name, d, want) => {
    expect(draftCheckouts(d, projects)).toEqual(want);
  });
});

describe("collisionHints", () => {
  const others = [
    thread({}),
    thread({ id: "s-2", name: "", projectId: "api", projectIds: ["api", "notes", "web"], worktreePath: "/wt/api/feat-x", createdWorktree: true, branch: "feat/x" }),
    thread({ id: "s-3", name: "Old", projectId: "api", projectIds: ["api"], worktreePath: "/src/api", archived: true }),
  ];

  it.each<[string, Parameters<typeof collisionHints>[0], string, string[]]>([
    ["no shared checkout", { checkouts: [{ projectId: "api", path: "/src/api" }], worktreeMode: false }, "", []],
    ["a shared main checkout: name @ branch and the other thread's name", { checkouts: [{ projectId: "web", path: "/src/web" }], worktreeMode: false }, "", ["web @ main is also open in Fix login"]],
    ["a shared worktree; an unnamed thread goes by its id", { checkouts: [{ projectId: "api", path: "/wt/api/feat-x" }], worktreeMode: true }, "", ["api @ feat/x is also open in s-2"]],
    [
      "worktree mode: a shared folder cannot be isolated",
      { checkouts: [{ projectId: "notes", path: "/Users/dev/notes" }], worktreeMode: true },
      "",
      ["notes is a folder, not a repo: thread s-2 also works there"],
    ],
    ["in place: a shared folder has no branch", { checkouts: [{ projectId: "notes", path: "/Users/dev/notes/" }], worktreeMode: false }, "", ["notes is also open in s-2"]],
    ["the thread itself does not count", { checkouts: [{ projectId: "web", path: "/src/web" }], worktreeMode: false }, "s-1", []],
  ])("%s", (_name, mine, self, want) => {
    expect(collisionHints(mine, others, projects, self)).toEqual(want);
  });
});

describe("unshownHints", () => {
  const shown = ["web @ main is also open in Busy one", "notes is a folder, not a repo: thread Busy one also works there"];
  it("drops the daemon's lines the composer showed (its thread labels carry the id)", () => {
    expect(
      unshownHints(
        ["web @ main is also open in Busy one (s-12)", "notes is a folder, not a repo: thread Busy one (s-12) also works there", "api @ main is also open in Other (s-3)"],
        shown,
      ),
    ).toEqual(["api @ main is also open in Other (s-3)"]);
  });
  it("keeps everything when nothing was shown, and an unnamed thread's id-only label", () => {
    expect(unshownHints(["web @ main is also open in s-12"], [])).toEqual(["web @ main is also open in s-12"]);
    expect(unshownHints(["web @ main is also open in s-12"], ["web @ main is also open in s-12"])).toEqual([]);
  });
  it("a thread named like another one with brackets still differs", () => {
    expect(unshownHints(["web @ main is also open in fix (wip) (s-1)"], ["web @ main is also open in fix"])).toEqual(["web @ main is also open in fix (wip) (s-1)"]);
  });
});

describe("collisions", () => {
  it("names the project, the checkout's branch, the thread and whether it works", () => {
    expect(collisions({ checkouts: [{ projectId: "web", path: "/src/web" }], worktreeMode: false }, [thread({ working: true })], projects)).toEqual([
      { projectId: "web", project: "web", branch: "main", thread: "Fix login", working: true, folder: false },
    ]);
  });
});

const collision = (over: Partial<Collision>): Collision => ({ projectId: "web", project: "web", branch: "main", thread: "Fix login", working: false, folder: false, ...over });
const sentence = (b: { lead: string; branch: string; tail: string }) => b.lead + b.branch + b.tail;

describe("collisionBanner", () => {
  it.each<[string, Collision[], number, string, string]>([
    ["one project", [collision({})], 1, "This project is already being edited on main by another running thread.", "main"],
    ["two of three, one branch", [collision({}), collision({ projectId: "api", project: "api" })], 3, "2 of 3 projects are already being edited on main by another running thread.", "main"],
    ["one of two: singular verb", [collision({ projectId: "api", project: "api", branch: "feat/x" })], 2, "1 of 2 projects is already being edited on feat/x by another running thread.", "feat/x"],
    [
      "mixed branches: on their branches",
      [collision({}), collision({ projectId: "api", project: "api", branch: "feat/x" })],
      2,
      "2 of 2 projects are already being edited on their branches by another running thread.",
      "",
    ],
    ["a plain folder: no branch to name", [collision({ projectId: "notes", project: "notes", branch: "", folder: true })], 1, "This project is already being edited by another running thread.", ""],
    ["a folder beside a branch: no on …", [collision({}), collision({ projectId: "notes", project: "notes", branch: "" })], 3, "2 of 3 projects are already being edited by another running thread.", ""],
  ])("%s", (_name, list, size, want, branch) => {
    const b = collisionBanner(list, size);
    expect(sentence(b)).toBe(want);
    expect(b.branch).toBe(branch);
  });
});

describe("collisionTip", () => {
  it.each<[string, Collision, ReturnType<typeof collisionTip>]>([
    ["a branch", collision({ working: true }), { place: "web · main", thread: "Fix login", status: "working" }],
    ["a folder: the name alone", collision({ project: "notes", branch: "" }), { place: "notes", thread: "Fix login", status: "idle" }],
  ])("%s", (_name, c, want) => {
    expect(collisionTip(c)).toEqual(want);
  });
});
