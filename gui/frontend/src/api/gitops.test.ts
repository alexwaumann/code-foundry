import { create, toJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { ThreadSchema } from "@/gen/codefoundry/v1/thread_lifecycle_pb";
import { EditorAppSchema, GitOpKind, GitOpSchema, GitOpState, GitOpsEventSchema } from "@/gen/codefoundry/v1/gitops_pb";
import { isGitOpFailure, isGitOpResult, toEditorAppView, toGitOpsEventView } from "./gitops";

const op = create(GitOpSchema, {
  id: "op-3",
  kind: GitOpKind.PR_CREATE,
  state: GitOpState.SUCCEEDED,
  title: "Create PR for feat",
  worktreePath: "/w/feat",
  durationMs: 1500n,
  summary: "created pull request #4",
  url: "https://github.com/o/r/pull/4",
});

describe("gitops mapping", () => {
  it("maps events to view models", () => {
    expect(toGitOpsEventView(create(GitOpsEventSchema, { event: { case: "finished", value: op } }))).toEqual({
      kind: "finished",
      op: expect.objectContaining({ id: "op-3", kind: "pr-create", state: "succeeded", durationMs: 1500, url: "https://github.com/o/r/pull/4" }) as unknown,
    });
    const snap = toGitOpsEventView(create(GitOpsEventSchema, { event: { case: "snapshot", value: { ops: [op] } } }));
    expect(snap?.kind === "snapshot" && snap.ops.length).toBe(1);
    expect(toGitOpsEventView(create(GitOpsEventSchema, {}))).toBeNull();
  });

  it("recognizes a command result that is a GitOp", () => {
    expect(isGitOpResult(toJsonString(GitOpSchema, op))).toBe(true);
    expect(isGitOpResult("")).toBe(false);
    expect(isGitOpResult('{"delivered":2}')).toBe(false);
    expect(isGitOpResult(toJsonString(ThreadSchema, create(ThreadSchema, { id: "s-1", name: "x" })))).toBe(false);
    expect(isGitOpResult("not json")).toBe(false);
  });

  it("recognizes a command failure that carries a GitOp", () => {
    const failed = create(GitOpSchema, { ...op, state: GitOpState.FAILED });
    expect(isGitOpFailure(new ConnectError("Push failed", Code.Unknown, undefined, [{ desc: GitOpSchema, value: failed }]))).toBe(true);
    expect(isGitOpFailure(new ConnectError("not available", Code.FailedPrecondition))).toBe(false);
    expect(isGitOpFailure(new Error("x"))).toBe(false);
  });
});

describe("toEditorAppView", () => {
  it("maps an installed editor app", () => {
    expect(toEditorAppView(create(EditorAppSchema, { name: "Zed", bundleId: "dev.zed.Zed", path: "/Applications/Zed.app" }))).toEqual({
      name: "Zed",
      bundleId: "dev.zed.Zed",
      path: "/Applications/Zed.app",
    });
  });
});
