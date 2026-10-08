import { fromJsonString } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import { GitOpKind, GitOpSchema, GitOpState, type GitOp, type GitOpsEvent } from "@/gen/codefoundry/v1/gitops_pb";

export type GitOpKindView = "fetch" | "pull" | "push" | "pr-create" | "pr-open" | "open-editor" | "reveal" | "open-url" | "unknown";
export type GitOpStateView = "queued" | "running" | "succeeded" | "failed" | "unknown";

/** View model for one git/gh operation (GitOpsService). Generated types stay in src/api. */
export interface GitOpView {
  id: string;
  kind: GitOpKindView;
  state: GitOpStateView;
  title: string;
  worktreePath: string;
  repoId: string;
  branch: string;
  durationMs: number;
  summary: string;
  output: string;
  url: string;
}

export type GitOpsEventView =
  | { kind: "snapshot"; ops: GitOpView[] }
  | { kind: "queued" | "started" | "finished"; op: GitOpView };

const kindMap: Record<GitOpKind, GitOpKindView> = {
  [GitOpKind.UNSPECIFIED]: "unknown",
  [GitOpKind.FETCH]: "fetch",
  [GitOpKind.PULL]: "pull",
  [GitOpKind.PUSH]: "push",
  [GitOpKind.PR_CREATE]: "pr-create",
  [GitOpKind.PR_OPEN]: "pr-open",
  [GitOpKind.OPEN_EDITOR]: "open-editor",
  [GitOpKind.REVEAL]: "reveal",
  [GitOpKind.OPEN_URL]: "open-url",
};

const stateMap: Record<GitOpState, GitOpStateView> = {
  [GitOpState.UNSPECIFIED]: "unknown",
  [GitOpState.QUEUED]: "queued",
  [GitOpState.RUNNING]: "running",
  [GitOpState.SUCCEEDED]: "succeeded",
  [GitOpState.FAILED]: "failed",
};

export function toGitOpView(o: GitOp): GitOpView {
  return {
    id: o.id,
    kind: kindMap[o.kind],
    state: stateMap[o.state],
    title: o.title,
    worktreePath: o.worktreePath,
    repoId: o.repoId,
    branch: o.branch,
    durationMs: Number(o.durationMs),
    summary: o.summary,
    output: o.output,
    url: o.url,
  };
}

export function toGitOpsEventView(e: GitOpsEvent): GitOpsEventView | null {
  const ev = e.event;
  switch (ev.case) {
    case "snapshot":
      return { kind: "snapshot", ops: ev.value.ops.map(toGitOpView) };
    case "queued":
    case "started":
    case "finished":
      return { kind: ev.case, op: toGitOpView(ev.value) };
    default:
      return null;
  }
}

/**
 * True when a command's result is a git operation (its result_json is a GitOp). The
 * operation's own toast (from gitops events) reports it, so the generic command toast
 * would be a duplicate.
 */
export function isGitOpResult(resultJson: string): boolean {
  if (!resultJson) return false;
  try {
    const op = fromJsonString(GitOpSchema, resultJson);
    return op.id !== "" && op.kind !== GitOpKind.UNSPECIFIED;
  } catch {
    return false;
  }
}

/** True when a command failed because its git operation failed (the error carries the GitOp). */
export function isGitOpFailure(err: unknown): boolean {
  return err instanceof ConnectError && err.findDetails(GitOpSchema).length > 0;
}
