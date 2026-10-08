import { describe, expect, it } from "vitest";
import type { GitOpView, GitOpStateView } from "@/api/gitops";
import { planGitOpToasts } from "./gitops";

function op(id: string, state: GitOpStateView): GitOpView {
  return { id, kind: "push", state, title: "Push feat", worktreePath: "/w", repoId: "r", branch: "feat", durationMs: 0, summary: "", output: "", url: "" };
}

describe("planGitOpToasts", () => {
  it("shows progress, then replaces it with the result", () => {
    let p = planGitOpToasts(new Set(), { kind: "queued", op: op("a", "queued") });
    expect(p.actions.map((a) => a.show)).toEqual(["progress"]);
    p = planGitOpToasts(p.shown, { kind: "started", op: op("a", "running") });
    expect([...p.shown]).toEqual(["a"]);
    p = planGitOpToasts(p.shown, { kind: "finished", op: op("a", "failed") });
    expect(p.actions).toEqual([{ show: "result", op: op("a", "failed") }]);
    expect(p.shown.size).toBe(0);
  });

  it("shows results for ops started elsewhere (CLI)", () => {
    const p = planGitOpToasts(new Set(), { kind: "finished", op: op("cli", "succeeded") });
    expect(p.actions.map((a) => a.show)).toEqual(["result"]);
  });

  it("on a snapshot, shows active ops and resolves only ops it was showing", () => {
    const p = planGitOpToasts(new Set(["mine"]), {
      kind: "snapshot",
      ops: [op("running", "running"), op("queued", "queued"), op("mine", "succeeded"), op("old", "failed")],
    });
    expect(p.actions.map((a) => `${a.show}:${a.op.id}`)).toEqual(["progress:running", "progress:queued", "result:mine"]);
    expect([...p.shown].sort()).toEqual(["queued", "running"]);
  });
});
