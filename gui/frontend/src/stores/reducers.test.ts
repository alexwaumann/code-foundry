import { describe, expect, it } from "vitest";
import type { RepoView, WorktreeView } from "@/api/repo";
import type { TerminalView } from "@/api/terminal";
import { deriveContext, emptyContext } from "./context";
import { applyRepoEvent, emptyRepos, replaceRepos } from "./repos";
import { applyTerminalEvent, emptyTerminals, replaceTerminals } from "./terminals";

function term(id: string, over: Partial<TerminalView> = {}): TerminalView {
  return {
    id,
    argv: ["zsh"],
    cwd: "/src/app",
    cols: 80,
    rows: 24,
    title: "",
    state: "running",
    exitCode: 0,
    startedAtMs: 1,
    exitedAtMs: null,
    altScreen: false,
    labels: {},
    ...over,
  };
}

function wt(repoId: string, path: string, over: Partial<WorktreeView> = {}): WorktreeView {
  return {
    repoId,
    path,
    branch: path.split("/").pop() ?? "",
    head: "abc",
    isMain: false,
    status: { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: null },
    ...over,
  };
}

function repo(id: string, name: string, worktrees: WorktreeView[]): RepoView {
  return { id, path: worktrees[0]?.path ?? "", name, defaultBranch: "main", githubSlug: "", worktrees };
}

describe("terminals reducer", () => {
  it("appends new terminals and replaces updated ones", () => {
    let s = applyTerminalEvent(emptyTerminals, { kind: "updated", terminal: term("a") });
    s = applyTerminalEvent(s, { kind: "updated", terminal: term("b") });
    s = applyTerminalEvent(s, { kind: "updated", terminal: term("a", { title: "vim" }) });
    expect(s.order).toEqual(["a", "b"]);
    expect(s.byId.a?.title).toBe("vim");
  });

  it("returns the same state for no-op updates and unknown removals", () => {
    const s = applyTerminalEvent(emptyTerminals, { kind: "updated", terminal: term("a") });
    expect(applyTerminalEvent(s, { kind: "updated", terminal: term("a") })).toBe(s);
    expect(applyTerminalEvent(s, { kind: "removed", id: "zzz" })).toBe(s);
  });

  it("only touches the changed terminal's identity", () => {
    let s = applyTerminalEvent(emptyTerminals, { kind: "updated", terminal: term("a") });
    s = applyTerminalEvent(s, { kind: "updated", terminal: term("b") });
    const a = s.byId.a;
    const next = applyTerminalEvent(s, { kind: "updated", terminal: term("b", { state: "exited", exitCode: 2 }) });
    expect(next.byId.a).toBe(a);
    expect(next.byId.b?.exitCode).toBe(2);
  });

  it("removes terminals", () => {
    let s = replaceTerminals(emptyTerminals, [term("a"), term("b")]);
    s = applyTerminalEvent(s, { kind: "removed", id: "a" });
    expect(s.order).toEqual(["b"]);
    expect(s.byId.a).toBeUndefined();
  });

  it("replace keeps identity of unchanged terminals and of the whole state when equal", () => {
    const s = replaceTerminals(emptyTerminals, [term("a"), term("b")]);
    expect(replaceTerminals(s, [term("a"), term("b")])).toBe(s);
    const next = replaceTerminals(s, [term("b"), term("c")]);
    expect(next.order).toEqual(["b", "c"]);
    expect(next.byId.b).toBe(s.byId.b);
    expect(next.byId.a).toBeUndefined();
  });
});

