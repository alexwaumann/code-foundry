import { fromJsonString } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import { GitOpKind, GitOpSchema, GitOpState, GitOpsService, type EditorApp, type GitOp, type GitOpsEvent } from "@/gen/codefoundry/v1/gitops_pb";
import { daemon, type DaemonConnection } from "./endpoint";

export type GitOpKindView = "fetch" | "pull" | "push" | "pr-create" | "pr-open" | "open-editor" | "reveal" | "open-url" | "unknown";
export type GitOpStateView = "queued" | "running" | "succeeded" | "failed" | "unknown";

/** View model for one git/gh operation (GitOpsService). Generated types stay in src/api. */
export interface GitOpView {
  id: string;
  kind: GitOpKindView;
  state: GitOpStateView;
  title: string;
  worktreePath: string;
  projectId: string;
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
    projectId: o.projectId,
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

/** An editor installed as an app bundle: what "Open in <app>" offers (worktree.open.editor --app takes bundleId). */
export interface EditorAppView {
  name: string;
  bundleId: string;
  path: string;
}

export function toEditorAppView(a: EditorApp): EditorAppView {
  return { name: a.name, bundleId: a.bundleId, path: a.path };
}

/** Finder's bundle id: ListAppIcons always knows it. */
export const FINDER_BUNDLE_ID = "com.apple.finder";

/** A PNG's bytes as a data URL. */
export function pngDataUrl(png: Uint8Array): string {
  let bin = "";
  // Chunked: String.fromCharCode takes its bytes as arguments.
  for (let i = 0; i < png.length; i += 0x8000) bin += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}

/**
 * GitOpsService.ListAppIcons: Finder's and the installed editors' icons, read by the daemon
 * from the app bundles, as bundle id → PNG data URL. An id without an icon is absent.
 */
export async function listAppIcons(bundleIds: readonly string[], conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<Map<string, string>> {
  const c = await conn.client(GitOpsService);
  const res = await c.listAppIcons({ bundleIds: [...bundleIds] }, { signal });
  return new Map(res.icons.filter((i) => i.png.length > 0).map((i) => [i.bundleId, pngDataUrl(i.png)]));
}

/** GitOpsService.ListEditorApps: the installed editor apps, in the daemon's order (cached there; refresh detects again). */
export async function listEditorApps(refresh = false, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<EditorAppView[]> {
  const c = await conn.client(GitOpsService);
  return (await c.listEditorApps({ refresh }, { signal })).apps.map(toEditorAppView);
}
