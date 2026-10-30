import { describe, expect, it } from "vitest";
import type { ActionPickView, ActionView } from "@/api/actions";
import type { CheckRollupView, PullRequestView } from "@/api/gh";
import type { GitStatusView } from "@/api/project";
import {
  cardFits,
  cacheMinutesLeft,
  cacheSuffix,
  chooseAction,
  contextPercent,
  fixPrompt,
  gitButtonsBlocked,
  gitStateRow,
  lineageElapsedMs,
  mcpCounts,
  MODEL_WORKING_REASON,
  moreProjects,
  operationLabel,
  operationStep,
  otherModelWorksIn,
  prCheck,
  prRows,
  rebasePrompt,
  serverAddress,
  shellCount,
  shellRuntime,
  splitLineage,
  type GitStateRow,
  type LineageRow,
  type MemberPick,
  type PrInput,
} from "./threadInfo";

function st(o: Partial<GitStatusView> = {}): GitStatusView {
  return { upstream: "origin/feat", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: 1, baseRef: "origin/main", baseAhead: 0, baseBehind: 0, ...o };
}

describe("gitStateRow", () => {
  it.each<[string, GitStatusView | null, GitStateRow | null]>([
    ["no status yet", null, null],
    ["clean and in sync", st(), null],
    ["conflicts first, even mid-rebase and diverged", st({ conflicted: 3, operation: "rebase", operationStep: 2, operationTotal: 5, ahead: 2, behind: 1 }), { kind: "conflicts", files: 3 }],
    ["diverged before an operation", st({ ahead: 3, behind: 2, operation: "merge" }), { kind: "diverged", ahead: 3, behind: 2 }],
    ["a rebase with its step", st({ operation: "rebase", operationStep: 3, operationTotal: 7, ahead: 1 }), { kind: "operation", operation: "rebase", step: 3, total: 7 }],
    ["a merge without a step", st({ operation: "merge" }), { kind: "operation", operation: "merge", step: 0, total: 0 }],
    ["ahead only: push", st({ ahead: 3, baseBehind: 40 }), { kind: "push", ahead: 3 }],
    ["behind only: pull", st({ behind: 2 }), { kind: "pull", behind: 2 }],
    ["no upstream: neither push nor pull", st({ upstream: "", ahead: 4, behind: 1 }), null],
    ["far behind the base: rebase", st({ baseBehind: 14 }), { kind: "rebase", base: "origin/main", behind: 14 }],
    ["a little behind the base: nothing", st({ baseBehind: 9 }), null],
    ["no base: nothing", st({ baseRef: "", baseBehind: 30 }), null],
  ])("%s", (_name, s, want) => {
    expect(gitStateRow(s)).toEqual(want);
  });

  it("words the operation and its step", () => {
    expect(operationLabel("rebase")).toBe("Rebase in progress");
    expect(operationLabel("merge")).toBe("Merge in progress");
    expect(operationLabel("cherry-pick")).toBe("Cherry-pick in progress");
    expect(operationStep(3, 7)).toBe("3/7");
    expect(operationStep(0, 0)).toBe("");
  });

  it("puts the figures in the prompts", () => {
    expect(fixPrompt(3, 1)).toContain("(3 ahead, 1 behind)");
    expect(fixPrompt(3, 1)).toContain("--force-with-lease");
    expect(rebasePrompt("origin/main")).toBe("Rebase this branch onto origin/main, resolve any conflicts, run the checks, then report.");
  });
});

describe("otherModelWorksIn", () => {
  type T = Parameters<typeof otherModelWorksIn>[0]["byId"][string];
  const t = (o: Partial<T>): T => ({ state: "connected", status: "idle", agentsRunning: 0, worktreePath: "/wt", checkoutPaths: [], ...o });
  const run = (others: Record<string, T>) => otherModelWorksIn({ order: ["me", ...Object.keys(others)], byId: { me: t({ status: "busy" }), ...others } }, "me", "/wt");
  it.each<[string, Record<string, T>, boolean]>([
    ["only this thread", {}, false],
    ["another, mid-turn in the cwd", { b: t({ status: "busy" }) }, true],
    ["another, its process up but idle at its prompt", { b: t({}) }, false],
    ["another, idle but its subagents running", { b: t({ agentsRunning: 1 }) }, true],
    ["another, mid-turn with the path as a recorded checkout", { b: t({ status: "busy", worktreePath: "/other", checkoutPaths: [{ projectId: "p", path: "/wt" }] }) }, true],
    ["another, mid-turn elsewhere", { b: t({ status: "busy", worktreePath: "/other" }) }, false],
    ["another, stopped with a stale busy status", { b: t({ status: "busy", state: "disconnected" }) }, false],
  ])("%s", (_name, others, want) => {
    expect(run(others)).toBe(want);
  });
});