describe("repos reducer", () => {
  const base = replaceRepos([
    repo("r2", "zeta", [wt("r2", "/z", { isMain: true })]),
    repo("r1", "alpha", [wt("r1", "/a.worktrees/x"), wt("r1", "/a", { isMain: true, branch: "main" })]),
  ]);

  it("sorts repos by name and main worktree first", () => {
    expect(base.order).toEqual(["r1", "r2"]);
    expect(base.byId.r1?.worktrees.map((w) => w.path)).toEqual(["/a", "/a.worktrees/x"]);
  });

  it.each([
    ["repoUpdated adds and re-sorts", { kind: "repoUpdated", repo: repo("r0", "beta", []) } as const, ["r1", "r0", "r2"]],
    ["repoRemoved drops", { kind: "repoRemoved", id: "r1" } as const, ["r2"]],
    ["repoRemoved unknown is a no-op", { kind: "repoRemoved", id: "nope" } as const, ["r1", "r2"]],
  ])("%s", (_name, ev, order) => {
    expect(applyRepoEvent(base, ev).order).toEqual(order);
  });

  it("worktreeUpdated upserts within its repo", () => {
    const s = applyRepoEvent(base, { kind: "worktreeUpdated", worktree: wt("r1", "/a.worktrees/a-new") });
    expect(s.byId.r1?.worktrees.map((w) => w.path)).toEqual(["/a", "/a.worktrees/a-new", "/a.worktrees/x"]);
    const dirty = applyRepoEvent(s, { kind: "worktreeUpdated", worktree: wt("r1", "/a.worktrees/x", { status: { ...wt("", "").status, dirty: true } }) });
    expect(dirty.byId.r1?.worktrees.find((w) => w.path === "/a.worktrees/x")?.status.dirty).toBe(true);
    expect(dirty.byId.r2).toBe(base.byId.r2);
  });

  it("worktree events for unknown repos or paths are no-ops", () => {
    expect(applyRepoEvent(base, { kind: "worktreeUpdated", worktree: wt("nope", "/q") })).toBe(base);
    expect(applyRepoEvent(base, { kind: "worktreeRemoved", repoId: "r1", path: "/nope" })).toBe(base);
  });

  it("worktreeRemoved removes", () => {
    const s = applyRepoEvent(base, { kind: "worktreeRemoved", repoId: "r1", path: "/a.worktrees/x" });
    expect(s.byId.r1?.worktrees.map((w) => w.path)).toEqual(["/a"]);
  });

  it("starts empty", () => {
    expect(emptyRepos.order).toEqual([]);
  });
});

describe("deriveContext", () => {
  const repos = replaceRepos([repo("r1", "app", [wt("r1", "/src/app", { isMain: true }), wt("r1", "/src/app.worktrees/feat")])]);
  const terms = replaceTerminals(emptyTerminals, [
    term("t1", { cwd: "/src/app/internal" }),
    term("t2", { cwd: "/tmp", labels: { worktree: "/src/app.worktrees/feat", session: "s-9" } }),
    term("t3", { cwd: "/tmp" }),
  ]);

  it.each([
    ["nothing selected", { kind: "none" } as const, emptyContext],
    [
      "terminal placed by cwd",
      { kind: "terminal", id: "t1" } as const,
      { ...emptyContext, activeTerminalId: "t1", activeRepoId: "r1", activeWorktreePath: "/src/app", activeView: "terminal" },
    ],
    [
      "terminal placed by label, with session",
      { kind: "terminal", id: "t2" } as const,
      { ...emptyContext, activeTerminalId: "t2", activeSessionId: "s-9", activeRepoId: "r1", activeWorktreePath: "/src/app.worktrees/feat", activeView: "terminal" },
    ],
    ["unplaced terminal", { kind: "terminal", id: "t3" } as const, { ...emptyContext, activeTerminalId: "t3", activeView: "terminal" }],
    ["unknown terminal", { kind: "terminal", id: "zz" } as const, { ...emptyContext, activeTerminalId: "zz", activeView: "terminal" }],
    ["repo means its main worktree", { kind: "repo", repoId: "r1" } as const, { ...emptyContext, activeRepoId: "r1", activeWorktreePath: "/src/app", activeView: "repo" }],
    [
      "worktree",
      { kind: "worktree", repoId: "r1", path: "/src/app.worktrees/feat" } as const,
      { ...emptyContext, activeRepoId: "r1", activeWorktreePath: "/src/app.worktrees/feat", activeView: "worktree" },
    ],
    ["composer: the repo only (session.new is available, no worktree yet)", { kind: "compose", repoId: "r1" } as const, { ...emptyContext, activeRepoId: "r1", activeView: "compose" }],
  ])("%s", (_name, sel, want) => {
    expect(deriveContext(sel, terms, repos)).toEqual(want);
  });
});
