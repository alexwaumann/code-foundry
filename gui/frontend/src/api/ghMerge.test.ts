import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { PullRequestDetailSchema, PullRequestMergeMethod } from "@/gen/codefoundry/v1/gh_pb";
import { parseMergeResult, toPullRequestDetailView } from "./gh";

describe("merge fields", () => {
  it("maps the allowed methods, auto-merge, the default branch and the head commit", () => {
    const d = create(PullRequestDetailSchema, {
      pullRequest: { headSha: "e2e0142e2e0142e2e0142e2e0142e2e0142e2e01" },
      mergeMethodsAllowed: [PullRequestMergeMethod.MERGE, PullRequestMergeMethod.UNSPECIFIED, PullRequestMergeMethod.REBASE],
      autoMergeEnabled: true,
      defaultBranch: "main",
    });
    const v = toPullRequestDetailView(d);
    expect(v).toMatchObject({ mergeMethods: ["merge", "rebase"], autoMergeEnabled: true, defaultBranch: "main" });
    expect(v.pullRequest.headSha).toBe("e2e0142e2e0142e2e0142e2e0142e2e0142e2e01");
    expect(toPullRequestDetailView(create(PullRequestDetailSchema, {}))).toMatchObject({ mergeMethods: [], autoMergeEnabled: false, defaultBranch: "" });
  });

  it.each([
    ['{"merged":true,"sha":"abc","message":"Merged #1 (abc)","branchDeleted":true}', { merged: true, sha: "abc", message: "Merged #1 (abc)", branchDeleted: true }],
    ['{"merged":true}', { merged: true, sha: "", message: "", branchDeleted: false }],
    ["{}", { merged: false, sha: "", message: "", branchDeleted: false }],
    ["null", null],
    ["not json", null],
  ])("parses pr.merge's result %s", (json, want) => {
    expect(parseMergeResult(json)).toEqual(want);
  });
});
