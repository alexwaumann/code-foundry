/**
 * The text of the mock's scripted s-r1 "Fix stale PR badge" (mock/thread.ts): its answer, its
 * Edit, its tools' outputs and its questions. No generated code, so component tests can build
 * the same thread from it (src/test/threadWorld.ts).
 */

/** A staged image the scripted first message refers to. */
export const MOCK_ATTACHMENT = "/mock/attachments/pr-badge-stale.png";
export const PUSH = "git push --force-with-lease origin cf/pr-badge-stale";

export const ANSWER_HEAD = `## Fixed: stale badge after a force-push

The poller compared only \`CheckCount\` and \`ReviewState\`, so a force-push that kept the same checks looked unchanged and the badge never refreshed. The fingerprint now includes the head SHA, which the batched GraphQL query already returns, so **no extra API calls**.

### What changed

- \`Fingerprint\` carries \`HeadOid\` ([internal/store/pr/fingerprint.go](https://github.com/alexwaumann/code-foundry/blob/main/internal/store/pr/fingerprint.go)).
- \`fingerprintOf\` fills it from \`pr.HeadRefOid\`.
- New test \`TestFingerprintChangesOnForcePush\`; the reviewer subagent found nothing else.

| Case | Before | After |
| --- | --- | --- |
| New commit, same checks | skipped | refreshed |
| Force-push, same checks | skipped | refreshed |
| Nothing changed | skipped | skipped |

`;
export const GO_BLOCK = "```go\nfunc fingerprintOf(pr PullRequest) Fingerprint {\n\treturn Fingerprint{\n\t\tCheckCount:  len(pr.Checks),\n\t\tReviewState: pr.ReviewDecision,\n\t\tHeadOid:     pr.HeadRefOid, // moves on every push\n\t}\n}\n```\n\n";
export const ANSWER = `${ANSWER_HEAD}${GO_BLOCK}Tests: \`go test ./internal/store/pr/\` passes. I have not pushed.`;
export const ANSWER_STREAMING = `${ANSWER_HEAD}\`\`\`go\nfunc fingerprintOf(pr PullRequest) Fingerprint {\n\treturn Fingerprint{\n\t\tCheckCount:  len(pr.Checks),\n\t\tReviewState: pr.Revi`;
export const EDIT_OLD = "type Fingerprint struct {\n\tCheckCount  int\n\tReviewState string\n}\n\nfunc fingerprintOf(pr PullRequest) Fingerprint {\n\treturn Fingerprint{CheckCount: len(pr.Checks), ReviewState: pr.ReviewDecision}\n}";
export const EDIT_NEW =
  "type Fingerprint struct {\n\tCheckCount  int\n\tReviewState string\n\tHeadOid     string // moves on every push, force-pushes included\n}\n\nfunc fingerprintOf(pr PullRequest) Fingerprint {\n\treturn Fingerprint{\n\t\tCheckCount:  len(pr.Checks),\n\t\tReviewState: pr.ReviewDecision,\n\t\tHeadOid:     pr.HeadRefOid,\n\t}\n}";
export const EDIT_PATCH = [
  {
    oldStart: 18,
    oldLines: 9,
    newStart: 18,
    newLines: 14,
    lines: [
      " // Fingerprint is what the poller compares between two polls of a pull request.",
      " type Fingerprint struct {",
      " \tCheckCount  int",
      " \tReviewState string",
      "+\tHeadOid     string // moves on every push, force-pushes included",
      " }",
      " ",
      " func fingerprintOf(pr PullRequest) Fingerprint {",
      "-\treturn Fingerprint{CheckCount: len(pr.Checks), ReviewState: pr.ReviewDecision}",
      "+\treturn Fingerprint{",
      "+\t\tCheckCount:  len(pr.Checks),",
      "+\t\tReviewState: pr.ReviewDecision,",
      "+\t\tHeadOid:     pr.HeadRefOid,",
      "+\t}",
      " }",
    ],
  },
];
export const FAIL_OUTPUT =
  "Exit code 1\n--- FAIL: TestFingerprintChangesOnForcePush (0.00s)\n    fingerprint_test.go:41: fingerprint unchanged after the head moved\n        got:  {CheckCount:3 ReviewState:APPROVED}\n        want: a different fingerprint\nFAIL\nFAIL\tgithub.com/alexwaumann/code-foundry/internal/store/pr\t0.412s";
export const GREP_OUTPUT =
  'internal/store/pr/gh/query.graphql:23:      headRefOid\ninternal/store/pr/model.go:31:\tHeadRefOid     string\ninternal/store/pr/decode.go:58:\tpr.HeadRefOid = n.HeadRefOid\ninternal/store/pr/decode_test.go:72:\tHeadRefOid: "9f3c2e1",\ninternal/store/linkedpr/sync.go:104:\tif old.HeadRefOid != pr.HeadRefOid {';
export const QUESTIONS = {
  questions: [
    {
      question: "The branch was rebased onto main, so a plain push will be rejected. How should I push?",
      header: "Push",
      multiSelect: false,
      options: [
        { label: "Force with lease (Recommended)", description: "Overwrites the remote branch only if nobody else pushed to it" },
        { label: "Push to a new branch", description: "cf/pr-badge-stale-2, then retarget PR #63" },
        { label: "Don't push", description: "Leave the commits local" },
      ],
    },
    {
      question: "Should I also update the PR description?",
      header: "PR text",
      multiSelect: false,
      options: [
        { label: "Yes", description: "Mention the fingerprint change" },
        { label: "No", description: "" },
      ],
    },
  ],
};
