import { describe, expect, it } from "vitest";
import type { PullRequestView } from "@/api/gh";
import type { ThreadView } from "@/api/threads";
import type { TerminalView } from "@/api/terminal";
import { baseFact, branchPullRequest, operationStrip, originFact, otherThreads, shellsIn, shortRef, upstreamRemote, workingTreeFact, type FactPart } from "./facts";

/** "↑2[success] to push[muted,small]": a card's value with its tones, for compact tables. */
const show = (parts: FactPart[]) => parts.map((p) => `${p.text.trim()}[${p.tone}${p.small ? ",small" : ""}]`).join(" ");

describe("originFact", () => {
  it.each([
    [{ upstream: "", ahead: 3, behind: 0 }, "not pushed[muted]"],
    [{ upstream: "origin/x", ahead: 0, behind: 0 }, "in sync[success]"],
    [{ upstream: "origin/x", ahead: 2, behind: 0 }, "↑2[success] to push[muted,small]"],
    [{ upstream: "origin/x", ahead: 0, behind: 4 }, "↓4[warning] behind[muted,small]"],
    [{ upstream: "origin/x", ahead: 2, behind: 4 }, "↑2[success] ↓4[warning]"],
  ])("%j → %s", (st, want) => {
    expect(show(originFact(st))).toBe(want);
  });
});

describe("baseFact", () => {
  it.each([
    [{ baseAhead: 6, baseBehind: 3 }, "↑6[success] ↓3[warning]"],
    [{ baseAhead: 6, baseBehind: 0 }, "↑6[success]"],
    [{ baseAhead: 0, baseBehind: 1 }, "↓1[warning]"],
    [{ baseAhead: 0, baseBehind: 0 }, "even[muted]"],
    [{}, "even[muted]"],
  ])("%j → %s", (st, want) => {
    expect(show(baseFact(st))).toBe(want);
  });
});

describe("workingTreeFact", () => {
  const z = { staged: 0, modified: 0, untracked: 0, dirty: false };
  it.each([
    [z, "clean[success]"],
    [{ ...z, staged: 1, modified: 2, untracked: 1, dirty: true }, "4[warning] changed[warning,small]"],
    [{ ...z, modified: 1, conflicted: 2, dirty: true }, "2[destructive] unmerged[destructive,small]"],
    [{ ...z, dirty: true }, "changed[warning]"],
  ])("%j → %s", (st, want) => {
    expect(show(workingTreeFact(st))).toBe(want);
  });
});

describe("operationStrip", () => {
  it.each([
    [{}, null],
    [{ operation: "" }, null],
    [{ operation: "rebase", conflicted: 2, operationStep: 3, operationTotal: 6 }, { title: "Rebase in progress", conflicts: "2 conflicts", step: "step 3/6" }],
    [{ operation: "am", conflicted: 1, operationStep: 1, operationTotal: 2 }, { title: "Applying patches in progress", conflicts: "1 conflict", step: "step 1/2" }],
    [{ operation: "merge", conflicted: 1 }, { title: "Merge in progress", conflicts: "1 conflict", step: "" }],
    [{ operation: "cherry-pick", conflicted: 0 }, { title: "Cherry-pick in progress", conflicts: "", step: "" }],
    [{ operation: "revert" }, { title: "Revert in progress", conflicts: "", step: "" }],
    [{ operation: "bisect" }, { title: "Bisect in progress", conflicts: "", step: "" }],
    [{ operation: "rebase", operationStep: 0, operationTotal: 6 }, { title: "Rebase in progress", conflicts: "", step: "" }],
    [{ operation: "sequencer" }, { title: "Sequencer in progress", conflicts: "", step: "" }],
  ])("%j", (st, want) => {
    expect(operationStrip(st)).toEqual(want);
  });
});

describe("shortRef and upstreamRemote", () => {
  it.each([
    ["origin/main", ["origin"], "main"],
    ["upstream/release/1.0", ["origin", "upstream"], "release/1.0"],
    ["main", [], "main"],
    ["feature/x", ["origin"], "feature/x"],
  ])("shortRef(%s) is %s", (ref, remotes, want) => {
    expect(shortRef(ref, remotes)).toBe(want);
  });

  it.each([
    ["origin/cf/x", ["origin"], "origin"],
    ["fork/cf/x", ["fork", "origin"], "fork"],
    ["", ["origin", "upstream"], "origin"],
    ["", ["gitlab"], "gitlab"],
    ["", [], "origin"],
  ])("upstreamRemote(%s) is %s", (upstream, remotes, want) => {
    expect(upstreamRemote(upstream, remotes)).toBe(want);
  });
});

describe("branchPullRequest", () => {
  const pr = (number: number, state: PullRequestView["state"], createdAtMs: number | null): PullRequestView => ({ number, state, createdAtMs }) as PullRequestView;
  it.each([
    ["none", [], null],
    ["the only one", [pr(1, "merged", 5)], 1],
    ["the newest open over a newer merged one", [pr(1, "open", 5), pr(2, "merged", 9), pr(3, "open", 7)], 3],
    ["the newest when none is open", [pr(1, "closed", 5), pr(2, "merged", 9)], 2],
    ["by number when the times are unknown", [pr(4, "closed", null), pr(9, "closed", null)], 9],
  ])("%s", (_name, prs, want) => {
    expect(branchPullRequest(prs)?.number ?? null).toBe(want);
  });
});

describe("otherThreads and shellsIn", () => {
  const P = "/src/web.worktrees/feat";
  const threads = [
    { id: "a", worktreePath: P, archivedAtMs: null },
    { id: "b", worktreePath: P, archivedAtMs: null },
    { id: "c", worktreePath: `${P}/sub`, archivedAtMs: null },
    { id: "d", worktreePath: P, archivedAtMs: 5 },
    { id: "e", worktreePath: "/src/web", archivedAtMs: null },
  ] as ThreadView[];
  const data = { byId: Object.fromEntries(threads.map((t) => [t.id, t])), order: threads.map((t) => t.id) };

  it.each([
    ["no selection: every unarchived thread on the path", "", 2],
    ["the selected thread in this worktree is not other", "a", 1],
    ["a selected thread elsewhere changes nothing", "e", 2],
  ])("%s", (_name, self, want) => {
    expect(otherThreads(data, P, self)).toBe(want);
  });

  it("counts live terminals whose cwd is the path", () => {
    const terms = [
      { id: "t1", cwd: P, state: "running" },
      { id: "t2", cwd: P, state: "exited" },
      { id: "t3", cwd: `${P}/sub`, state: "running" },
      { id: "t4", cwd: P, state: "unknown" },
    ] as TerminalView[];
    expect(shellsIn({ byId: Object.fromEntries(terms.map((t) => [t.id, t])), order: terms.map((t) => t.id) }, P)).toBe(2);
    expect(shellsIn({ byId: {}, order: [] }, P)).toBe(0);
  });
});
