/**
 * Rendered threads in the mock daemon (docs/notes/rendered-threads-2-gui.md): one scripted
 * conversation, the sketch's "Fix stale PR badge" (docs/sketches/rendered-thread), in the
 * states the sketch shows, plus ThreadService.Watch / Send / Interrupt and the EventService
 * `thread` source (pending requests only, like the daemon since PR 1's review).
 *
 *   POST /__mock/thread?state=permission|question|streaming|idle[&id=s-r1]
 *        (re)creates the rendered thread in that state; returns { id }
 *   POST /__mock/thread/delta?id=s-r1&text=…   appends text to the streaming answer
 *   POST /__mock/thread/finish?id=s-r1          ends the streaming turn (turn_end, idle)
 *   GET  /__mock/thread/calls                  thread.* invocations ("send <id> <text> [attachments]", ...)
 *
 * thread.send appends the user message, streams a short reply over ~1 s and ends the turn;
 * thread.interrupt ends a running turn as interrupted and withdraws pending requests.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { SessionStatus } from "../src/gen/codefoundry/v1/session_pb";
import {
  ThreadItemDelta_Field,
  ThreadRequestState,
  ToolCallStatus,
  type ThreadEventSchema,
  type ThreadItemSchema,
  type ThreadPendingRequestSchema,
} from "../src/gen/codefoundry/v1/thread_pb";
import { Hub } from "./hub";

export type ThreadEventInit = MessageInitShape<typeof ThreadEventSchema>;
type ItemInit = MessageInitShape<typeof ThreadItemSchema>;
type PendingInit = MessageInitShape<typeof ThreadPendingRequestSchema>;

/** The world the threads live in (mock/world.ts implements it). */
export interface ThreadWorld {
  /** The session's worktree; throws when the session does not exist. */
  worktreeOf(id: string): string;
  isConnected(id: string): boolean;
  setStatus(id: string, status: SessionStatus, reason: string): void;
  setModel(id: string, model: string): void;
  setPermission(id: string, permission: string): void;
}

interface Log {
  seq: number;
  items: ItemInit[];
  pending: PendingInit[];
  nextOrdinal: number;
  /** Open Watch streams: a finished turn is seen at once while one is open. */
  watchers: number;
}

/** A staged image the scripted first message refers to (a 48×32 PNG). */
export const MOCK_ATTACHMENT = "/mock/attachments/pr-badge-stale.png";
export const MOCK_ATTACHMENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAb0lEQVR42mOQt9YZVIhh1EGD1UFml+oJOGj24x3kITKcgowG2EForsF00yB2EH3SDS40YIl6cIXQYHQQCbnMf101jRCZ5RCdHTRadYw6iPYOommFOuqg0UQ96qDB6KCBqryGjoNG09Cog0YdRBsEAH1iaYqNxtrOAAAAAElFTkSuQmCC",
  "base64",
);

export type ThreadState = "permission" | "question" | "streaming" | "idle";

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
const ANSWER = `${ANSWER_HEAD}${GO_BLOCK}Tests: \`go test ./internal/store/pr/\` passes. I have not pushed.`;
const ANSWER_STREAMING = `${ANSWER_HEAD}\`\`\`go\nfunc fingerprintOf(pr PullRequest) Fingerprint {\n\treturn Fingerprint{\n\t\tCheckCount:  len(pr.Checks),\n\t\tReviewState: pr.Revi`;
/** What /__mock/thread/finish completes the streaming answer with. */
const ANSWER_REST = ANSWER.slice(ANSWER_STREAMING.length);