describe("gitButtonsBlocked", () => {
  it.each([
    ["idle, nobody else", { working: false, agentsRunning: 0, collision: false }, null],
    ["Claude working", { working: true, agentsRunning: 0, collision: false }, MODEL_WORKING_REASON],
    ["a subagent working", { working: false, agentsRunning: 2, collision: false }, MODEL_WORKING_REASON],
    ["another live thread in the checkout", { working: false, agentsRunning: 0, collision: true }, MODEL_WORKING_REASON],
  ])("%s", (_name, input, want) => {
    expect(gitButtonsBlocked(input)).toBe(want);
  });
});

function action(id: string, projectId: string): ActionView {
  return { id, projectId, name: id, command: "true", icon: "play", inTerminal: false, onWorktreeCreate: false, position: 0 };
}

function pick(projectId: string, id: string, source: ActionPickView["source"], at = 0): MemberPick {
  return { projectId, pick: { source, action: action(id, projectId), last: source === "first" ? null : { runId: `r-${id}`, actionId: id, projectId, threadId: "", mode: "background", trigger: "user", startedAtMs: at } } };
}

describe("chooseAction", () => {
  it("prefers the newest run in this thread, in any project, and names that project", () => {
    const got = chooseAction([pick("api", "Test", "project", 900), pick("web", "Typecheck", "thread", 100), pick("lib", "Build", "thread", 300)], "api");
    expect(got).toEqual({ action: action("Build", "lib"), showProject: true });
  });

  it("else the cwd's project's pick, unnamed", () => {
    expect(chooseAction([pick("web", "Typecheck", "project", 500), pick("api", "Test", "first")], "api")).toEqual({ action: action("Test", "api"), showProject: false });
  });

  it("else the first member with an action", () => {
    expect(chooseAction([{ projectId: "api", pick: null }, pick("web", "Typecheck", "first")], "api")).toEqual({ action: action("Typecheck", "web"), showProject: true });
  });

  it("nothing without actions", () => {
    expect(chooseAction([], "api")).toBeNull();
    expect(chooseAction([{ projectId: "api", pick: null }], "api")).toBeNull();
  });
});

const green: CheckRollupView = { state: "success", total: 3, passed: 3, failed: 0, pending: 0, skipped: 0 };
const failing: CheckRollupView = { ...green, state: "failure", failed: 1 };
const running: CheckRollupView = { ...green, state: "pending", pending: 2 };

function pr(number: number, o: Partial<PullRequestView> = {}): PullRequestView {
  return { number, title: `PR ${String(number)}`, state: "open", draft: false, checks: green, review: "review_required", reviewRequests: [], headRef: `b${String(number)}`, baseRef: "main", ...o } as PullRequestView;
}

describe("prCheck", () => {
  it.each<[string, Partial<PullRequestView>, ReturnType<typeof prCheck>]>([
    ["merged", { state: "merged" }, { icon: null, word: "merged" }],
    ["draft", { draft: true, checks: failing }, { icon: null, word: "draft" }],
    ["checks failing beat the review", { checks: failing, review: "approved" }, { icon: "failed", word: "checks failing" }],
    ["checks running", { checks: running }, { icon: "running", word: "checks running" }],
    ["green and approved", { review: "approved" }, { icon: "ok", word: "approved" }],
    ["green, reviewers asked", { reviewRequests: ["kim"] }, { icon: "ok", word: "review requested" }],
    ["green, a review required but nobody asked", {}, { icon: "ok", word: "review required" }],
    ["no checks, no review needed or asked", { checks: { ...green, state: "none" }, review: null }, { icon: null, word: "no review" }],
    ["no review decision but someone asked", { review: null, reviewRequests: ["acme/core"] }, { icon: "ok", word: "review requested" }],
  ])("%s", (_name, o, want) => {
    expect(prCheck(pr(1, o))).toEqual(want);
  });
});

