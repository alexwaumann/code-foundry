/**
 * The mock daemon's scripted s-r1 "Fix stale PR badge" (mock/thread.ts load) as view models,
 * for component tests of the timeline and the composer: turn 1 (reads, greps, a question, a
 * failing test, the Edit, a code-reviewer subagent, the markdown answer), and turn 2 per
 * state. Times are relative to `now` the way the mock's `ago(min, sec)` is. It does not
 * import mock/: when the script changes, change this copy with it.
 */
import type { ThreadItemView, ThreadPendingView, ThreadRequestView } from "@/api/thread";
import { buildRows, buildTurns, decodeTimelineKey, timelineKey, type TimelineRow } from "@/lib/threadTimeline";
import { structOf, useThreadStore } from "@/stores/thread";

export const CF = "/Users/dev/src/code-foundry";
export const ATTACHMENT = "/mock/attachments/pr-badge-stale.png";
export const PUSH = "git push --force-with-lease origin cf/pr-badge-stale";

export const GREP_OUTPUT =
  'internal/store/pr/gh/query.graphql:23:      headRefOid\ninternal/store/pr/model.go:31:\tHeadRefOid     string\ninternal/store/pr/decode.go:58:\tpr.HeadRefOid = n.HeadRefOid\ninternal/store/pr/decode_test.go:72:\tHeadRefOid: "9f3c2e1",\ninternal/store/linkedpr/sync.go:104:\tif old.HeadRefOid != pr.HeadRefOid {';
export const FAIL_OUTPUT =
  "Exit code 1\n--- FAIL: TestFingerprintChangesOnForcePush (0.00s)\n    fingerprint_test.go:41: fingerprint unchanged after the head moved\n        got:  {CheckCount:3 ReviewState:APPROVED}\n        want: a different fingerprint\nFAIL\nFAIL\tgithub.com/alexwaumann/code-foundry/internal/store/pr\t0.412s";