const EDIT_OLD = "type Fingerprint struct {\n\tCheckCount  int\n\tReviewState string\n}\n\nfunc fingerprintOf(pr PullRequest) Fingerprint {\n\treturn Fingerprint{CheckCount: len(pr.Checks), ReviewState: pr.ReviewDecision}\n}";
const EDIT_NEW =
  "type Fingerprint struct {\n\tCheckCount  int\n\tReviewState string\n\tHeadOid     string // moves on every push, force-pushes included\n}\n\nfunc fingerprintOf(pr PullRequest) Fingerprint {\n\treturn Fingerprint{\n\t\tCheckCount:  len(pr.Checks),\n\t\tReviewState: pr.ReviewDecision,\n\t\tHeadOid:     pr.HeadRefOid,\n\t}\n}";
const EDIT_PATCH = [
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
const TEST_FILE = `package pr

import "testing"

func TestFingerprintChangesOnForcePush(t *testing.T) {
	before := PullRequest{HeadRefOid: "9f3c2e1", Checks: make([]Check, 3), ReviewDecision: "APPROVED"}
	after := before
	after.HeadRefOid = "b71d0aa"

	a, b := fingerprintOf(before), fingerprintOf(after)
	if a == b {
		t.Fatalf("fingerprint unchanged after the head moved\\n\\tgot:  %+v\\n\\twant: a different fingerprint", a)
	}
}

func TestFingerprintStableWithoutChanges(t *testing.T) {
	pr := PullRequest{HeadRefOid: "9f3c2e1"}
	if fingerprintOf(pr) != fingerprintOf(pr) {
		t.Fatal("fingerprint changed without a change")
	}
}
`;
const FAIL_OUTPUT =
  "Exit code 1\n--- FAIL: TestFingerprintChangesOnForcePush (0.00s)\n    fingerprint_test.go:41: fingerprint unchanged after the head moved\n        got:  {CheckCount:3 ReviewState:APPROVED}\n        want: a different fingerprint\nFAIL\nFAIL\tgithub.com/alexwaumann/code-foundry/internal/store/pr\t0.412s";
const GREP_OUTPUT =
  'internal/store/pr/gh/query.graphql:23:      headRefOid\ninternal/store/pr/model.go:31:\tHeadRefOid     string\ninternal/store/pr/decode.go:58:\tpr.HeadRefOid = n.HeadRefOid\ninternal/store/pr/decode_test.go:72:\tHeadRefOid: "9f3c2e1",\ninternal/store/linkedpr/sync.go:104:\tif old.HeadRefOid != pr.HeadRefOid {';
const QUESTIONS = {
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

const PUSH = "git push --force-with-lease origin cf/pr-badge-stale";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class MockThreads {
  private logs = new Map<string, Log>();
  /** Every thread event, for the Watch streams. */
  private readonly hub = new Hub<{ sessionId: string; event: ThreadEventInit }>();
  /** thread.* calls, for GET /__mock/thread/calls. */
  calls: string[] = [];
  /** Bumped by reset(): a scripted reply still sleeping from before stops. */
  private generation = 0;

  /** `source` gets what the EventService thread source carries (pending events only). */
  constructor(
    private readonly world: ThreadWorld,
    private readonly source: (ev: ThreadEventInit) => void,
  ) {}

  reset(): void {
    this.logs.clear();
    this.calls = [];
    this.generation++;
  }

  has(id: string): boolean {
    return this.logs.has(id);
  }

  private log(id: string): Log {
    let l = this.logs.get(id);
    if (!l) {
      l = { seq: 0, items: [], pending: [], nextOrdinal: 1, watchers: 0 };
      this.logs.set(id, l);
    }
    return l;
  }

  private publish(id: string, event: ThreadEventInit): void {
    this.hub.publish({ sessionId: id, event });
  }

  /** ListItems' snapshot. */
  snapshotValue(id: string): { sessionId: string; seq: bigint; items: ItemInit[]; pending: PendingInit[] } {
    this.world.worktreeOf(id);
    const l = this.log(id);
    return { sessionId: id, seq: BigInt(l.seq), items: l.items, pending: l.pending };
  }

  /** The Watch's first event. */
  snapshot(id: string): ThreadEventInit {
    return { event: { case: "snapshot", value: this.snapshotValue(id) } };
  }

  /** The EventService thread source's snapshot: pending requests of threads that have any. */
  pendingSnapshot(): ThreadEventInit {
    const threads = [...this.logs.entries()].filter(([, l]) => l.pending.length > 0).map(([sessionId, l]) => ({ sessionId, seq: BigInt(l.seq), pending: l.pending }));
    return { event: { case: "pendingSnapshot", value: { threads } } };
  }

  /** ThreadService.Watch: the snapshot, then this thread's events; counts as a viewer while open. */
  async *watch(id: string, signal: AbortSignal): AsyncGenerator<ThreadEventInit> {
    this.world.worktreeOf(id);
    const l = this.log(id);
    l.watchers++;
    this.seen(id);
    try {
      const live = this.hub.subscribe(signal);
      yield this.snapshot(id);
      for await (const { sessionId, event } of live) if (sessionId === id) yield event;
    } finally {
      l.watchers--;
    }
  }

  /** A finished turn is seen while someone watches: "finished" becomes "at prompt". */
  private seen(id: string): void {
    const l = this.log(id);
    const last = l.items[l.items.length - 1];
    if (l.watchers > 0 && l.pending.length === 0 && last?.payload?.case === "turnEnd") this.world.setStatus(id, SessionStatus.IDLE, "at prompt");
  }

  private item(id: string, payload: ItemInit["payload"], over: Partial<ItemInit> & { at?: Date; until?: Date } = {}): ItemInit {
    const l = this.log(id);
    const { at, until, ...rest } = over;
    const created = at ?? new Date();
    const n = l.nextOrdinal++;
    return { id: `${id}-i${String(n)}`, ordinal: BigInt(n * 10), createdAt: timestampFromDate(created), updatedAt: timestampFromDate(until ?? created), payload, ...rest } as ItemInit;
  }

  private append(id: string, it: ItemInit): ItemInit {
    const l = this.log(id);
    l.items.push(it);
    l.seq++;
    this.publish(id, { event: { case: "appended", value: { sessionId: id, seq: BigInt(l.seq), item: it } } });
    return it;
  }

  private update(id: string, it: ItemInit): void {
    const l = this.log(id);
    const i = l.items.findIndex((x) => x.id === it.id);
    if (i < 0) return;
    l.items[i] = it;
    l.seq++;
    this.publish(id, { event: { case: "updated", value: { sessionId: id, seq: BigInt(l.seq), item: it } } });
  }

  private setPending(id: string, pending: PendingInit[]): void {
    const l = this.log(id);
    l.pending = pending;
    l.seq++;
    const value = { sessionId: id, seq: BigInt(l.seq), pending };
    this.publish(id, { event: { case: "pending", value } });
    this.source({ event: { case: "pending", value } });
  }

  /** Text appended to the streaming text item (a delta). */
  delta(id: string, text: string): void {
    const l = this.log(id);
    const it = [...l.items].reverse().find((x) => x.streaming && x.payload?.case === "assistantText");
    if (!it || it.payload?.case !== "assistantText") return;
    it.payload.value = { text: (it.payload.value.text ?? "") + text };
    l.seq++;
    this.publish(id, { event: { case: "delta", value: { sessionId: id, seq: BigInt(l.seq), itemId: it.id, ordinal: it.ordinal, field: ThreadItemDelta_Field.TEXT, text } } });
  }

  /** Ends the turn: the streaming text completes, a turn_end follows, the thread is finished (seen when watched). */
  finish(id: string, opts: { rest?: string; interrupted?: boolean } = {}): void {
    const l = this.log(id);
    const it = [...l.items].reverse().find((x) => x.streaming);
    if (it) {
      if (opts.rest) this.delta(id, opts.rest);
      this.update(id, { ...it, streaming: false, updatedAt: timestampFromDate(new Date()) });
    }
    if (l.pending.length > 0) {
      for (const p of l.pending) {
        const req = l.items.find((x) => x.id === p.itemId);
        if (req && (req.payload?.case === "permission" || req.payload?.case === "question")) {
          this.update(id, { ...req, payload: { case: req.payload.case, value: { ...req.payload.value, state: ThreadRequestState.CANCELLED, message: "interrupted" } } } as ItemInit);
        }
      }
      this.setPending(id, []);
    }
    for (const x of l.items) {
      if (x.payload?.case === "toolCall" && x.payload.value.status === ToolCallStatus.RUNNING) {
        this.update(id, { ...x, payload: { case: "toolCall", value: { ...x.payload.value, status: ToolCallStatus.ERROR, isError: true, output: "Interrupted" } } } as ItemInit);
      }
    }
    const lastUser = [...l.items].reverse().find((x) => x.payload?.case === "userMessage");
    const started = lastUser?.createdAt ? Number(lastUser.createdAt.seconds) * 1000 : Date.now();
    const prevCost = [...l.items].reverse().find((x) => x.payload?.case === "turnEnd");
    const cost = (prevCost?.payload?.case === "turnEnd" ? (prevCost.payload.value.costUsd ?? 0) : 0) + 0.04;
    this.append(
      id,
      this.item(id, {
        case: "turnEnd",
        value: opts.interrupted
          ? { subtype: "error_during_execution", isError: true, interrupted: true, terminalReason: "aborted_streaming", durationMs: BigInt(Date.now() - started), costUsd: cost }
          : { subtype: "success", durationMs: BigInt(Date.now() - started), numTurns: 3, costUsd: cost, stopReason: "end_turn" },
      }),
    );
    this.world.setStatus(id, l.watchers > 0 ? SessionStatus.IDLE : SessionStatus.NEEDS_ATTENTION, l.watchers > 0 ? "at prompt" : "finished");
  }

  /** (Re)builds the scripted conversation in `state` (the sketch's three states, or idle: both turns done). */
  load(id: string, state: ThreadState): void {
    this.logs.delete(id);
    const l = this.log(id);
    const ago = (min: number, sec = 0) => new Date(Date.now() - min * 60_000 + sec * 1000);
    const it = (payload: ItemInit["payload"], over: Partial<ItemInit> & { at?: Date; until?: Date } = {}) => {
      const x = this.item(id, payload, over);
      l.items.push(x);
      return x;
    };
    const tool = (name: string, input: object, value: { output?: string; isError?: boolean; resultJson?: string; status?: ToolCallStatus }, over: Partial<ItemInit> & { at?: Date; until?: Date } = {}) => {
      const toolUseId = `toolu_${name.toLowerCase()}_${String(l.nextOrdinal)}`;
      return it({ case: "toolCall", value: { toolUseId, name, inputJson: JSON.stringify(input), status: ToolCallStatus.DONE, ...value } }, over);
    };
    const cwd = this.world.worktreeOf(id);
    const p = (rel: string) => `${cwd}/${rel}`;
    const text = (t: string, over: Partial<ItemInit> & { at?: Date } = {}) => it({ case: "assistantText", value: { text: t } }, over);
    const read = (rel: string, lines: number, at: Date, parent = "") =>
      tool("Read", { file_path: p(rel) }, { output: `     1\tpackage pr\n`, resultJson: JSON.stringify({ type: "text", file: { filePath: p(rel), content: "package pr\n\n// …\n", numLines: lines, startLine: 1, totalLines: lines } }) }, { at, parentToolUseId: parent });

    // Turn 1.
    it(
      {
        case: "userMessage",
        value: {
          text: `The PR badge in the sidebar stays green after a force-push, see [Image: pr-badge-stale.png; ref=${MOCK_ATTACHMENT}] Look at @cf-file://repo-cf/internal/store/pr/poller.go and fix it with /tdd . Keep the fingerprint check-count based in /tmp.`,
          attachments: [MOCK_ATTACHMENT],
          composerText:
            "The PR badge in the sidebar stays green after a force-push, see ![pr-badge-stale.png](cf-attachment://0) Look at [poller.go](cf-file://repo-cf/internal/store/pr/poller.go) and fix it with [/tdd](cf-skill://~/tdd). Keep the fingerprint check-count based in /tmp.",
        },
      },
      { at: ago(9) },
    );
    it({ case: "thinking", value: { text: "The badge reads the poller's fingerprint. If a force-push keeps the check count, nothing changes…" } }, { at: ago(9, 1), until: ago(9, 10) });
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
    const ask = tool(
      "AskUserQuestion",
      { questions: [{ question: "How should the poller notice a force-push?", header: "Fix approach", multiSelect: false, options: [{ label: "Head SHA in the fingerprint", description: "" }, { label: "Poll the PR's events", description: "" }] }] },
      {},
      { at: ago(8, 0) },
    );
    const askCall = ask.payload?.case === "toolCall" ? ask.payload.value : undefined;
    it(
      {
        case: "question",
        value: {
          requestId: "req-approach",
          toolName: "AskUserQuestion",
          toolUseId: askCall?.toolUseId ?? "",
          inputJson: askCall?.inputJson ?? "",
          state: ThreadRequestState.ALLOWED,
          decision: "allow",
          answers: { "How should the poller notice a force-push?": "Head SHA in the fingerprint" },
        },
      },
      { at: ago(8, 1) },
    );
    tool(
      "Write",
      { file_path: p("internal/store/pr/fingerprint_test.go"), content: TEST_FILE },
      { output: `File created successfully at: ${p("internal/store/pr/fingerprint_test.go")}`, resultJson: JSON.stringify({ type: "create", filePath: p("internal/store/pr/fingerprint_test.go"), content: TEST_FILE, structuredPatch: [] }) },
      { at: ago(7, 30) },
    );
    tool("Bash", { command: "go test ./internal/store/pr/ -run TestFingerprint", description: "Run the new test" }, { status: ToolCallStatus.ERROR, isError: true, output: FAIL_OUTPUT }, { at: ago(7, 40), until: ago(7, 40.9) });
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
    const agentId = agent.payload?.case === "toolCall" ? (agent.payload.value.toolUseId ?? "") : "";
    read("internal/store/pr/fingerprint.go", 91, ago(6, 45), agentId);
    read("internal/store/pr/poller.go", 212, ago(6, 46), agentId);
    tool("Grep", { pattern: "fingerprintOf(", path: p("internal/") }, { output: "internal/store/pr/poller.go:88:\tfp := fingerprintOf(pr)", resultJson: JSON.stringify({ mode: "content", numLines: 3, numFiles: 2 }) }, { at: ago(6, 50), parentToolUseId: agentId });
    tool("Bash", { command: "go vet ./internal/store/pr/..." }, { output: "" }, { at: ago(7, 0), parentToolUseId: agentId });
    if (state === "streaming") {
      text(ANSWER_STREAMING, { at: ago(5, 30), streaming: true });
      l.seq = l.items.length;
      this.world.setStatus(id, SessionStatus.BUSY, "working");
      return;
    }
    text(ANSWER, { at: ago(5, 30) });
    it({ case: "turnEnd", value: { subtype: "success", durationMs: 248_000n, numTurns: 22, costUsd: 1.12, stopReason: "end_turn", inputTokens: 48_200n, outputTokens: 6_100n } }, { at: ago(4, 52) });

    // Turn 2.
    it({ case: "userMessage", value: { text: "Looks good. Run the full suite, then push the branch.", attachments: [] } }, { at: ago(4) });
    tool("Bash", { command: "go test ./..." }, { output: "ok  \tgithub.com/alexwaumann/code-foundry/...\t(412 tests)", resultJson: JSON.stringify({ stdout: "ok  \t…/internal/store/pr\t0.41s\nok  \t…/internal/api\t3.2s\n(412 tests passed)", stderr: "" }) }, { at: ago(3, 12), until: ago(3, 50) });
    if (state === "idle") {
      text("All 412 tests pass and the branch is pushed: PR #63 picked up the fix.", { at: ago(2) });
      it({ case: "turnEnd", value: { subtype: "success", durationMs: 62_000n, numTurns: 4, costUsd: 1.31, stopReason: "end_turn" } }, { at: ago(1, 58) });
      l.seq = l.items.length;
      this.world.setStatus(id, SessionStatus.IDLE, "at prompt");
      return;
    }
    if (state === "question") {
      text("All 412 tests pass. Two things to settle before I push.", { at: ago(3) });
      const q = tool("AskUserQuestion", QUESTIONS, { status: ToolCallStatus.RUNNING }, { at: ago(2, 58) });
      const qCall = q.payload?.case === "toolCall" ? q.payload.value : undefined;
      const item = it({ case: "question", value: { requestId: "req-push-q", toolName: "AskUserQuestion", toolUseId: qCall?.toolUseId ?? "", inputJson: JSON.stringify(QUESTIONS), state: ThreadRequestState.PENDING } }, { at: ago(2, 57) });
      l.pending = [{ requestId: "req-push-q", itemId: item.id, question: true, toolName: "AskUserQuestion", summary: QUESTIONS.questions[0]?.question ?? "" }];
      l.seq = l.items.length;
      this.world.setStatus(id, SessionStatus.NEEDS_ATTENTION, `question: ${QUESTIONS.questions[0]?.question ?? ""}`);
      this.source({ event: { case: "pending", value: { sessionId: id, seq: BigInt(l.seq), pending: l.pending } } });
      return;
    }
    text("All 412 tests pass. The branch was rebased onto `main` earlier, so this needs a force-push.", { at: ago(3) });
    const push = tool("Bash", { command: PUSH, description: "Force-push the rebased branch so PR #63 picks up the fix." }, { status: ToolCallStatus.RUNNING }, { at: ago(2, 58), streaming: false });
    const pushCall = push.payload?.case === "toolCall" ? push.payload.value : undefined;
    const perm = it(
      {
        case: "permission",
        value: {
          requestId: "req-push",
          toolName: "Bash",
          displayName: "Bash",
          toolUseId: pushCall?.toolUseId ?? "",
          inputJson: pushCall?.inputJson ?? "",
          description: "Force-push the rebased branch so PR #63 picks up the fix.",
          decisionReason: "Accept edits asks before commands",
          suggestionsJson: JSON.stringify([{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git push:*" }], behavior: "allow", destination: "session" }]),
          state: ThreadRequestState.PENDING,
        },
      },
      { at: ago(2, 57) },
    );
    l.pending = [{ requestId: "req-push", itemId: perm.id, question: false, toolName: "Bash", summary: `Bash ${PUSH}` }];
    l.seq = l.items.length;
    this.world.setStatus(id, SessionStatus.NEEDS_ATTENTION, `permission: Bash ${PUSH}`);
    this.source({ event: { case: "pending", value: { sessionId: id, seq: BigInt(l.seq), pending: l.pending } } });
  }

  /** thread.send: the user message, then a short streamed reply and the turn's end. */
  send(id: string, text: string, attachments: string[], composerText = ""): ItemInit {
    if (!this.world.isConnected(id)) throw new Error(`thread ${id} is not connected; reconnect it first`);
    const msg = this.append(id, this.item(id, { case: "userMessage", value: { text, attachments, composerText } }));
    this.world.setStatus(id, SessionStatus.BUSY, "working");
    const gen = this.generation;
    void (async () => {
      await sleep(250);
      if (gen !== this.generation) return;
      this.append(id, this.item(id, { case: "thinking", value: { text: "" } }));
      await sleep(250);
      if (gen !== this.generation) return;
      this.append(id, this.item(id, { case: "assistantText", value: { text: "" } }, { streaming: true }));
      for (const part of ["Got it", ": I'll ", "take a look", " now."]) {
        await sleep(120);
        if (gen !== this.generation) return;
        this.delta(id, part);
      }
      await sleep(150);
      if (gen !== this.generation || !this.log(id).items.some((x) => x.streaming)) return;
      this.finish(id);
    })();
    return msg;
  }

  /** The thread.* commands (mock/world.ts registry): the GUI passes the thread as `id`. */
  commands(): {
    cmd: { name: string; title: string; category: string; description: string; keybindings: string[]; args: { name: string; type: ArgType; required: boolean; description: string; enumValues?: string[] }[] };
    when: (ctx: UiContext | undefined) => boolean;
    run: (ctx: UiContext | undefined, args: Record<string, string>) => string;
  }[] {
    const when = (ctx: UiContext | undefined) => Boolean(ctx?.activeSessionId && (ctx.activeSessionRendered || ctx.activeView === ""));
    const id = { name: "id", type: ArgType.STRING, required: true, description: "Thread id" };
    return [
      {
        cmd: { name: "thread.send", title: "Send to Thread", category: "Thread", description: "Send a message to a rendered thread", keybindings: [], args: [id, { name: "text", type: ArgType.STRING, required: true, description: "The message" }, { name: "attachments", type: ArgType.STRING, required: false, description: "Comma-separated image paths" }, { name: "composer-text", type: ArgType.STRING, required: false, description: "The composer's text with its tag tokens" }] },
        when,
        run: (_ctx, a) => {
          const atts = (a.attachments ?? "").split(",").filter(Boolean);
          this.calls.push(`send ${a.id ?? ""} ${a.text ?? ""}${atts.length > 0 ? ` [${atts.join(",")}]` : ""}`);
          this.send(a.id ?? "", a.text ?? "", atts, a["composer-text"] ?? "");
          return `sent to thread ${a.id ?? ""}`;
        },
      },
      {
        cmd: { name: "thread.interrupt", title: "Interrupt Thread", category: "Thread", description: "Stop a rendered thread's running turn", keybindings: [], args: [id] },
        when,
        run: (_ctx, a) => {
          this.calls.push(`interrupt ${a.id ?? ""}`);
          this.generation++;
          this.finish(a.id ?? "", { interrupted: true });
          return `interrupted thread ${a.id ?? ""}`;
        },
      },
      {
        cmd: { name: "thread.respond", title: "Answer Thread Request", category: "Thread", description: "Answer a pending permission request or question", keybindings: [], args: [id, { name: "decision", type: ArgType.ENUM, required: false, description: "allow, allow-session or deny", enumValues: ["allow", "allow-session", "deny"] }] },
        when,
        run: (_ctx, a) => {
          this.calls.push(`respond ${a.id ?? ""} ${a.decision ?? "allow"}`);
          return "answered";
        },
      },
      {
        cmd: { name: "thread.set-model", title: "Set Thread Model", category: "Thread", description: "Switch a rendered thread's model", keybindings: [], args: [id, { name: "model", type: ArgType.STRING, required: true, description: "Model" }] },
        when,
        run: (_ctx, a) => {
          this.calls.push(`set-model ${a.id ?? ""} ${a.model ?? ""}`);
          this.world.setModel(a.id ?? "", a.model ?? "");
          return `thread uses ${a.model ?? ""}`;
        },
      },
      {
        cmd: { name: "thread.set-mode", title: "Set Thread Permissions", category: "Thread", description: "Switch a rendered thread's permission mode", keybindings: [], args: [id, { name: "permission", type: ArgType.ENUM, required: true, description: "supervised, accept-edits or auto", enumValues: ["supervised", "accept-edits", "auto"] }] },
        when,
        run: (_ctx, a) => {
          this.calls.push(`set-mode ${a.id ?? ""} ${a.permission ?? ""}`);
          this.world.setPermission(a.id ?? "", a.permission ?? "");
          return `thread runs ${a.permission ?? ""}`;
        },
      },
    ];
  }

  /** Text for the streaming answer's remainder (finish). */
  static readonly answerRest = ANSWER_REST;
}