describe("prRows", () => {
  const projects = new Map([
    ["acme/api", { id: "api", name: "api" }],
    ["acme/lib", { id: "lib", name: "auth-lib" }],
  ]);
  const input = (slug: string, p: PullRequestView | null): PrInput => ({ slug, number: p?.number ?? 9, url: `u${String(p?.number ?? 9)}`, pr: p });

  it("drops closed and unloaded ones, puts the cwd's project first, open before merged, newest first", () => {
    const rows = prRows(
      [input("acme/lib", pr(51, { state: "merged" })), input("acme/lib", pr(57)), input("acme/api", pr(398, { state: "merged" })), input("acme/api", pr(412)), input("acme/api", pr(400, { state: "closed" })), input("acme/api", null)],
      projects,
      ["api", "lib"],
      "api",
    );
    expect(rows.map((r) => [r.number, r.state, r.project])).toEqual([
      [412, "open", ""],
      [398, "merged", ""],
      [57, "open", "auth-lib"],
      [51, "merged", "auth-lib"],
    ]);
  });

  it("names the pull request a stacked one sits on, only when that one is linked and open", () => {
    const rows = prRows([input("acme/lib", pr(57, { headRef: "rot" })), input("acme/lib", pr(58, { baseRef: "rot" })), input("acme/lib", pr(59, { baseRef: "gone" }))], projects, ["lib"], "lib");
    expect(rows.map((r) => [r.number, r.stackedOn])).toEqual([
      [59, null],
      [58, 57],
      [57, null],
    ]);
  });

  it("states a draft by its icon, and names a repository no member has by its slug", () => {
    const [row] = prRows([input("other/x", pr(5, { draft: true }))], projects, ["api"], "api");
    expect(row).toMatchObject({ state: "draft", project: "other/x", check: { icon: null, word: "draft" } });
  });
});

describe("small figures", () => {
  it("the card fits while the conversation keeps 480px beside its 320px", () => {
    expect(cardFits(800)).toBe(true);
    expect(cardFits(799)).toBe(false);
    expect(cardFits(594)).toBe(false);
  });

  it("+N only for an unnamed set of several", () => {
    expect(moreProjects(9, false)).toBe("+8");
    expect(moreProjects(9, true)).toBe("");
    expect(moreProjects(1, false)).toBe("");
  });

  it("the cache countdown", () => {
    expect(cacheSuffix(cacheMinutesLeft(null, 0))).toBe("");
    expect(cacheSuffix(cacheMinutesLeft(41 * 60_000, 0))).toBe("cache 41m");
    expect(cacheSuffix(cacheMinutesLeft(30_000, 0))).toBe("cache 1m");
    expect(cacheSuffix(cacheMinutesLeft(0, 10))).toBe("cache expired");
    expect(cacheSuffix(cacheMinutesLeft(0, 0))).toBe("cache expired");
  });

  it("the context share, none without a window", () => {
    expect(contextPercent(221_000, 1_000_000)).toBe(22);
    expect(contextPercent(300_000, 200_000)).toBe(100);
    expect(contextPercent(5, 0)).toBeNull();
  });

  it("the MCP counts", () => {
    expect(mcpCounts([])).toBeNull();
    expect(mcpCounts(["connected", "failed", "needs-auth", "connected"])).toEqual({ total: 4, connected: 2, failed: 1, needsLogin: 1 });
  });
});

describe("background shells", () => {
  it.each([
    ["node", "node server.js"],
    ["node", "pnpm --dir web dev"],
    ["node", "npx vite --port 5173"],
    ["node", "PORT=3000 NODE_ENV=dev npm start"],
    ["node", "/usr/local/bin/node app.js"],
    ["python", "python3 -m http.server 9399"],
    ["python", "python -m flask run"],
    ["python", "python3.12 serve.py"],
    ["go", "go run ./cmd/server"],
    ["", "make dev"],
    ["", "cd web && pnpm dev"],
    ["", "pythonista run"],
    ["", ""],
  ])("runtime %j of %j", (want, command) => {
    expect(shellRuntime(command)).toBe(want);
  });
  it("addresses and counts", () => {
    expect(serverAddress(9399)).toBe("localhost:9399");
    expect(shellCount(1)).toBe("1 shell");
    expect(shellCount(3)).toBe("3 shells");
    expect(shellCount(1, true)).toBe("1 more shell");
    expect(shellCount(2, true)).toBe("2 more shells");
  });
});

describe("splitLineage", () => {
  const row = (id: string, state: LineageRow["state"], startedAtMs: number): LineageRow => ({ kind: "agent", id, name: id, state, type: "", model: "", effort: "", startedAtMs, endedAtMs: null, durationMs: 0 });
  it("live rows (working, needing you) and previous ones, each newest first", () => {
    const { live, previous } = splitLineage([row("a", "working", 1), row("b", "done", 2), row("c", "attention", 3), row("d", "failed", 4)]);
    expect(live.map((r) => r.id)).toEqual(["c", "a"]);
    expect(previous.map((r) => r.id)).toEqual(["d", "b"]);
  });
  it("elapsed: to now while live, else the duration or start to end", () => {
    expect(lineageElapsedMs(row("a", "working", 1000), 5000)).toBe(4000);
    expect(lineageElapsedMs({ ...row("a", "done", 1000), durationMs: 700 }, 9000)).toBe(700);
    expect(lineageElapsedMs({ ...row("a", "done", 1000), endedAtMs: 3000 }, 9000)).toBe(2000);
    expect(lineageElapsedMs({ ...row("a", "done", 0), startedAtMs: null }, 9000)).toBeNull();
  });
});
