/**
 * Threads in the mock daemon (docs/notes/rendered-threads-2-gui.md): one scripted
 * conversation, the sketch's "Fix stale PR badge" (docs/sketches/rendered-thread), in the
 * states the sketch shows, a short history for each default-world thread (seed), plus
 * ThreadService.Watch / Send / Interrupt and the EventService `thread` source (pending
 * requests only, like the daemon since PR 1's review).
 *
 *   POST /__mock/thread?state=permission|question|streaming|idle|parallel|multi[&id=s-r1]
 *        (re)creates the scripted thread in that state; returns { id }. parallel: an Edit
 *        and a Bash permission pending at once (oldest first); multi: a multi-select question
 *   POST /__mock/thread/delta?id=s-r1&text=…   appends text to the streaming answer
 *   POST /__mock/thread/stream?id=s-r1&text=…  starts a new streaming text item
 *   POST /__mock/thread/finish?id=s-r1          ends the streaming turn (turn_end, idle)
 *   GET  /__mock/thread/calls                  thread.* invocations ("send <id> <text> [attachments]", ...)
 *   POST /__mock/thread/cache?id=s-r1&ago=<s>  the last result <s> seconds ago (mock/context.ts)
 *   POST /__mock/thread/commands?id=s-r1&set=none|more|default   replaces the slash commands
 *        (mock/slashCommands.ts) and publishes the Watch's `commands` event
 *
 * thread.send appends the user message, streams a short reply over ~1 s and ends the turn;
 * thread.interrupt ends a running turn as interrupted and withdraws pending requests.
 * thread.respond (and ThreadService.Respond) resolves a request like the daemon: once
 * nothing is pending, an allowed tool runs and Claude carries on, a denied one makes Claude
 * reply to the reason, answers are echoed; then the turn ends. thread.set-effort applies at
 * once when idle ("Set effort to …" after ~300 ms), else when the turn ends
 * (Session.effort_pending meanwhile).
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { SessionStatus } from "../src/gen/codefoundry/v1/session_pb";
import {
  ThreadAgentStatus,
  ThreadItemDelta_Field,
  ThreadRequestState,
  ToolCallStatus,
  type ThreadEventSchema,
  type ThreadItemSchema,
  type ThreadPendingRequestSchema,
} from "../src/gen/codefoundry/v1/thread_pb";
import { END_REPORTS, scriptAgents, type AgentRunInit } from "./agents";
import { CommandError } from "./errors";
import { Hub } from "./hub";
import { mcpFixture, type McpStatusInit } from "./mcp";
import { refuseSlashCommand, slashCommandsFixture, type SlashCommandInit } from "./slashCommands";
import { scriptShells, shellSummary, type ShellCall } from "./shells";

export type ThreadEventInit = MessageInitShape<typeof ThreadEventSchema>;
type ItemInit = MessageInitShape<typeof ThreadItemSchema>;
type PendingInit = MessageInitShape<typeof ThreadPendingRequestSchema>;

/**
 * A default-world thread's history (MockThreads.seed): the prompt, Claude's first words
 * and one Bash call, then by `end`: a finished turn ("done"), a reply still streaming
 * ("working"), the next Bash call waiting for permission ("permission"), or nothing more
 * ("cut": the process ended mid-turn).
 */
export interface SeedHistory {
  prompt: string;
  intro: string;
  command: string;
  output: string;
  /** "done": the closing reply; "working": the streaming start of it; "permission": the command that waits. */
  reply: string;
  minutesAgo: number;
  end: "done" | "working" | "permission" | "cut";
}

/** The world the threads live in (mock/world.ts implements it). */
export interface ThreadWorld {
  /** The session's worktree; throws when the session does not exist. */
  worktreeOf(id: string): string;
  isConnected(id: string): boolean;
  setStatus(id: string, status: SessionStatus, reason: string): void;
  setModel(id: string, model: string): void;
  setPermission(id: string, permission: string): void;
  setEffort(id: string, effort: string, pending: boolean): void;
  statusOf(id: string): SessionStatus;
  /** The thread's model as picked ("claude-opus-4-8[1m]"). */
  modelOf(id: string): string;
  /** A turn ended: the thread's context totals move to now (mock/context.ts). */
  recordResult(id: string, model: string): void;
  /** The thread's subagent runs changed: its session's running counts follow (mock/agents.ts). */
  agentsChanged(id: string): void;
}

/** What Claude reports as the model of a reply for a picked one (a family alias resolves to its current model). */
const CANONICAL: Readonly<Record<string, string>> = { fable: "claude-fable-5-1", opus: "claude-opus-4-8", sonnet: "claude-sonnet-5", haiku: "claude-haiku-5-5" };

interface Log {
  seq: number;
  items: ItemInit[];
  pending: PendingInit[];
  nextOrdinal: number;
  /** Open Watch streams: a finished turn is seen at once while one is open. */
  watchers: number;
  /** thread.set-effort while on a turn: applied when it ends. */
  pendingEffort: string;
}

/** A staged image the scripted first message refers to (a 48×32 PNG). */
export const MOCK_ATTACHMENT = "/mock/attachments/pr-badge-stale.png";
export const MOCK_ATTACHMENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAb0lEQVR42mOQt9YZVIhh1EGD1UFml+oJOGj24x3kITKcgowG2EForsF00yB2EH3SDS40YIl6cIXQYHQQCbnMf101jRCZ5RCdHTRadYw6iPYOommFOuqg0UQ96qDB6KCBqryGjoNG09Cog0YdRBsEAH1iaYqNxtrOAAAAAElFTkSuQmCC",
  "base64",
);

