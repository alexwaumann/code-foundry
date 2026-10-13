import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import { describe, expect, it } from "vitest";
import type { PrStateView } from "@/api/gh";
import { prStateLook } from "./prState";

describe("prStateLook", () => {
  it.each([
    ["open", false, GitPullRequest, "emerald", "open"],
    ["open", true, GitPullRequestDraft, "muted", "draft"],
    ["merged", false, GitMerge, "violet", "merged"],
    ["merged", true, GitMerge, "violet", "merged"],
    ["closed", false, GitPullRequestClosed, "red", "closed"],
    ["unknown", false, GitPullRequest, "muted", "unknown"],
    [null, false, GitPullRequest, "muted", "unknown"],
  ] as const)("%s (draft %s)", (state: PrStateView | null, draft, icon, tone, label) => {
    expect(prStateLook(state, draft)).toEqual({ icon, tone, label });
  });
});
