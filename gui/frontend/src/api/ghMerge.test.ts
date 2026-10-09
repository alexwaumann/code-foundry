import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { PullRequestDetailSchema, PullRequestMergeMethod } from "@/gen/codefoundry/v1/gh_pb";
import { parseMergeResult, toPullRequestDetailView } from "./gh";

describe("merge fields", () => {
  it("maps the allowed methods and auto-merge", () => {
    const d = create(PullRequestDetailSchema, {
      mergeMethodsAllowed: [PullRequestMergeMethod.MERGE, PullRequestMergeMethod.UNSPECIFIED, PullRequestMergeMethod.REBASE],
      autoMergeEnabled: true,
    });
    expect(toPullRequestDetailView(d)).toMatchObject({ mergeMethods: ["merge", "rebase"], autoMergeEnabled: true });
    expect(toPullRequestDetailView(create(PullRequestDetailSchema, {}))).toMatchObject({ mergeMethods: [], autoMergeEnabled: false });
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