/**
 * The scripted conversation's states. closed: idle's conversation, the thread
 * disconnected (closed); crashed: Claude exited before answering the handshake (an error
 * item, nothing else; mock/world.ts disconnects the thread).
 */
export type ThreadState = "permission" | "question" | "streaming" | "idle" | "parallel" | "multi" | "subagent" | "agents" | "shells" | "closed" | "crashed";
export const THREAD_STATES: readonly ThreadState[] = ["permission", "question", "streaming", "idle", "parallel", "multi", "subagent", "agents", "shells", "closed", "crashed"];

/** The stderr line of the "crashed" state's claude (Session.last_error). */
export const CRASH_STDERR = "error: unknown option '--bogus'";

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

const MULTI = {
  questions: [
    {
      question: "Which checks should I run before pushing?",
      header: "Checks",
      multiSelect: true,
      options: [
        { label: "go test ./...", description: "The whole suite (about 40 s)" },
        { label: "go vet ./...", description: "" },
        { label: "staticcheck", description: "Lint, as CI does" },
      ],
    },
  ],
};

const PUSH = "git push --force-with-lease origin cf/pr-badge-stale";
const POLLER_OLD = "\tif fp == prev {\n\t\treturn\n\t}";
const POLLER_NEW = "\tif fp == prev && !force {\n\t\treturn\n\t}";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class MockThreads {
  private logs = new Map<string, Log>();
  /** MCP status per thread (mock/mcp.ts); absent: none (not running). */
  private mcp = new Map<string, McpStatusInit>();
  /** Slash commands per running thread (mock/slashCommands.ts); absent: none. */
  private slash = new Map<string, SlashCommandInit[]>();
  /** Subagent runs per thread in spawn order (mock/agents.ts); absent: none. */
  private agents = new Map<string, AgentRunInit[]>();
  /** Running background shells per thread, oldest first (mock/shells.ts); absent: none. */
  private shells = new Map<string, ShellCall[]>();
  /** Every thread event, for the Watch streams. */
  private readonly hub = new Hub<{ sessionId: string; event: ThreadEventInit }>();
  /** thread.* calls, for GET /__mock/thread/calls. */
  calls: string[] = [];
  /** Bumped by reset(): a scripted reply still sleeping from before stops. */
  private generation = 0;
  /**
   * POST /__mock/thread/fail-respond: the next thread.respond fails (the prompt must come
   * back); with ?withdrawn=1 Claude withdrew the request first (NotFound, like the daemon).
   */
  failRespond: "" | "error" | "withdrawn" = "";

  /** `source` gets what the EventService thread source carries (pending events only). */
  constructor(
    private readonly world: ThreadWorld,
    private readonly source: (ev: ThreadEventInit) => void,
  ) {}

  reset(): void {
    this.logs.clear();
    this.mcp.clear();
    this.slash.clear();
    this.agents.clear();
    this.shells.clear();
    this.calls = [];
    this.failRespond = "";
    this.generation++;
  }

  has(id: string): boolean {
    return this.logs.has(id);
  }

  private log(id: string): Log {
    let l = this.logs.get(id);
    if (!l) {
      l = { seq: 0, items: [], pending: [], nextOrdinal: 1, watchers: 0, pendingEffort: "" };
      this.logs.set(id, l);
    }
    return l;
  }

  private publish(id: string, event: ThreadEventInit): void {
    this.hub.publish({ sessionId: id, event });
  }

  /** ListItems' snapshot. */
  snapshotValue(id: string): { sessionId: string; seq: bigint; items: ItemInit[]; pending: PendingInit[]; mcp?: McpStatusInit; commands: SlashCommandInit[]; agents: AgentRunInit[] } {
    this.world.worktreeOf(id);
    const l = this.log(id);
    return { sessionId: id, seq: BigInt(l.seq), items: l.items, pending: l.pending, mcp: this.mcp.get(id), commands: this.slash.get(id) ?? [], agents: this.agents.get(id) ?? [] };
  }

  /** The thread's subagent runs in spawn order ([] for none). Throws for an unknown thread. */
  agentsOf(id: string): AgentRunInit[] {
    this.world.worktreeOf(id);
    return this.agents.get(id) ?? [];
  }

  /** The runs of a thread for its Session's counts (no check: the session may be going away). */
  agentRunsOf(id: string): readonly AgentRunInit[] {
    return this.agents.get(id) ?? [];
  }

  /** The thread's running background shells, for its Session's count. */
  shellsOf(id: string): number {
    return this.shells.get(id)?.length ?? 0;
  }

  /**
   * POST /__mock/thread/shell-end: the oldest running shell ends like the daemon ends it:
   * its call finishes with Claude's summary (an error when failed), the count is published.
   */
  endShell(id: string, failed: boolean): void {
    this.world.worktreeOf(id);
    const running = this.shells.get(id) ?? [];
    const shell = running[0];
    if (!shell) throw new CommandError("invalid", `thread ${id} has no background shell running`);
    const call = this.log(id).items.find((x) => x.id === shell.toolUseId);
    if (call?.payload?.case === "toolCall") {
      this.update(id, {
        ...call,
        updatedAt: timestampFromDate(new Date()),
        payload: { case: "toolCall", value: { ...call.payload.value, status: failed ? ToolCallStatus.ERROR : ToolCallStatus.DONE, isError: failed, output: shellSummary(shell, failed) } },
      } as ItemInit);
    }
    if (running.length > 1) this.shells.set(id, running.slice(1));
    else this.shells.delete(id);
    this.world.agentsChanged(id);
  }

  /** Replaces the thread's runs, publishes the Watch's `agents` event (the whole list) and the session's counts. */
  setAgents(id: string, runs: AgentRunInit[]): void {
    if (runs.length > 0) this.agents.set(id, runs);
    else this.agents.delete(id);
    const l = this.log(id);
    l.seq++;
    this.publish(id, { event: { case: "agents", value: { sessionId: id, seq: BigInt(l.seq), agents: runs } } });
    this.world.agentsChanged(id);
  }

  /**
   * POST /__mock/thread/agent-end: a running run ends like the daemon ends it. Its Agent
   * call's item finishes with the report (or fails with the error), a background run's
   * end adds the "Agent finished · …" note, then the list and the counts are published.
   */
  endAgent(id: string, runId: string, failed: boolean): void {
    const runs = this.agentsOf(id);
    const run = runs.find((r) => r.id === runId);
    if (!run) throw new CommandError("notfound", `thread ${id} has no agent run ${runId}`);
    if (run.status !== ThreadAgentStatus.RUNNING) throw new CommandError("invalid", `agent run ${runId} is not running`);
    const now = new Date();
    const report = END_REPORTS[runId] ?? "Done.";
    const error = "Stopped: the agent was killed";
    const started = run.resumedAt ?? run.startedAt;
    const ended: AgentRunInit = {
      ...run,
      status: failed ? ThreadAgentStatus.FAILED : ThreadAgentStatus.DONE,
      summary: failed ? "" : report,
      error: failed ? error : "",
      endedAt: timestampFromDate(now),
      durationMs: started ? BigInt(now.getTime() - Number(started.seconds ?? 0n) * 1000) : (run.durationMs ?? 0n),
    };
    const call = this.log(id).items.find((x) => x.id === run.toolUseId);
    if (call?.payload?.case === "toolCall") {
      const out = failed ? error : report;
      this.update(id, {
        ...call,
        updatedAt: timestampFromDate(now),
        payload: { case: "toolCall", value: { ...call.payload.value, status: failed ? ToolCallStatus.ERROR : ToolCallStatus.DONE, isError: failed, output: out, resultJson: "" } },
      } as ItemInit);
    }
    if (run.background) {
      const note = this.append(id, this.item(id, { case: "note", value: { text: failed ? `Agent failed · ${run.description ?? ""} · ${error}` : `Agent finished · ${run.description ?? ""} · ${report}` } }));
      ended.noteItemId = note.id ?? "";
    }
    this.setAgents(
      id,
      runs.map((r) => (r.id === runId ? ended : r)),
    );
  }

  /** ThreadService.SlashCommands: the running thread's list ([] when none). Throws for an unknown thread. */
  slashCommandsOf(id: string): SlashCommandInit[] {
    this.world.worktreeOf(id);
    return this.slash.get(id) ?? [];
  }

  /** Replaces the thread's slash commands and publishes the Watch's `commands` event (the whole list; [] the process ended). */
  setSlashCommands(id: string, commands: SlashCommandInit[]): void {
    this.world.worktreeOf(id);
    if (commands.length > 0) this.slash.set(id, commands);
    else this.slash.delete(id);
    const l = this.log(id);
    l.seq++;
    this.publish(id, { event: { case: "commands", value: { sessionId: id, seq: BigInt(l.seq), commands } } });
  }

  /** The thread's MCP status (mock/mcp.ts); undefined when it has none. Throws for an unknown thread. */
  mcpOf(id: string): McpStatusInit | undefined {
    this.world.worktreeOf(id);
    return this.mcp.get(id);
  }

  /** Replaces the thread's MCP status and publishes the Watch's `mcp` event. */
  setMcp(id: string, status: McpStatusInit | undefined): void {
    if (status) this.mcp.set(id, status);
    else this.mcp.delete(id);
    const l = this.log(id);
    l.seq++;
    this.publish(id, { event: { case: "mcp", value: { sessionId: id, seq: BigInt(l.seq), status } } });
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

  /** A new streaming text item (e.g. a subagent's reply arriving while a prompt waits); /delta extends it. */
  stream(id: string, text: string): void {
    this.append(id, this.item(id, { case: "assistantText", value: { text } }, { streaming: true }));
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
  /**
   * Ends the running turn like the daemon: the turn_end carries Claude's running total
   * (the previous one + 0.04, or `total`), the turn's own cost (0.04, or `turnCost`: a
   * restart can make it differ from the totals' difference) and the model that replied.
   */
  finish(id: string, opts: { rest?: string; interrupted?: boolean; total?: number; turnCost?: number; model?: string } = {}): void {
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
    // A background Agent call stays running until its run ends (mock/agents.ts endAgent); so do its run's calls.
    const runs = this.agents.get(id) ?? [];
    const live = new Set(runs.filter((r) => r.status === ThreadAgentStatus.RUNNING).map((r) => r.toolUseId ?? ""));
    for (const x of l.items) {
      if (x.payload?.case === "toolCall" && x.payload.value.status === ToolCallStatus.RUNNING && !live.has(x.id ?? "") && !live.has(x.parentToolUseId ?? "")) {
        this.update(id, { ...x, payload: { case: "toolCall", value: { ...x.payload.value, status: ToolCallStatus.ERROR, isError: true, output: "Interrupted" } } } as ItemInit);
      }
    }
    const lastUser = [...l.items].reverse().find((x) => x.payload?.case === "userMessage");
    const started = lastUser?.createdAt ? Number(lastUser.createdAt.seconds) * 1000 : Date.now();
    const prevCost = [...l.items].reverse().find((x) => x.payload?.case === "turnEnd");
    const cost = opts.total ?? (prevCost?.payload?.case === "turnEnd" ? (prevCost.payload.value.costUsd ?? 0) : 0) + 0.04;
    const turnCostUsd = opts.turnCost ?? 0.04;
    const picked = this.world.modelOf(id);
    const model = opts.model ?? CANONICAL[picked] ?? picked;
    this.append(
      id,
      this.item(id, {
        case: "turnEnd",
        value: opts.interrupted
          ? { subtype: "error_during_execution", isError: true, interrupted: true, terminalReason: "aborted_streaming", durationMs: BigInt(Date.now() - started), costUsd: cost, turnCostUsd, model }
          : { subtype: "success", durationMs: BigInt(Date.now() - started), numTurns: 3, costUsd: cost, turnCostUsd, model, stopReason: "end_turn" },
      }),
    );
    this.world.recordResult(id, model);
    this.world.setStatus(id, l.watchers > 0 ? SessionStatus.IDLE : SessionStatus.NEEDS_ATTENTION, l.watchers > 0 ? "at prompt" : "finished");
    if (l.pendingEffort) {
      const effort = l.pendingEffort;
      l.pendingEffort = "";
      this.applyEffort(id, effort);
    }
  }

  /** Claude withdraws a pending request (control_cancel_request): the item says so, the prompt leaves. */
  private withdraw(id: string, requestId: string): void {
    const l = this.log(id);
    const p = l.pending.find((x) => x.requestId === requestId);
    const req = p && l.items.find((x) => x.id === p.itemId);
    if (!p || (req?.payload?.case !== "permission" && req?.payload?.case !== "question")) return;
    this.update(id, { ...req, payload: { case: req.payload.case, value: { ...req.payload.value, state: ThreadRequestState.CANCELLED, message: "withdrawn by Claude" } } } as ItemInit);
    this.setPending(id, l.pending.filter((x) => x !== p));
  }

  /** The restart with the new effort is done: the timeline says so, the flag clears. */
  private applyEffort(id: string, effort: string): void {
    this.append(id, this.item(id, { case: "commandOutput", value: { text: `Set effort to ${effort}` } }));
    this.world.setEffort(id, effort, false);
  }

  /** thread.set-effort: at once when idle (after a short "restart"), else when the turn ends. */
  setEffort(id: string, effort: string): boolean {
    if (!this.world.isConnected(id)) throw new Error(`thread ${id} is not connected; reconnect it first`);
    const l = this.log(id);
    const status = this.world.statusOf(id);
    const onTurn = status === SessionStatus.BUSY || l.pending.length > 0;
    this.world.setEffort(id, effort, true);
    if (onTurn) {
      l.pendingEffort = effort;
      return true;
    }
    const gen = this.generation;
    setTimeout(() => {
      if (gen === this.generation) this.applyEffort(id, effort);
    }, 300);
    return false;
  }

  /**
   * ThreadService.Respond / thread.respond: resolves the request (the oldest pending one when
   * requestId is empty). Once nothing is pending, the turn carries on: an allowed tool
   * finishes, Claude streams a short reply to what was decided, and the turn ends.
   */
  respond(id: string, requestId: string, decision: "allow" | "allow-session" | "deny", answers: Record<string, string>, message: string): ItemInit {
    const l = this.log(id);
    const p = requestId ? l.pending.find((x) => x.requestId === requestId) : l.pending[0];
    if (!p) throw new CommandError("notfound", requestId ? `no pending request ${requestId} on thread ${id}` : `thread ${id} has no pending request`);
    const req = l.items.find((x) => x.id === p.itemId);
    if (req?.payload?.case !== "permission" && req?.payload?.case !== "question") throw new Error(`request ${p.requestId ?? ""} has no item`);
    const r = req.payload.value;
    const isQuestion = req.payload.case === "question";
    const deny = decision === "deny";
    if (isQuestion && !deny) {
      const qs = (JSON.parse(r.inputJson ?? "{}") as { questions?: { question: string }[] }).questions ?? [];
      const missing = qs.find((q) => !(answers[q.question] ?? "").trim());
      if (missing) throw new Error(`no answer for question "${missing.question}"`);
    }
    const resolved = {
      ...req,
      updatedAt: timestampFromDate(new Date()),
      payload: {
        case: req.payload.case,
        value: {
          ...r,
          state: deny ? ThreadRequestState.DENIED : ThreadRequestState.ALLOWED,
          decision: deny ? "deny" : decision === "allow-session" ? "allow_session" : "allow",
          message: deny ? message : "",
          answers: isQuestion && !deny ? answers : {},
        },
      },
    } as ItemInit;
    this.update(id, resolved);
    const tool = l.items.find((x) => x.payload?.case === "toolCall" && x.payload.value.toolUseId === r.toolUseId);
    if (tool?.payload?.case === "toolCall") {
      const output = deny
        ? message || "The user doesn't want to proceed with this tool use."
        : isQuestion
          ? Object.entries(answers)
              .map(([q, a]) => `"${q}"="${a}"`)
              .join(", ")
          : r.toolName === "Bash"
            ? "To github.com:alexwaumann/code-foundry.git\n + 9f3c2e1...b71d0aa cf/pr-badge-stale -> cf/pr-badge-stale (forced update)"
            : "The file has been updated.";
      this.update(id, { ...tool, updatedAt: timestampFromDate(new Date()), payload: { case: "toolCall", value: { ...tool.payload.value, status: deny ? ToolCallStatus.ERROR : ToolCallStatus.DONE, isError: deny, output } } } as ItemInit);
    }
    const rest = l.pending.filter((x) => x.requestId !== p.requestId);
    this.setPending(id, rest);
    const next = rest[0];
    if (next) {
      this.world.setStatus(id, SessionStatus.NEEDS_ATTENTION, `${next.question ? "question" : "permission"}: ${next.summary ?? ""}`);
      return resolved;
    }
    this.world.setStatus(id, SessionStatus.BUSY, "working");
    const reply = isQuestion
      ? deny
        ? "No problem, I'll leave those for later."
        : `Thanks: ${Object.values(answers).join("; ")}.`
      : deny
        ? message
          ? `Understood, I won't run that. You said: ${message}`
          : "Understood, I stopped there. Tell me how you'd like to proceed."
        : r.toolName === "Bash"
          ? "Pushed. PR #63 now has the fix."
          : `Done: ${r.toolName ?? "the tool"} ran.`;
    const gen = this.generation;
    void (async () => {
      await sleep(200);
      if (gen !== this.generation) return;
      this.append(id, this.item(id, { case: "assistantText", value: { text: "" } }, { streaming: true }));
      for (const part of reply.match(/.{1,12}/gs) ?? []) {
        await sleep(40);
        if (gen !== this.generation) return;
        this.delta(id, part);
      }
      await sleep(80);
      if (gen !== this.generation || !this.log(id).items.some((x) => x.streaming)) return;
      this.finish(id);
    })();
    return resolved;
  }

  /** (Re)builds the scripted conversation in `state` (the sketch's three states, or idle: both turns done). */
  load(id: string, loaded: ThreadState): void {
    // A scripted reply still running for the previous conversation stops.
    this.generation++;
    this.logs.delete(id);
    this.agents.delete(id);
    this.shells.delete(id);
    // A running thread was checked at the start of its last turn; a closed or crashed one has none.
    if (loaded === "closed" || loaded === "crashed") {
      this.mcp.delete(id);
      this.slash.delete(id);
    } else {
      this.mcp.set(id, mcpFixture());
      this.slash.set(id, slashCommandsFixture());
    }
    const l = this.log(id);
    const ago = (min: number, sec = 0) => new Date(Date.now() - min * 60_000 + sec * 1000);
    const it = (payload: ItemInit["payload"], over: Partial<ItemInit> & { at?: Date; until?: Date } = {}) => {
      const x = this.item(id, payload, over);
      l.items.push(x);
      return x;
    };
    if (loaded === "crashed") {
      // The daemon's item for a claude that exited before the initialize handshake.
      it({ case: "error", value: { text: `Claude exited (code 1) before answering the initialize handshake: ${CRASH_STDERR}` } }, { at: ago(0, -2) });
      l.seq = l.items.length;
      return;
    }
    const state = loaded === "closed" ? "idle" : loaded;
    const tool = (name: string, input: object, value: { output?: string; isError?: boolean; resultJson?: string; status?: ToolCallStatus }, over: Partial<ItemInit> & { at?: Date; until?: Date } = {}) => {
      const toolUseId = `toolu_${name.toLowerCase()}_${String(l.nextOrdinal)}`;
      // A tool call's item id is its tool_use id, like the daemon's.
      return it({ case: "toolCall", value: { toolUseId, name, inputJson: JSON.stringify(input), status: ToolCallStatus.DONE, ...value } }, { id: toolUseId, ...over });
    };
    const cwd = this.world.worktreeOf(id);
    if (state === "agents") {
      // The agents panel sketch (mock/agents.ts): idle at its prompt, background runs going on,
      // and one background shell (mock/shells.ts).
      const shells: ShellCall[] = [];
      const runs = scriptAgents({ cwd, it, tool, shells });
      this.agents.set(id, runs);
      this.shells.set(id, shells);
      l.seq = l.items.length;
      this.world.setStatus(id, SessionStatus.IDLE, "at prompt");
      this.world.agentsChanged(id);
      return;
    }
    if (state === "shells") {
      // Background shells only (mock/shells.ts): idle at its prompt, two shells running.
      this.shells.set(id, scriptShells({ cwd, it, tool }));
      l.seq = l.items.length;
      this.world.setStatus(id, SessionStatus.IDLE, "at prompt");
      this.world.agentsChanged(id);
      return;
    }
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
      // Turn 1 has no turn_cost_usd or model (an older daemon, or a cost the daemon could not
      // tell); turn 2 ran in a new process that started its totals afresh (the difference of
      // the totals would say $0.38).
      it({ case: "turnEnd", value: { subtype: "success", durationMs: 62_000n, numTurns: 4, costUsd: 1.5, turnCostUsd: 1.5, model: "claude-sonnet-5", stopReason: "end_turn" } }, { at: ago(1, 58) });
      l.seq = l.items.length;
      this.world.setStatus(id, SessionStatus.IDLE, "at prompt");
      return;
    }
    if (state === "multi") {
      text("All 412 tests pass. One thing before I push.", { at: ago(3) });
      const q = tool("AskUserQuestion", MULTI, { status: ToolCallStatus.RUNNING }, { at: ago(2, 58) });
      const qCall = q.payload?.case === "toolCall" ? q.payload.value : undefined;
      const item = it({ case: "question", value: { requestId: "req-checks", toolName: "AskUserQuestion", toolUseId: qCall?.toolUseId ?? "", inputJson: JSON.stringify(MULTI), state: ThreadRequestState.PENDING } }, { at: ago(2, 57) });
      const summary = MULTI.questions[0]?.question ?? "";
      l.pending = [{ requestId: "req-checks", itemId: item.id, question: true, toolName: "AskUserQuestion", summary }];
      l.seq = l.items.length;
      this.world.setStatus(id, SessionStatus.NEEDS_ATTENTION, `question: ${summary}`);
      this.source({ event: { case: "pending", value: { sessionId: id, seq: BigInt(l.seq), pending: l.pending } } });
      return;
    }
    if (state === "parallel") {
      // Two requests at once (a subagent and the main thread can ask in parallel): an Edit
      // first, then the push.
      text("All 412 tests pass. Tightening the poller's early return, then pushing.", { at: ago(3) });
      const edit = tool("Edit", { file_path: p("internal/store/pr/poller.go"), old_string: POLLER_OLD, new_string: POLLER_NEW }, { status: ToolCallStatus.RUNNING }, { at: ago(2, 59) });
      const editCall = edit.payload?.case === "toolCall" ? edit.payload.value : undefined;
      const editPerm = it(
        {
          case: "permission",
          value: {
            requestId: "req-edit",
            toolName: "Edit",
            displayName: "Edit",
            toolUseId: editCall?.toolUseId ?? "",
            inputJson: editCall?.inputJson ?? "",
            description: "poller.go",
            suggestionsJson: JSON.stringify([{ type: "setMode", mode: "acceptEdits", destination: "session" }]),
            state: ThreadRequestState.PENDING,
          },
        },
        { at: ago(2, 58) },
      );
      const push = tool("Bash", { command: PUSH, description: "Force-push the rebased branch so PR #63 picks up the fix." }, { status: ToolCallStatus.RUNNING }, { at: ago(2, 57) });
      const pushCall = push.payload?.case === "toolCall" ? push.payload.value : undefined;
      const pushPerm = it(
        {
          case: "permission",
          value: {
            requestId: "req-push",
            toolName: "Bash",
            displayName: "Bash",
            toolUseId: pushCall?.toolUseId ?? "",
            inputJson: pushCall?.inputJson ?? "",
            description: "Force-push the rebased branch so PR #63 picks up the fix.",
            suggestionsJson: JSON.stringify([{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git push:*" }], behavior: "allow", destination: "session" }]),
            state: ThreadRequestState.PENDING,
          },
        },
        { at: ago(2, 56) },
      );
      l.pending = [
        { requestId: "req-edit", itemId: editPerm.id, question: false, toolName: "Edit", summary: "Edit poller.go" },
        { requestId: "req-push", itemId: pushPerm.id, question: false, toolName: "Bash", summary: `Bash ${PUSH}` },
      ];
      l.seq = l.items.length;
      this.world.setStatus(id, SessionStatus.NEEDS_ATTENTION, "permission: Edit poller.go");
      this.source({ event: { case: "pending", value: { sessionId: id, seq: BigInt(l.seq), pending: l.pending } } });
      return;
    }
    if (state === "subagent") {
      // A subagent's Write waits for permission: the request carries its agent_id, its
      // tool call sits under the Agent call (parent_tool_use_id).
      text("All 412 tests pass. A helper writes the changelog entry before I push.", { at: ago(3) });
      const agent = tool("Agent", { description: "Write the changelog entry", subagent_type: "general-purpose", prompt: "Add a CHANGELOG.md entry for the force-push fix." }, { status: ToolCallStatus.RUNNING, output: "" }, { at: ago(2, 59) });
      const agentUse = agent.payload?.case === "toolCall" ? (agent.payload.value.toolUseId ?? "") : "";
      const write = tool("Write", { file_path: p("CHANGELOG.md"), content: "## Unreleased\n\n- The PR badge refreshes after a force-push.\n" }, { status: ToolCallStatus.RUNNING }, { at: ago(2, 58), parentToolUseId: agentUse });
      const writeCall = write.payload?.case === "toolCall" ? write.payload.value : undefined;
      const perm = it(
        {
          case: "permission",
          value: {
            requestId: "req-sub",
            toolName: "Write",
            displayName: "Write",
            toolUseId: writeCall?.toolUseId ?? "",
            agentId: "a69def54e0124efca",
            inputJson: writeCall?.inputJson ?? "",
            description: "CHANGELOG.md",
            suggestionsJson: JSON.stringify([{ type: "setMode", mode: "acceptEdits", destination: "session" }]),
            state: ThreadRequestState.PENDING,
          },
        },
        { at: ago(2, 57) },
      );
      l.pending = [{ requestId: "req-sub", itemId: perm.id, question: false, toolName: "Write", summary: "Write CHANGELOG.md" }];
      l.seq = l.items.length;
      this.world.setStatus(id, SessionStatus.NEEDS_ATTENTION, "permission: Write CHANGELOG.md");
      this.source({ event: { case: "pending", value: { sessionId: id, seq: BigInt(l.seq), pending: l.pending } } });
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

  /**
   * A default-world thread's short history (mock/world.ts reset), so its timeline is not
   * empty. Leaves the session's status alone (the world's seed sets it); a "permission"
   * end publishes its pending request on the EventService thread source.
   */
  seed(id: string, h: SeedHistory): void {
    this.logs.delete(id);
    this.agents.delete(id);
    this.shells.delete(id);
    if (h.end === "working" || h.end === "permission") {
      this.mcp.set(id, mcpFixture());
      this.slash.set(id, slashCommandsFixture());
    } else {
      this.mcp.delete(id);
      this.slash.delete(id);
    }
    const l = this.log(id);
    const at = (sec: number) => new Date(Date.now() - h.minutesAgo * 60_000 + sec * 1000);
    const push = (payload: ItemInit["payload"], over: Partial<ItemInit> & { at?: Date; until?: Date } = {}) => {
      const x = this.item(id, payload, over);
      l.items.push(x);
      return x;
    };
    const bash = (command: string, value: { output?: string; status?: ToolCallStatus }, sec: number) => {
      const toolUseId = `toolu_bash_${id}_${String(l.nextOrdinal)}`;
      return push({ case: "toolCall", value: { toolUseId, name: "Bash", inputJson: JSON.stringify({ command }), status: ToolCallStatus.DONE, ...value } }, { id: toolUseId, at: at(sec), until: at(sec + 1) });
    };
    push({ case: "userMessage", value: { text: h.prompt, attachments: [] } }, { at: at(0) });
    push({ case: "assistantText", value: { text: h.intro } }, { at: at(5) });
    bash(h.command, { output: h.output }, 8);
    if (h.end === "done") {
      push({ case: "assistantText", value: { text: h.reply } }, { at: at(20) });
      push({ case: "turnEnd", value: { subtype: "success", durationMs: 21_000n, numTurns: 3, costUsd: 0.21, turnCostUsd: 0.21, stopReason: "end_turn" } }, { at: at(21) });
    } else if (h.end === "working") {
      push({ case: "assistantText", value: { text: h.reply } }, { at: at(20), streaming: true });
    } else if (h.end === "permission") {
      const call = bash(h.reply, { status: ToolCallStatus.RUNNING }, 20);
      const use = call.payload?.case === "toolCall" ? call.payload.value : undefined;
      const perm = push(
        { case: "permission", value: { requestId: `req-${id}`, toolName: "Bash", displayName: "Bash", toolUseId: use?.toolUseId ?? "", inputJson: use?.inputJson ?? "", description: h.reply, state: ThreadRequestState.PENDING } },
        { at: at(21) },
      );
      l.pending = [{ requestId: `req-${id}`, itemId: perm.id, question: false, toolName: "Bash", summary: `Bash ${h.reply}` }];
    }
    l.seq = l.items.length;
    if (l.pending.length > 0) this.source({ event: { case: "pending", value: { sessionId: id, seq: BigInt(l.seq), pending: l.pending } } });
  }

  /**
   * session.fork, like the daemon (internal/store/session/fork.go): the fork's log starts
   * as a copy of the parent's items, renumbered, never live (streaming text dropped, a
   * running tool an error, a pending request cancelled), then the note "Forked from
   * <parent>" where the copy ends.
   */
  fork(parentId: string, id: string, parentName: string): void {
    this.logs.delete(id);
    const why = "the thread was forked before it finished";
    const l = this.log(id);
    for (const src of this.logs.get(parentId)?.items ?? []) {
      if (src.streaming) continue;
      const it = structuredClone(src);
      it.ordinal = BigInt(l.nextOrdinal++ * 10);
      const p = it.payload;
      if (p?.case === "toolCall" && p.value.status === ToolCallStatus.RUNNING) {
        p.value.status = ToolCallStatus.ERROR;
        p.value.output ||= `Interrupted: ${why}.`;
      }
      if ((p?.case === "permission" || p?.case === "question") && p.value.state === ThreadRequestState.PENDING) {
        p.value.state = ThreadRequestState.CANCELLED;
        p.value.message = why;
      }
      l.items.push(it);
    }
    l.items.push(this.item(id, { case: "note", value: { text: `Forked from ${parentName}` } }, { id: `note-fork-${parentId}` }));
    l.seq = l.items.length;
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
    // Every thread (the CLI's context has no view; the GUI's has "session").
    const when = (ctx: UiContext | undefined) => Boolean(ctx?.activeSessionId);
    // Like the daemon's: an arg with a context default is listed as not required (the GUI
    // does not prompt for it) and filled from the context when omitted.
    const id = { name: "id", type: ArgType.STRING, required: false, description: "Thread id (default: the active thread)" };
    const list: ReturnType<MockThreads["commands"]> = [
      {
        cmd: { name: "thread.send", title: "Send to Thread", category: "Thread", description: "Send a message to a thread", keybindings: [], args: [id, { name: "text", type: ArgType.STRING, required: true, description: "The message" }, { name: "attachments", type: ArgType.STRING, required: false, description: "Comma-separated image paths" }, { name: "composer-text", type: ArgType.STRING, required: false, description: "The composer's text with its tag tokens" }] },
        when,
        run: (_ctx, a) => {
          const atts = (a.attachments ?? "").split(",").filter(Boolean);
          // Like the daemon's Manager.Send: nothing reaches Claude and nothing is recorded.
          refuseSlashCommand(a.text ?? "");
          this.calls.push(`send ${a.id ?? ""} ${a.text ?? ""}${atts.length > 0 ? ` [${atts.join(",")}]` : ""}`);
          this.send(a.id ?? "", a.text ?? "", atts, a["composer-text"] ?? "");
          return `sent to thread ${a.id ?? ""}`;
        },
      },
      {
        cmd: { name: "thread.interrupt", title: "Interrupt Thread", category: "Thread", description: "Stop a thread's running turn", keybindings: [], args: [id] },
        when,
        run: (_ctx, a) => {
          this.calls.push(`interrupt ${a.id ?? ""}`);
          this.generation++;
          this.finish(a.id ?? "", { interrupted: true });
          return `interrupted thread ${a.id ?? ""}`;
        },
      },
      {
        cmd: {
          name: "thread.respond",
          title: "Answer Thread Request",
          category: "Thread",
          description: "Answer a pending permission request or question",
          keybindings: [],
          args: [
            id,
            { name: "decision", type: ArgType.ENUM, required: false, description: "allow, allow-session or deny", enumValues: ["allow", "allow-session", "deny"] },
            { name: "request", type: ArgType.STRING, required: false, description: "Request id" },
            { name: "answer", type: ArgType.STRING, required: false, description: "A question's answer" },
            { name: "message", type: ArgType.STRING, required: false, description: "With deny: the reason" },
          ],
        },
        when,
        run: (_ctx, a) => {
          const decision = (a.decision || "allow") as "allow" | "allow-session" | "deny";
          const sid = a.id ?? "";
          this.calls.push(`respond ${sid} ${decision}${a.request ? ` ${a.request}` : ""}${a.answer ? ` answer=${a.answer}` : ""}${a.message ? ` message=${a.message}` : ""}`);
          const fail = this.failRespond;
          this.failRespond = "";
          if (fail === "error") throw new Error("the thread's process has ended");
          if (fail === "withdrawn") {
            this.withdraw(sid, a.request ?? "");
            throw new CommandError("notfound", `Claude withdrew request ${a.request ?? ""}`);
          }
          let answers: Record<string, string> = {};
          const answer = (a.answer ?? "").trim();
          if (answer.startsWith("{")) answers = JSON.parse(answer) as Record<string, string>;
          else if (answer) {
            const l = this.log(sid);
            const p = a.request ? l.pending.find((x) => x.requestId === a.request) : l.pending[0];
            if (p?.summary) answers = { [p.summary]: answer };
          }
          const it = this.respond(sid, a.request ?? "", decision, answers, a.message ?? "");
          const r = it.payload?.case === "permission" || it.payload?.case === "question" ? it.payload.value : undefined;
          return `${r?.toolName ?? ""}: ${decision === "deny" ? "denied" : "allowed"}`;
        },
      },
      {
        cmd: { name: "thread.set-effort", title: "Set Thread Effort", category: "Thread", description: "Change a thread's effort level", keybindings: [], args: [id, { name: "effort", type: ArgType.ENUM, required: true, description: "Effort", enumValues: ["low", "medium", "high", "xhigh", "max"] }] },
        when,
        run: (_ctx, a) => {
          this.calls.push(`set-effort ${a.id ?? ""} ${a.effort ?? ""}`);
          const later = this.setEffort(a.id ?? "", a.effort ?? "");
          return later ? `thread switches to effort ${a.effort ?? ""} after this turn` : `thread restarts with effort ${a.effort ?? ""}`;
        },
      },
      {
        cmd: { name: "thread.set-model", title: "Set Thread Model", category: "Thread", description: "Switch a thread's model", keybindings: [], args: [id, { name: "model", type: ArgType.STRING, required: true, description: "Model" }] },
        when,
        run: (_ctx, a) => {
          this.calls.push(`set-model ${a.id ?? ""} ${a.model ?? ""}`);
          this.world.setModel(a.id ?? "", a.model ?? "");
          return `thread uses ${a.model ?? ""}`;
        },
      },
      {
        cmd: { name: "thread.set-mode", title: "Set Thread Permissions", category: "Thread", description: "Switch a thread's permission mode", keybindings: [], args: [id, { name: "permission", type: ArgType.ENUM, required: true, description: "supervised, accept-edits or auto", enumValues: ["supervised", "accept-edits", "auto"] }] },
        when,
        run: (_ctx, a) => {
          this.calls.push(`set-mode ${a.id ?? ""} ${a.permission ?? ""}`);
          this.world.setPermission(a.id ?? "", a.permission ?? "");
          return `thread runs ${a.permission ?? ""}`;
        },
      },
    ];
    return list.map((c) => ({ ...c, run: (ctx, a) => c.run(ctx, { ...a, id: a.id || ctx?.activeSessionId || "" }) }));
  }

  /** Text for the streaming answer's remainder (finish). */
  static readonly answerRest = ANSWER_REST;
}