const ANSWER_HEAD = `## Fixed: stale badge after a force-push

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
const GO_BLOCK = "```go\nfunc fingerprintOf(pr PullRequest) Fingerprint {\n\treturn Fingerprint{\n\t\tCheckCount:  len(pr.Checks),\n\t\tReviewState: pr.ReviewDecision,\n\t\tHeadOid:     pr.HeadRefOid, // moves on every push\n\t}\n}\n```\n\n";
export const ANSWER = `${ANSWER_HEAD}${GO_BLOCK}Tests: \`go test ./internal/store/pr/\` passes. I have not pushed.`;
export const ANSWER_STREAMING = `${ANSWER_HEAD}\`\`\`go\nfunc fingerprintOf(pr PullRequest) Fingerprint {\n\treturn Fingerprint{\n\t\tCheckCount:  len(pr.Checks),\n\t\tReviewState: pr.Revi`;

const EDIT_OLD = "type Fingerprint struct {\n\tCheckCount  int\n\tReviewState string\n}\n\nfunc fingerprintOf(pr PullRequest) Fingerprint {\n\treturn Fingerprint{CheckCount: len(pr.Checks), ReviewState: pr.ReviewDecision}\n}";
const EDIT_NEW =
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

export function request(over: Partial<ThreadRequestView>): ThreadRequestView {
  return {
    requestId: "",
    toolName: "",
    displayName: "",
    title: "",
    description: "",
    toolUseId: "",
    agentId: "",
    blockedPath: "",
    decisionReason: "",
    inputJson: "",
    suggestionsJson: "",
    state: "pending",
    decision: "",
    message: "",
    answers: {},
    ...over,
  };
}

export type TurnEnd = Extract<ThreadItemView, { kind: "turnEnd" }>;

export type ThreadWorldState = "idle" | "permission" | "question" | "streaming";

export interface ThreadWorld {
  items: ThreadItemView[];
  pending: ThreadPendingView[];
}

/** s-r1's items in `state`, as the Watch's snapshot brings them at `now`. */
export function fixStalePrBadge(state: ThreadWorldState, now = Date.now()): ThreadWorld {
  const items: ThreadItemView[] = [];
  let ordinal = 0;
  const ago = (min: number, sec = 0) => now - min * 60_000 + sec * 1000;
  const p = (rel: string) => `${CF}/${rel}`;
  type Over = { at?: number; until?: number; parent?: string; id?: string; streaming?: boolean };
  const push = <T extends ThreadItemView>(x: Omit<T, "id" | "ordinal" | "parentToolUseId" | "createdAtMs" | "updatedAtMs" | "streaming">, o: Over): T => {
    ordinal++;
    const it = { id: o.id ?? `i${String(ordinal)}`, ordinal, parentToolUseId: o.parent ?? "", createdAtMs: o.at ?? now, updatedAtMs: o.until ?? o.at ?? now, streaming: o.streaming ?? false, ...x } as T;
    items.push(it);
    return it;
  };
  const text = (t: string, o: Over) => push({ kind: "text", text: t }, o);
  const tool = (name: string, input: object, v: { output?: string; isError?: boolean; resultJson?: string; status?: "running" | "done" | "error" }, o: Over) => {
    const id = `toolu_${name.toLowerCase()}_${String(ordinal + 1)}`;
    return push({ kind: "tool", toolUseId: id, name, inputJson: JSON.stringify(input), status: v.status ?? "done", output: v.output ?? "", isError: v.isError ?? false, resultJson: v.resultJson ?? "" }, { ...o, id });
  };
  const read = (rel: string, lines: number, at: number, parent = "") =>
    tool("Read", { file_path: p(rel) }, { output: "     1\tpackage pr\n", resultJson: JSON.stringify({ type: "text", file: { filePath: p(rel), content: "package pr\n\n// …\n", numLines: lines, startLine: 1, totalLines: lines } }) }, { at, parent });
  const end = (v: Partial<TurnEnd>, at: number) =>
    push<TurnEnd>(
      {
        kind: "turnEnd",
        subtype: "success",
        isError: false,
        interrupted: false,
        stopReason: "end_turn",
        terminalReason: "",
        durationMs: 0,
        numTurns: 1,
        costUsd: 0,
        turnCostUsd: null,
        model: "",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        errors: [],
        ...v,
      },
      { at },
    );

  // Turn 1.
  push(
    {
      kind: "user",
      text: `The PR badge in the sidebar stays green after a force-push, see [Image: pr-badge-stale.png; ref=${ATTACHMENT}] Look at @cf-file://repo-cf/internal/store/pr/poller.go and fix it with /tdd . Keep the fingerprint check-count based in /tmp.`,
      attachments: [ATTACHMENT],
      composerText:
        "The PR badge in the sidebar stays green after a force-push, see ![pr-badge-stale.png](cf-attachment://0) Look at [poller.go](cf-file://repo-cf/internal/store/pr/poller.go) and fix it with [/tdd](cf-skill://~/tdd). Keep the fingerprint check-count based in /tmp.",
    },
    { at: ago(9) },
  );
  push({ kind: "thinking", text: "The badge reads the poller's fingerprint. If a force-push keeps the check count, nothing changes…" }, { at: ago(9, 1), until: ago(9, 10) });
  text("I'll read the poller and the fingerprint first, then write a failing test.", { at: ago(9, 11) });
  read("internal/store/pr/poller.go", 212, ago(9, 12));
  read("internal/store/pr/poller_test.go", 148, ago(9, 13));
  tool("Grep", { pattern: "fingerprint", path: p("internal/store/pr") }, { output: "internal/store/pr/poller.go:88:\tfp := fingerprintOf(pr)", resultJson: JSON.stringify({ mode: "content", numLines: 1, numFiles: 1 }) }, { at: ago(9, 14) });
  read("internal/store/pr/gh/client.go", 301, ago(9, 15));
  tool("Grep", { pattern: "Checks", path: p("internal/store/pr/gh") }, { output: "internal/store/pr/gh/client.go:120:\tChecks []Check", resultJson: JSON.stringify({ mode: "content", numLines: 1, numFiles: 1 }) }, { at: ago(9, 16) });
  text("Now the fingerprint itself.", { at: ago(9, 18) });
  read("internal/store/pr/fingerprint.go", 84, ago(9, 19));
  tool("Grep", { pattern: "HeadRefOid", path: p("internal/") }, { output: GREP_OUTPUT, resultJson: JSON.stringify({ mode: "content", numLines: 5, numFiles: 5 }) }, { at: ago(9, 20) });
  read("internal/store/pr/gh/query.graphql", 61, ago(9, 21));
  text(
    "The fingerprint is `CheckCount` + `ReviewState` only, so a force-push that keeps the same checks looks unchanged and the poller never refreshes the badge. The head SHA is already in the batched query.",
    { at: ago(9, 25) },
  );
  const approach = { questions: [{ question: "How should the poller notice a force-push?", header: "Fix approach", multiSelect: false, options: [{ label: "Head SHA in the fingerprint", description: "" }, { label: "Poll the PR's events", description: "" }] }] };
  const ask = tool("AskUserQuestion", approach, {}, { at: ago(8, 0) });
  push(
    {
      kind: "question",
      request: request({
        requestId: "req-approach",
        toolName: "AskUserQuestion",
        toolUseId: ask.toolUseId,
        inputJson: ask.inputJson,
        state: "allowed",
        decision: "allow",
        answers: { "How should the poller notice a force-push?": "Head SHA in the fingerprint" },
      }),
    },
    { at: ago(8, 1) },
  );
  tool(
    "Write",
    { file_path: p("internal/store/pr/fingerprint_test.go"), content: "package pr\n" },
    { output: `File created successfully at: ${p("internal/store/pr/fingerprint_test.go")}`, resultJson: JSON.stringify({ type: "create", filePath: p("internal/store/pr/fingerprint_test.go"), content: "package pr\n", structuredPatch: [] }) },
    { at: ago(7, 30) },
  );
  tool("Bash", { command: "go test ./internal/store/pr/ -run TestFingerprint", description: "Run the new test" }, { status: "error", isError: true, output: FAIL_OUTPUT }, { at: ago(7, 40), until: ago(7, 40.9) });
  tool(
    "Edit",
    { file_path: p("internal/store/pr/fingerprint.go"), old_string: EDIT_OLD, new_string: EDIT_NEW },
    { output: "The file has been updated.", resultJson: JSON.stringify({ filePath: p("internal/store/pr/fingerprint.go"), structuredPatch: EDIT_PATCH }) },
    { at: ago(7, 0) },
  );
  tool("Bash", { command: "go test ./internal/store/pr/" }, { output: "ok  \tgithub.com/alexwaumann/code-foundry/internal/store/pr\t0.388s", resultJson: JSON.stringify({ stdout: "ok  \tgithub.com/alexwaumann/code-foundry/internal/store/pr\t0.388s", stderr: "" }) }, { at: ago(6, 50), until: ago(6, 51.3) });
  const agent = tool(
    "Agent",
    { description: "Review the fingerprint change", subagent_type: "code-reviewer", prompt: "Review the fingerprint change for missed cases." },
    {
      output: "Looks right.",
      resultJson: JSON.stringify({
        status: "completed",
        totalToolUseCount: 4,
        totalDurationMs: 41_000,
        content: [{ type: "text", text: "Looks right. `HeadRefOid` is already selected in `query.graphql:23`, so no query change. Nit: the test name could say *ForcePush* rather than *HeadMoved*." }],
      }),
    },
    { at: ago(6, 40) },
  );
  read("internal/store/pr/fingerprint.go", 91, ago(6, 45), agent.toolUseId);
  read("internal/store/pr/poller.go", 212, ago(6, 46), agent.toolUseId);
  tool("Grep", { pattern: "fingerprintOf(", path: p("internal/") }, { output: "internal/store/pr/poller.go:88:\tfp := fingerprintOf(pr)", resultJson: JSON.stringify({ mode: "content", numLines: 3, numFiles: 2 }) }, { at: ago(6, 50), parent: agent.toolUseId });
  tool("Bash", { command: "go vet ./internal/store/pr/..." }, { output: "" }, { at: ago(7, 0), parent: agent.toolUseId });
  if (state === "streaming") {
    text(ANSWER_STREAMING, { at: ago(5, 30), streaming: true });
    return { items, pending: [] };
  }
  text(ANSWER, { at: ago(5, 30) });
  end({ durationMs: 248_000, numTurns: 22, costUsd: 1.12, inputTokens: 48_200, outputTokens: 6_100 }, ago(4, 52));

  // Turn 2.
  push({ kind: "user", text: "Looks good. Run the full suite, then push the branch.", attachments: [], composerText: "" }, { at: ago(4) });
  tool("Bash", { command: "go test ./..." }, { output: "ok  \tgithub.com/alexwaumann/code-foundry/...\t(412 tests)", resultJson: JSON.stringify({ stdout: "ok  \t…/internal/store/pr\t0.41s\nok  \t…/internal/api\t3.2s\n(412 tests passed)", stderr: "" }) }, { at: ago(3, 12), until: ago(3, 50) });
  if (state === "idle") {
    text("All 412 tests pass and the branch is pushed: PR #63 picked up the fix. The notes are in README.md, and the poller starts at `src/app.ts:12`.", { at: ago(2) });
    // Turn 1 has no turn cost or model; turn 2's process started its totals afresh.
    end({ durationMs: 62_000, numTurns: 4, costUsd: 1.5, turnCostUsd: 1.5, model: "claude-sonnet-5" }, ago(1, 58));
    return { items, pending: [] };
  }
  if (state === "question") {
    text("All 412 tests pass. Two things to settle before I push.", { at: ago(3) });
    const q = tool("AskUserQuestion", QUESTIONS, { status: "running" }, { at: ago(2, 58) });
    const item = push({ kind: "question", request: request({ requestId: "req-push-q", toolName: "AskUserQuestion", toolUseId: q.toolUseId, inputJson: JSON.stringify(QUESTIONS) }) }, { at: ago(2, 57) });
    return { items, pending: [{ requestId: "req-push-q", itemId: item.id, question: true, toolName: "AskUserQuestion", summary: QUESTIONS.questions[0]?.question ?? "" }] };
  }
  text("All 412 tests pass. The branch was rebased onto `main` earlier, so this needs a force-push.", { at: ago(3) });
  const call = tool("Bash", { command: PUSH, description: "Force-push the rebased branch so PR #63 picks up the fix." }, { status: "running" }, { at: ago(2, 58) });
  const perm = push(
    {
      kind: "permission",
      request: request({
        requestId: "req-push",
        toolName: "Bash",
        displayName: "Bash",
        toolUseId: call.toolUseId,
        inputJson: call.inputJson,
        description: "Force-push the rebased branch so PR #63 picks up the fix.",
        decisionReason: "Accept edits asks before commands",
        suggestionsJson: JSON.stringify([{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git push:*" }], behavior: "allow", destination: "session" }]),
      }),
    },
    { at: ago(2, 57) },
  );
  return { items, pending: [{ requestId: "req-push", itemId: perm.id, question: false, toolName: "Bash", summary: `Bash ${PUSH}` }] };
}

/** Puts a thread's items (and pending requests) in the thread store, as its Watch's snapshot would. */
export function publishThread(threadId: string, w: ThreadWorld): void {
  useThreadStore.setState((s) => ({
    logs: { ...s.logs, [threadId]: { seq: w.items.length, byId: Object.fromEntries(w.items.map((it) => [it.id, it])), order: w.items.map((it) => it.id), pending: w.pending, mcp: null, commands: [], agents: [] } },
  }));
}

/** The timeline's rows for items, the way Timeline builds them. */
export function rowsOf(items: readonly ThreadItemView[], opts: { working: boolean; fold?: (turnKey: string) => boolean | undefined; strips?: boolean }): TimelineRow[] {
  return buildRows(buildTurns(items.map((it) => decodeTimelineKey(timelineKey(structOf(it))))), { fold: opts.fold ?? (() => undefined), working: opts.working, strips: opts.strips ?? false });
}
