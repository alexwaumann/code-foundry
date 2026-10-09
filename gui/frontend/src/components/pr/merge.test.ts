import { describe, expect, it } from "vitest";
import type { MergeableView, MergeMethodView, PrStateView, PullRequestDetailView } from "@/api/gh";
import { canDeleteBranch, mergeArgs, mergeAvailability, mergeMethodHint } from "./merge";

interface Shape {
  state?: PrStateView;
  draft?: boolean;
  mergeable?: MergeableView;
  mergeState?: string;
  viewerCanUpdate?: boolean;
  methods?: MergeMethodView[];
  autoMerge?: boolean;
  fork?: boolean;
  headRef?: string;
}

/** Only the fields the merge logic reads. */
function detail(s: Shape = {}): PullRequestDetailView {
  return {
    pullRequest: {
      state: s.state ?? "open",
      draft: s.draft ?? false,
      mergeable: s.mergeable ?? "mergeable",
      mergeState: s.mergeState ?? "clean",
      baseRef: "main",
      headRef: s.headRef ?? "feat/x",
      isCrossRepository: s.fork ?? false,
    },
    viewerCanUpdate: s.viewerCanUpdate ?? true,
    mergeMethods: s.methods ?? ["merge", "squash", "rebase"],
    autoMergeEnabled: s.autoMerge ?? false,
  } as PullRequestDetailView;
}

describe("mergeAvailability", () => {
  const cases: { name: string; d: Shape; visible: boolean; reason: string | null; methods?: MergeMethodView[]; notes?: string[] }[] = [
    { name: "open, clean", d: {}, visible: true, reason: null, methods: ["merge", "squash", "rebase"] },
    { name: "merged: hidden", d: { state: "merged" }, visible: false, reason: null },
    { name: "closed: hidden", d: { state: "closed" }, visible: false, reason: null },
    { name: "unknown state: hidden", d: { state: "unknown" }, visible: false, reason: null },
    { name: "draft", d: { draft: true, mergeState: "blocked" }, visible: true, reason: "Draft pull requests cannot be merged" },
    { name: "draft by merge state", d: { mergeState: "draft" }, visible: true, reason: "Draft pull requests cannot be merged" },
    { name: "read access", d: { viewerCanUpdate: false, mergeState: "blocked" }, visible: true, reason: "Merging needs write access" },
    { name: "conflicting", d: { mergeable: "conflicting" }, visible: true, reason: "Resolve conflicts first" },
    { name: "dirty", d: { mergeState: "dirty" }, visible: true, reason: "Resolve conflicts first" },
    { name: "blocked", d: { mergeState: "blocked" }, visible: true, reason: "Blocked: required checks or reviews are missing" },
    { name: "behind is allowed, with a note", d: { mergeState: "behind" }, visible: true, reason: null, notes: ["Behind main: it merges as is."] },
    { name: "unstable is allowed, with a note", d: { mergeState: "unstable" }, visible: true, reason: null, notes: ["Some checks that are not required are failing."] },
    { name: "mergeability not computed yet is allowed", d: { mergeable: "unknown", mergeState: "unknown" }, visible: true, reason: null },
    { name: "auto-merge note", d: { autoMerge: true }, visible: true, reason: null, notes: ["Auto-merge is on: GitHub merges it once its requirements pass."] },
    { name: "no method", d: { methods: [] }, visible: true, reason: "This repository allows no merge method" },
    { name: "methods in GitHub's order", d: { methods: ["rebase", "squash"] }, visible: true, reason: null, methods: ["squash", "rebase"] },
  ];
  it.each(cases)("$name", ({ d, visible, reason, methods, notes }) => {
    const a = mergeAvailability(detail(d));
    expect(a.visible).toBe(visible);
    expect(a.reason).toBe(reason);
    if (methods) expect(a.methods).toEqual(methods);
    expect(a.notes).toEqual(notes ?? []);
  });
});

describe("merge args and labels", () => {
  it("builds pr.merge's args", () => {
    expect(mergeArgs({ slug: "o/r", number: 142 }, "squash", true)).toEqual({ "repo-slug": "o/r", number: "142", method: "squash", "delete-branch": "true" });
    expect(mergeArgs({ slug: "o/r", number: 7 }, "merge", false)).toEqual({ "repo-slug": "o/r", number: "7", method: "merge", "delete-branch": "false" });
  });

  it.each([
    { name: "own branch", d: {}, want: true },
    { name: "fork", d: { fork: true }, want: false },
    { name: "no head ref", d: { headRef: "" }, want: false },
  ])("deletes the branch by default: $name", ({ d, want }) => {
    expect(canDeleteBranch(detail(d))).toBe(want);
  });

  it.each([
    ["merge", 3, "Adds its 3 commits to main with a merge commit."],
    ["squash", 3, "Combines its 3 commits into one commit on main."],
    ["squash", 1, "Adds its commit to main as one commit."],
    ["rebase", 1, "Replays its commit onto main."],
    ["rebase", 0, "Replays its commits onto main."],
  ] as const)("hint for %s with %d commits", (m, n, want) => {
    expect(mergeMethodHint(m, n, "main")).toBe(want);
  });
});
