/**
 * Threads in the mock daemon (docs/notes/rendered-threads-2-gui.md): one scripted
 * conversation, the sketch's "Fix stale PR badge" (docs/sketches/rendered-thread), in the
 * states the sketch shows, a short history for each default-world thread (seed), plus
 * ThreadService.WatchThread / Send / Interrupt and the EventService `thread` source (pending
 * requests only, like the daemon since PR 1's review).
 *
 *   POST /__mock/thread?state=permission|question|streaming|idle|parallel|multi[&id=s-r1]
 *        (re)creates the scripted thread in that state; returns { id }. parallel: an Edit
 *        and a Bash permission pending at once (oldest first); multi: a multi-select question;
 *        html: a working turn with two inline pages, one rendering and one whose file is gone;
 *        theme: a finished turn that made and applied Ocean Dusk, its theme card, the dark slot on it
 *   POST /__mock/thread/delta?id=s-r1&text=…   appends text to the streaming answer
 *   POST /__mock/thread/stream?id=s-r1&text=…  starts a new streaming text item
 *   POST /__mock/thread/finish?id=s-r1          ends the streaming turn (turn_end, idle)
 *   POST /__mock/thread/fail-turn[?subtype=…]  the next message's turn ends in error before any text
 *   POST /__mock/thread/api-error[?text=…]     the next message's turn ends with Claude Code's API-error text
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
 * (Thread.effort_pending meanwhile).
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { ThreadStatus } from "../src/gen/codefoundry/v1/thread_lifecycle_pb";
import {
  MessageOrigin,
  ThreadAgentStatus,
  ThreadItemDelta_Field,
  ThreadRequestState,
  ToolCallStatus,
  type ThreadEventSchema,
  type ThreadItemSchema,
  type ThreadPendingRequestSchema,
  type ThemeItemSchema,
} from "../src/gen/codefoundry/v1/thread_pb";
import { END_REPORTS, scriptAgents, type AgentRunInit } from "./agents";
import { scriptEmberChat, scriptEmberRestartCut, scriptEmberRestartWake, type EmberChatScript } from "./emberChat";
import { CommandError } from "./errors";
import { Hub } from "./hub";
import { mcpFixture, type McpStatusInit } from "./mcp";
import { refuseSlashCommand, slashCommandsFixture, type SlashCommandInit } from "./slashCommands";
import { scriptServers, scriptShells, shellSummary, type ShellCall } from "./shells";

export type ThreadEventInit = MessageInitShape<typeof ThreadEventSchema>;
type ItemInit = MessageInitShape<typeof ThreadItemSchema>;
type PendingInit = MessageInitShape<typeof ThreadPendingRequestSchema>;
export type ThemeItemInit = MessageInitShape<typeof ThemeItemSchema>;

/**
 * A default-world thread's history (MockThreadLogs.seed): the prompt, Claude's first words
 * and one Bash call, then by `end`: a finished turn ("done"), a reply still streaming
 * ("working"), the next Bash call waiting for permission ("permission"), or the daemon's
 * "Claude stopped unexpectedly" ("cut": the process ended mid-turn; no turn_end follows).
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
  /** "cut": the exit code the error item names. */
  exitCode?: number;
  /**
   * A daemon note before the first message (an agent-made thread's "Created by …", id
   * note-created-by, with its creator's id in createdBy).
   */
  note?: { id: string; text: string; createdBy?: string };
  /** Wake messages the daemon sent after the history (docs/notes/agents-4-wake.md): header line and JSON payload. */
  wakes?: { title: string; json: string }[];
}

/** The world the threads live in (mock/world.ts implements it). */
export interface ThreadWorld {
  /** The thread's worktree; throws when the thread does not exist. */
  worktreeOf(id: string): string;
  /** Claude runs for the thread (CONNECTED). Internal to the daemon: the GUI never shows it. */
  isConnected(id: string): boolean;
  /**
   * Starts a stopped thread for a message, as the daemon's Send does (STARTING, back in the
   * thread list; a thread already starting just queues); `ready` runs once Claude is up.
   */
  start(id: string, ready: () => void): void;
  setStatus(id: string, status: ThreadStatus, reason: string): void;
  /** The user opened the thread: its plugins' until-seen flags go. */
  seenFlags(id: string): void;
  setModel(id: string, model: string): void;
  setPermission(id: string, permission: string): void;
  setEffort(id: string, effort: string, pending: boolean): void;
  statusOf(id: string): ThreadStatus;
  /** Throws the daemon's refusal when Claude Code deleted the thread's transcript (World.refuseTranscriptMissing). */
  refuseTranscriptMissing(id: string): void;
  /** The thread's model as picked ("claude-opus-4-8[1m]"). */
  modelOf(id: string): string;
  /** A turn ended: the thread's context totals move to now (mock/context.ts). */
  recordResult(id: string, model: string): void;
  /** The thread's subagent runs changed: its thread's running counts follow (mock/agents.ts). */
  agentsChanged(id: string): void;
  /** One of the user's themes as a theme card's file (mock/userThemes.ts), for the scripted theme state. */
  themeCard(id: string): ThemeItemInit["theme"];
  /** Puts a scheme's slot on a theme (the settings), as theme save --apply does. */
  setThemeSlot(scheme: "dark" | "light", id: string): void;
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
 * The scripted conversation's states. servers: the shells state with two dev servers
 * listening beside them (mock/shells.ts scriptServers). stopped: idle's conversation, the thread stopped at
 * its prompt cache expiry (no process; mock/world.ts backdates its last result so the
 * cache has expired); crashed: Claude did not start for a message (its item, the error
 * item and the daemon's process_ended turn end; mock/world.ts stops the thread with status
 * error "did not start").
 */
export type ThreadState = "permission" | "question" | "streaming" | "idle" | "parallel" | "multi" | "subagent" | "agents" | "shells" | "servers" | "stopped" | "crashed" | "html" | "html-idle" | "html-scroll" | "long" | "html-repeat" | "theme" | "bridge" | "pagelib";
export const THREAD_STATES: readonly ThreadState[] = ["permission", "question", "streaming", "idle", "parallel", "multi", "subagent", "agents", "shells", "servers", "stopped", "crashed", "html", "html-idle", "html-scroll", "long", "html-repeat", "theme", "bridge", "pagelib"];

/** The stderr line of the "crashed" state's claude (Thread.last_error). */
export const CRASH_STDERR = "error: unknown option '--bogus'";

/** The message the "crashed" state's claude did not start for: an image chip, a file tag and a skill. */
export const CRASHED_PROMPT = {
  text: `The PR badge in the sidebar stays green after a force-push, see [Image: pr-badge-stale.png; ref=${MOCK_ATTACHMENT}] Look at @cf-file://repo-cf/internal/store/pr/poller.go and tell me why the fingerprint misses it with /tdd .`,
  attachments: [MOCK_ATTACHMENT],
  composerText:
    "The PR badge in the sidebar stays green after a force-push, see ![pr-badge-stale.png](cf-attachment://0) Look at [poller.go](cf-file://repo-cf/internal/store/pr/poller.go) and tell me why the fingerprint misses it with [/tdd](cf-skill://~/tdd).",
};

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

export class MockThreadLogs {
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
  private readonly hub = new Hub<{ threadId: string; event: ThreadEventInit }>();
  /** thread.* calls, for GET /__mock/thread/calls. */
  calls: string[] = [];
  /** Bumped by reset(): a scripted reply still sleeping from before stops. */
  private generation = 0;
  /**
   * POST /__mock/thread/fail-respond: the next thread.respond fails (the prompt must come
   * back); with ?withdrawn=1 Claude withdrew the request first (NotFound, like the daemon).
   */
  failRespond: "" | "error" | "withdrawn" = "";
  /**
   * POST /__mock/thread/fail-turn[?subtype=…]: the next message's turn ends in error before
   * Claude writes any text (a turn_end with is_error and that subtype, default
   * error_during_execution); "" for none.
   */
  failTurn = "";
  /**
   * POST /__mock/thread/api-error[?text=…]: the next message's request fails the way Claude
   * Code reports it (docs/notes/api-error-reply-flag.md): a synthetic assistant text with
   * its error wording (api_error set; default the captured invalid-key text), then an
   * is_error turn end with subtype success; "" for none.
   */
  apiError = "";

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
    this.failTurn = "";
    this.apiError = "";
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
    this.hub.publish({ threadId: id, event });
  }

  /** ListItems' snapshot. */
  snapshotValue(id: string): { threadId: string; seq: bigint; items: ItemInit[]; pending: PendingInit[]; mcp?: McpStatusInit; commands: SlashCommandInit[]; agents: AgentRunInit[] } {
    this.world.worktreeOf(id);
    const l = this.log(id);
    return { threadId: id, seq: BigInt(l.seq), items: l.items, pending: l.pending, mcp: this.mcp.get(id), commands: this.slash.get(id) ?? [], agents: this.agents.get(id) ?? [] };
  }

  /** The thread's subagent runs in spawn order ([] for none). Throws for an unknown thread. */
  agentsOf(id: string): AgentRunInit[] {
    this.world.worktreeOf(id);
    return this.agents.get(id) ?? [];
  }

  /** The runs of a thread for its Thread's counts (no check: the thread may be going away). */
  agentRunsOf(id: string): readonly AgentRunInit[] {
    return this.agents.get(id) ?? [];
  }

  /** The thread's running background shells, for its Thread's count. */
  shellsOf(id: string): number {
    return this.shells.get(id)?.length ?? 0;
  }

  /** The thread's running background shells, oldest first (Thread.background_shells). */
  backgroundShellsOf(id: string): readonly ShellCall[] {
    return this.shells.get(id) ?? [];
  }

  /**
   * thread.shell.stop: the stop note, then the shell ends killed, as the daemon's stop
   * does once Claude reports it.
   */
  stopShell(id: string, taskId: string): void {
    const shell = (this.shells.get(id) ?? []).find((c) => c.taskId === taskId);
    if (!shell) throw new CommandError("notfound", `thread ${id} runs no background shell "${taskId}"`);
    this.append(id, this.item(id, { case: "note", value: { text: `Stopped background shell: ${shell.command || shell.description}` } }));
    this.endShell(id, true, taskId);
  }

  /**
   * POST /__mock/thread/shell-end: the oldest running shell (or taskId's) ends like the
   * daemon ends it: its call finishes with Claude's summary (an error when failed), the
   * count is published.
   */
  endShell(id: string, failed: boolean, taskId?: string): void {
    this.world.worktreeOf(id);
    const all = this.shells.get(id) ?? [];
    const shell = taskId === undefined ? all[0] : all.find((c) => c.taskId === taskId);
    const running = shell ? [shell, ...all.filter((c) => c !== shell)] : all;
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

  /** Replaces the thread's runs, publishes the Watch's `agents` event (the whole list) and the thread's counts. */
  setAgents(id: string, runs: AgentRunInit[]): void {
    if (runs.length > 0) this.agents.set(id, runs);
    else this.agents.delete(id);
    const l = this.log(id);
    l.seq++;
    this.publish(id, { event: { case: "agents", value: { threadId: id, seq: BigInt(l.seq), agents: runs } } });
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
    // The run's own work stops with it: a running tool ends (done, or interrupted when it
    // failed), a text still streaming is complete.
    for (const x of this.log(id).items) {
      if (x.parentToolUseId !== run.toolUseId) continue;
      if (x.payload?.case === "toolCall" && x.payload.value.status === ToolCallStatus.RUNNING) {
        this.update(id, {
          ...x,
          updatedAt: timestampFromDate(now),
          payload: { case: "toolCall", value: { ...x.payload.value, status: failed ? ToolCallStatus.ERROR : ToolCallStatus.DONE, isError: failed, output: failed ? "Interrupted" : "ok" } },
        } as ItemInit);
      } else if (x.streaming) {
        this.update(id, { ...x, streaming: false, updatedAt: timestampFromDate(now) });
      }
    }
    // A done run hands its report back with a SubagentHandback call, as Claude Code's
    // subagents do (the daemon makes its message the run's summary).
    if (!failed) {
      const hb = `${run.toolUseId ?? ""}-handback`;
      this.append(
        id,
        this.item(
          id,
          { case: "toolCall", value: { toolUseId: hb, name: "SubagentHandback", inputJson: JSON.stringify({ message: report }), status: ToolCallStatus.DONE, output: "Report delivered." } },
          { id: hb, parentToolUseId: run.toolUseId ?? "" },
        ),
      );
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
    this.publish(id, { event: { case: "commands", value: { threadId: id, seq: BigInt(l.seq), commands } } });
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
    this.publish(id, { event: { case: "mcp", value: { threadId: id, seq: BigInt(l.seq), status } } });
  }

  /** The Watch's first event. */
  snapshot(id: string): ThreadEventInit {
    return { event: { case: "snapshot", value: this.snapshotValue(id) } };
  }

  /** The EventService thread source's snapshot: pending requests of threads that have any. */
  pendingSnapshot(): ThreadEventInit {
    const threads = [...this.logs.entries()].filter(([, l]) => l.pending.length > 0).map(([threadId, l]) => ({ threadId, seq: BigInt(l.seq), pending: l.pending }));
    return { event: { case: "pendingSnapshot", value: { threads } } };
  }

  /** ThreadService.WatchThread: the snapshot, then this thread's events; counts as a viewer while open. */
  async *watch(id: string, signal: AbortSignal): AsyncGenerator<ThreadEventInit> {
    this.world.worktreeOf(id);
    const l = this.log(id);
    l.watchers++;
    this.seen(id);
    this.world.seenFlags(id);
    try {
      const live = this.hub.subscribe(signal);
      yield this.snapshot(id);
      for await (const { threadId, event } of live) if (threadId === id) yield event;
    } finally {
      l.watchers--;
    }
  }

  /**
   * A finished turn is seen while someone watches: "finished" becomes "at prompt". An error
   * status stays, like the daemon's (a failed start ends with a turn end too).
   */
  private seen(id: string): void {
    const l = this.log(id);
    const last = l.items[l.items.length - 1];
    if (l.watchers > 0 && l.pending.length === 0 && last?.payload?.case === "turnEnd" && this.world.statusOf(id) !== ThreadStatus.ERROR) this.world.setStatus(id, ThreadStatus.IDLE, "at prompt");
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
    this.publish(id, { event: { case: "appended", value: { threadId: id, seq: BigInt(l.seq), item: it } } });
    return it;
  }

  private update(id: string, it: ItemInit): void {
    const l = this.log(id);
    const i = l.items.findIndex((x) => x.id === it.id);
    if (i < 0) return;
    l.items[i] = it;
    l.seq++;
    this.publish(id, { event: { case: "updated", value: { threadId: id, seq: BigInt(l.seq), item: it } } });
  }

  private setPending(id: string, pending: PendingInit[]): void {
    const l = this.log(id);
    l.pending = pending;
    l.seq++;
    const value = { threadId: id, seq: BigInt(l.seq), pending };
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
    this.publish(id, { event: { case: "delta", value: { threadId: id, seq: BigInt(l.seq), itemId: it.id, ordinal: it.ordinal, field: ThreadItemDelta_Field.TEXT, text } } });
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
    this.world.setStatus(id, l.watchers > 0 ? ThreadStatus.IDLE : ThreadStatus.NEEDS_ATTENTION, l.watchers > 0 ? "at prompt" : "finished");
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

  /**
   * thread.restart on a running thread (docs/notes/plugins-env-restart.md): a running turn
   * is interrupted first, then after a short "restart" the timeline says "Restarted Claude"
   * (the daemon's RestartNote); the conversation is the same.
   */
  restart(id: string): void {
    const l = this.log(id);
    if (this.world.statusOf(id) === ThreadStatus.BUSY || l.pending.length > 0) {
      this.generation++;
      this.finish(id, { interrupted: true });
    }
    const gen = this.generation;
    setTimeout(() => {
      if (gen === this.generation) this.append(id, this.item(id, { case: "commandOutput", value: { text: "Restarted Claude" } }));
    }, 300);
  }

  /** A daemon note in the timeline (thread.project.add and remove). */
  addNote(id: string, text: string): void {
    this.append(id, this.item(id, { case: "note", value: { text } }));
  }

  /**
   * thread.set-effort: at once when idle (after a short "restart"), else when the turn ends.
   * A stopped thread just keeps it for its next start, like the daemon (nothing restarts).
   */
  setEffort(id: string, effort: string): "after-turn" | "restart" | "next-message" {
    if (!this.world.isConnected(id)) {
      this.world.setEffort(id, effort, false);
      return "next-message";
    }
    const l = this.log(id);
    const status = this.world.statusOf(id);
    const onTurn = status === ThreadStatus.BUSY || l.pending.length > 0;
    this.world.setEffort(id, effort, true);
    if (onTurn) {
      l.pendingEffort = effort;
      return "after-turn";
    }
    const gen = this.generation;
    setTimeout(() => {
      if (gen === this.generation) this.applyEffort(id, effort);
    }, 300);
    return "restart";
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
      this.world.setStatus(id, ThreadStatus.NEEDS_ATTENTION, `${next.question ? "question" : "permission"}: ${next.summary ?? ""}`);
      return resolved;
    }
    this.world.setStatus(id, ThreadStatus.BUSY, "working");
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
    // Checked at the start of its last turn (the status outlives the process); a thread
    // whose Claude never started has none.
    if (loaded === "crashed") {
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
      // Like the daemon's Send to a stopped thread whose claude exited before the initialize
      // handshake: the message's item, the error item, and the turn end the daemon writes
      // for a turn that never ran (turnclose.go closeOpenTurn).
      const prompt = it({ case: "userMessage", value: CRASHED_PROMPT }, { at: ago(0, -3) });
      it({ case: "error", value: { text: `Claude did not start: exit code 1: ${CRASH_STDERR}` } }, { at: ago(0, -2) });
      it({ case: "turnEnd", value: { subtype: "process_ended", interrupted: true, durationMs: BigInt(1000) } }, { id: `turn-synth-${prompt.id ?? ""}`, at: ago(0, -2) });
      l.seq = l.items.length;
      return;
    }
    const state = loaded === "stopped" ? "idle" : loaded;
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
      this.world.setStatus(id, ThreadStatus.IDLE, "at prompt");
      this.world.agentsChanged(id);
      return;
    }
    if (state === "shells" || state === "servers") {
      // Background shells only (mock/shells.ts): idle at its prompt, two shells running
      // (and two servers listening).
      this.shells.set(id, state === "servers" ? scriptServers({ cwd, it, tool }) : scriptShells({ cwd, it, tool }));
      l.seq = l.items.length;
      this.world.setStatus(id, ThreadStatus.IDLE, "at prompt");
      this.world.agentsChanged(id);
      return;
    }
    if (state === "html") {
      // Inline pages (docs/notes/inline-html.md), the turn still working so the cards show
      // open: one that renders (mock/files.ts INLINE_PAGE_HTML, themed, asks for its height)
      // and one whose file is gone (the failed state). /__mock/thread/finish ends the turn.
      it({ case: "userMessage", value: { text: "Show me a small page that says hello with a button, inline.", attachments: [] } }, { at: ago(1) });
      tool("Write", { file_path: `${cwd}/docs/hello.html`, content: "<!doctype html>…" }, { output: `File created successfully at: ${cwd}/docs/hello.html` }, { at: ago(0, 50) });
      tool("Bash", { command: "code-foundry view.inline docs/hello.html" }, { output: `shown docs/hello.html in thread Fix stale PR badge` }, { at: ago(0, 48) });
      it({ case: "html", value: { path: "docs/hello.html", title: "", baseDir: cwd } }, { at: ago(0, 48) });
      it({ case: "assistantText", value: { text: "Here it is: a heading and a Wave button." } }, { at: ago(0, 46) });
      it({ case: "html", value: { path: "docs/gone.html", title: "An older page", baseDir: cwd } }, { at: ago(0, 44) });
      it({ case: "assistantText", value: { text: "That second one was deleted since, so it cannot be shown." } }, { at: ago(0, 42), streaming: true });
      l.seq = l.items.length;
      this.world.setStatus(id, ThreadStatus.BUSY, "working");
      return;
    }
    if (state === "bridge") {
      // A page that calls Code Foundry through its bridge (docs/notes/bridge-2-gui.md;
      // mock/bridge-page.html), shown in a working turn: archiving the thread asks first.
      it({ case: "userMessage", value: { text: "Show me a page that checks the bridge.", attachments: [] } }, { at: ago(1) });
      tool("Bash", { command: "code-foundry view.inline docs/bridge.html" }, { output: `shown docs/bridge.html in thread Fix stale PR badge` }, { at: ago(0, 48) });
      it({ case: "html", value: { path: "docs/bridge.html", title: "Bridge check", baseDir: cwd } }, { at: ago(0, 48) });
      it({ case: "assistantText", value: { text: "Here it is." } }, { at: ago(0, 46), streaming: true });
      l.seq = l.items.length;
      this.world.setStatus(id, ThreadStatus.BUSY, "working");
      return;
    }
    if (state === "pagelib") {
      // Pages built on the page library (docs/notes/page-library.md; mock/pagelib/): a React
      // board with @cf/ui, the Tailwind runtime, a TSX syntax error and a free-styled mockup;
      // then what the fixes cover (docs/notes/page-library-fixes-a.md).
      it({ case: "userMessage", value: { text: "Show me what pages can be made of.", attachments: [] } }, { at: ago(1) });
      for (const [name, title] of [
        ["tailwind", "Tailwind runtime"], ["broken", "Broken TSX"], ["mockup", "Streaks mockup"], ["roles", "Roles and utilities"], ["margin", "Margins"],
        ["both", "ui.css and the runtime"], ["throw", "Render throws"], ["mismatch", "Mismatched tag"], ["pinned", "Light only"], ["board", "Thread board"],
      ] as const) {
        it({ case: "html", value: { path: `docs/pagelib/${name}.html`, title, baseDir: cwd } }, { at: ago(0, 48) });
      }
      it({ case: "assistantText", value: { text: "Here they are." } }, { at: ago(0, 46), streaming: true });
      l.seq = l.items.length;
      this.world.setStatus(id, ThreadStatus.BUSY, "working");
      return;
    }
    if (state === "theme") {
      // The model made a theme (docs/notes/theme-model-flow.md): it saved and applied the
      // seeded Ocean Dusk, whose card follows the save (Undo back to Catppuccin Mocha).
      it({ case: "userMessage", value: { text: "Make me a dark theme that feels like a tide pool at night. Teal accent, keep the sidebar quieter than Mocha.", attachments: [] } }, { at: ago(2) });
      tool("Bash", { command: "code-foundry theme show catppuccin-mocha" }, { output: '{\n  "id": "catppuccin-mocha", …' }, { at: ago(1, 55) });
      tool("Write", { file_path: "/Users/dev/.code-foundry/pages/s-r1/ocean-dusk.json", content: '{ "id": "ocean-dusk", … }' }, { output: "File created successfully" }, { at: ago(1, 50) });
      tool("Bash", { command: "code-foundry theme save --file ~/.code-foundry/pages/s-r1/ocean-dusk.json --apply" }, { output: "saved Ocean Dusk (ocean-dusk), a dark theme\napplied: dark theme = Ocean Dusk (ocean-dusk)" }, { at: ago(1, 45) });
      const card = this.world.themeCard("ocean-dusk");
      if (card) it({ case: "theme", value: { theme: card, applied: true, previous: "catppuccin-mocha" } }, { at: ago(1, 45) });
      it(
        {
          case: "assistantText",
          value: {
            text: "Done. I started from Catppuccin Mocha, moved the canvas and surface to a deep blue-black, set the accent to teal, and pinned `sidebar-row-selected` a step lighter so the selected thread still reads on the quieter sidebar. Want the warning colour warmer, or a light pair for daytime?",
          },
        },
        { at: ago(1, 40) },
      );
      it({ case: "turnEnd", value: { subtype: "success", durationMs: 24_000n, numTurns: 4, costUsd: 0.04, turnCostUsd: 0.04, stopReason: "end_turn" } }, { at: ago(1, 40) });
      l.seq = l.items.length;
      this.world.setThemeSlot("dark", "ocean-dusk");
      this.world.setStatus(id, ThreadStatus.IDLE, "at prompt");
      return;
    }
    if (state === "html-idle") {
      // Pages a verb showed while the thread sat at its prompt (view.inline --thread from a
      // terminal or a child; docs/notes/inline-html-2-fixes.md): after a finished turn and
      // outside any, so they arrive open. One follows cf:theme and acks it (hello), one only
      // links the stylesheet (plain), one hard-codes a prefers-color-scheme block (scheme).
      it({ case: "userMessage", value: { text: "Write the release notes.", attachments: [] } }, { at: ago(3) });
      it({ case: "assistantText", value: { text: "Done: the notes are in RELEASE.md." } }, { at: ago(2, 50) });
      it({ case: "turnEnd", value: { subtype: "success", durationMs: 10_000n, numTurns: 1, costUsd: 0.02, turnCostUsd: 0.02, stopReason: "end_turn" } }, { at: ago(2, 50) });
      it({ case: "html", value: { path: "docs/hello.html", title: "", baseDir: cwd } }, { at: ago(1) });
      it({ case: "html", value: { path: "docs/plain.html", title: "", baseDir: cwd } }, { at: ago(1, 5) });
      it({ case: "html", value: { path: "docs/scheme.html", title: "", baseDir: cwd } }, { at: ago(1, 10) });
      l.seq = l.items.length;
      this.world.setStatus(id, ThreadStatus.IDLE, "at prompt");
      return;
    }
    if (state === "long") {
      // Forty short exchanges, many rows taller than the pane: the virtualized list mounts
      // only the rows near the viewport (docs/notes/thread-info-wheel-native.md).
      for (let n = 1; n <= 40; n++) {
        it({ case: "userMessage", value: { text: `Question ${String(n)}: what does step ${String(n)} change?`, attachments: [] } }, { at: ago(90 - 2 * n) });
        tool("Bash", { command: `go test ./internal/store/pr/... -run Step${String(n)}` }, { output: Array.from({ length: 6 }, (_, i) => `ok  \tgithub.com/alexwaumann/code-foundry/internal/store/pr/s${String(i)}\t0.${String(i + 1)}s`).join("\n") }, { at: ago(90 - 2 * n, 10) });
        it({ case: "assistantText", value: { text: n % 2 === 0 ? `Answer ${String(n)}:\n\n${ANSWER_HEAD}${GO_BLOCK}` : `Answer ${String(n)}: step ${String(n)} moves one piece of the work along, and the notes say why at some length.` } }, { at: ago(90 - 2 * n, 30) });
        it({ case: "turnEnd", value: { subtype: "success", durationMs: 5_000n, numTurns: 1, costUsd: 0.01, turnCostUsd: 0.01, stopReason: "end_turn" } }, { at: ago(90 - 2 * n, 30) });
      }
      l.seq = l.items.length;
      this.world.setStatus(id, ThreadStatus.IDLE, "at prompt");
      return;
    }
    if (state === "html-scroll") {
      // A conversation longer than the pane, ending in a page taller than its card (mock/files.ts
      // TALL_PAGE_HTML), shown outside any turn so it arrives open at the bottom
      // (docs/notes/inline-page-frame.md): a wheel up over the page scrolls the thread.
      const long = Array.from({ length: 12 }, (_, i) => `Paragraph ${String(i + 1)}: the notes go on for a while so the thread is taller than its pane.`).join("\n\n");
      for (const n of [1, 2]) {
        it({ case: "userMessage", value: { text: `Write part ${String(n)} of the notes.`, attachments: [] } }, { at: ago(4 - n) });
        it({ case: "assistantText", value: { text: long } }, { at: ago(4 - n, 50) });
        it({ case: "turnEnd", value: { subtype: "success", durationMs: 10_000n, numTurns: 1, costUsd: 0.02, turnCostUsd: 0.02, stopReason: "end_turn" } }, { at: ago(4 - n, 50) });
      }
      it({ case: "html", value: { path: "docs/tall.html", title: "", baseDir: cwd } }, { at: ago(1) });
      l.seq = l.items.length;
      this.world.setStatus(id, ThreadStatus.IDLE, "at prompt");
      return;
    }
    if (state === "html-repeat") {
      // The same page shown in three turns (docs/notes/inline-page-shows.md): only the last
      // show is a card, the two before it are link rows to it. The turns' text makes the
      // thread taller than its pane, so a link row's click has somewhere to scroll.
      const long = Array.from({ length: 5 }, (_, i) => `Paragraph ${String(i + 1)}: what changed in this version of the page, at some length.`).join("\n\n");
      const asks = ["Show me a page that says hello.", "Make the greeting bigger.", "Add a wave button."];
      asks.forEach((ask, i) => {
        const at = 6 - 2 * i;
        it({ case: "userMessage", value: { text: ask, attachments: [] } }, { at: ago(at) });
        it({ case: "assistantText", value: { text: long } }, { at: ago(at, 10) });
        it({ case: "html", value: { path: "docs/hello.html", title: i === 2 ? "Hello, third show" : "", baseDir: cwd } }, { at: ago(at, 20) });
        it({ case: "assistantText", value: { text: `Version ${String(i + 1)} is above.` } }, { at: ago(at, 25) });
        it({ case: "turnEnd", value: { subtype: "success", durationMs: 10_000n, numTurns: 1, costUsd: 0.02, turnCostUsd: 0.02, stopReason: "end_turn" } }, { at: ago(at, 25) });
      });
      l.seq = l.items.length;
      this.world.setStatus(id, ThreadStatus.IDLE, "at prompt");
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
      this.world.setStatus(id, ThreadStatus.BUSY, "working");
      return;
    }
    text(ANSWER, { at: ago(5, 30) });
    it({ case: "turnEnd", value: { subtype: "success", durationMs: 248_000n, numTurns: 22, costUsd: 1.12, stopReason: "end_turn", inputTokens: 48_200n, outputTokens: 6_100n } }, { at: ago(4, 52) });

    // Turn 2.
    it({ case: "userMessage", value: { text: "Looks good. Run the full suite, then push the branch.", attachments: [] } }, { at: ago(4) });
    tool("Bash", { command: "go test ./..." }, { output: "ok  \tgithub.com/alexwaumann/code-foundry/...\t(412 tests)", resultJson: JSON.stringify({ stdout: "ok  \t…/internal/store/pr\t0.41s\nok  \t…/internal/api\t3.2s\n(412 tests passed)", stderr: "" }) }, { at: ago(3, 12), until: ago(3, 50) });
    if (state === "idle") {
      text("All 412 tests pass and the branch is pushed: PR #63 picked up the fix. The notes are in README.md, and the poller starts at `src/app.ts:12`.", { at: ago(2) });
      // Turn 1 has no turn_cost_usd or model (an older daemon, or a cost the daemon could not
      // tell); turn 2 ran in a new process that started its totals afresh (the difference of
      // the totals would say $0.38).
      it({ case: "turnEnd", value: { subtype: "success", durationMs: 62_000n, numTurns: 4, costUsd: 1.5, turnCostUsd: 1.5, model: "claude-sonnet-5", stopReason: "end_turn" } }, { at: ago(1, 58) });
      l.seq = l.items.length;
      this.world.setStatus(id, ThreadStatus.IDLE, "at prompt");
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
      this.world.setStatus(id, ThreadStatus.NEEDS_ATTENTION, `question: ${summary}`);
      this.source({ event: { case: "pending", value: { threadId: id, seq: BigInt(l.seq), pending: l.pending } } });
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
      this.world.setStatus(id, ThreadStatus.NEEDS_ATTENTION, "permission: Edit poller.go");
      this.source({ event: { case: "pending", value: { threadId: id, seq: BigInt(l.seq), pending: l.pending } } });
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
      this.world.setStatus(id, ThreadStatus.NEEDS_ATTENTION, "permission: Write CHANGELOG.md");
      this.source({ event: { case: "pending", value: { threadId: id, seq: BigInt(l.seq), pending: l.pending } } });
      return;
    }
    if (state === "question") {
      text("All 412 tests pass. Two things to settle before I push.", { at: ago(3) });
      const q = tool("AskUserQuestion", QUESTIONS, { status: ToolCallStatus.RUNNING }, { at: ago(2, 58) });
      const qCall = q.payload?.case === "toolCall" ? q.payload.value : undefined;
      const item = it({ case: "question", value: { requestId: "req-push-q", toolName: "AskUserQuestion", toolUseId: qCall?.toolUseId ?? "", inputJson: JSON.stringify(QUESTIONS), state: ThreadRequestState.PENDING } }, { at: ago(2, 57) });
      l.pending = [{ requestId: "req-push-q", itemId: item.id, question: true, toolName: "AskUserQuestion", summary: QUESTIONS.questions[0]?.question ?? "" }];
      l.seq = l.items.length;
      this.world.setStatus(id, ThreadStatus.NEEDS_ATTENTION, `question: ${QUESTIONS.questions[0]?.question ?? ""}`);
      this.source({ event: { case: "pending", value: { threadId: id, seq: BigInt(l.seq), pending: l.pending } } });
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
    this.world.setStatus(id, ThreadStatus.NEEDS_ATTENTION, `permission: Bash ${PUSH}`);
    this.source({ event: { case: "pending", value: { threadId: id, seq: BigInt(l.seq), pending: l.pending } } });
  }

  /**
   * A default-world thread's short history (mock/world.ts reset), so its timeline is not
   * empty. Leaves the thread's status alone (the world's seed sets it); a "permission"
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
    if (h.note) push({ case: "note", value: { text: h.note.text, createdBy: h.note.createdBy ?? "" } }, { id: h.note.id, at: at(0) });
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
    } else {
      push({ case: "error", value: { text: `Claude stopped unexpectedly (exit code ${String(h.exitCode ?? 1)})` } }, { at: at(12) });
    }
    for (const [i, w] of (h.wakes ?? []).entries()) {
      const text = `[code-foundry wake] ${w.title}\n\`\`\`json\n${w.json}\n\`\`\``;
      push({ case: "userMessage", value: { text, attachments: [], origin: MessageOrigin.WAKE, wakeTitle: w.title, wakeJson: w.json } }, { at: at(30 + i) });
    }
    l.seq = l.items.length;
    if (l.pending.length > 0) this.source({ event: { case: "pending", value: { threadId: id, seq: BigInt(l.seq), pending: l.pending } } });
  }

  /**
   * Ember's chat (mock/emberChat.ts): the resident thread's history, matching the seeded
   * board. Leaves the thread's status alone (idle at its prompt, as World.addResident makes it).
   */
  seedEmber(id: string): void {
    this.logs.delete(id);
    this.agents.delete(id);
    this.shells.delete(id);
    const l = this.log(id);
    const it = (payload: ItemInit["payload"], over: Partial<ItemInit> & { at?: Date; until?: Date } = {}) => {
      const x = this.item(id, payload, over);
      l.items.push(x);
      return x;
    };
    const tool = (name: string, input: object, value: { output?: string; status?: ToolCallStatus }, over: Partial<ItemInit> & { at?: Date; until?: Date } = {}) => {
      const toolUseId = `toolu_${name.toLowerCase()}_${String(l.nextOrdinal)}`;
      return it({ case: "toolCall", value: { toolUseId, name, inputJson: JSON.stringify(input), status: ToolCallStatus.DONE, ...value } }, { id: toolUseId, ...over });
    };
    scriptEmberChat({ it, tool });
    l.seq = l.items.length;
  }

  /** The Ember chat's script as live appends (each item reaches the thread's watchers). */
  private emberScript(id: string): EmberChatScript {
    const l = this.log(id);
    const it = (payload: ItemInit["payload"], over: Partial<ItemInit> & { at?: Date; until?: Date } = {}) => this.append(id, this.item(id, payload, over));
    const tool = (name: string, input: object, value: { output?: string; status?: ToolCallStatus }, over: Partial<ItemInit> & { at?: Date; until?: Date } = {}) => {
      const toolUseId = `toolu_${name.toLowerCase()}_${String(l.nextOrdinal)}`;
      return it({ case: "toolCall", value: { toolUseId, name, inputJson: JSON.stringify(input), status: ToolCallStatus.DONE, ...value } }, { id: toolUseId, ...over });
    };
    return { it, tool };
  }

  /** POST /__mock/ember/restart?step=cut: the app's restart cuts Ember's turn (mock/emberChat.ts). */
  emberRestartCut(id: string): void {
    scriptEmberRestartCut(this.emberScript(id));
  }

  /** POST /__mock/ember/restart?step=wake: the restart notice wakes Ember and it replies. */
  emberRestartWake(id: string): void {
    scriptEmberRestartWake(this.emberScript(id));
  }

  /**
   * thread.fork, like the daemon (internal/store/thread/fork.go): the fork's log starts
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

  /**
   * thread.send: the user message at once, then a short streamed reply and the turn's end.
   * A stopped thread starts first, like the daemon's Send: the reply waits for Claude.
   * Sent while a turn runs it is a steer, like the daemon's: the message lands inside the
   * turn (the text streaming at the moment completes first), Claude replies to it in the
   * same turn, and one turn_end ends it.
   */
  /**
   * ThreadService.ShowHtml (code-foundry view.inline; docs/notes/inline-html.md): an html
   * item at the end of the log, its path relative to the thread's cwd when inside it. Only
   * the extension is checked here (the daemon also wants a file under home).
   */
  showHtml(id: string, path: string, title: string): ItemInit {
    if (!/\.html?$/i.test(path)) throw new CommandError("invalid", `${path} is not an .html or .htm file`);
    const cwd = this.world.worktreeOf(id);
    const rel = cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
    return this.append(id, this.item(id, { case: "html", value: { path: rel, title, baseDir: cwd } }));
  }

  /**
   * ThreadService.ShowTheme (code-foundry theme save from the thread;
   * docs/notes/theme-model-flow.md): a theme item at the end of the log. Its Undo is what
   * the slot showed just before the save, as the daemon's store keeps it
   * (docs/notes/theme-fuzz-daemon.md): none when not applied, the replaced version when
   * previous is the theme itself.
   */
  showTheme(id: string, theme: ThemeItemInit): ItemInit {
    const themeId = theme.theme?.id ?? "";
    let { previous = "", previousVersion = "", previousGone = false } = theme;
    if (!theme.applied || (previous === themeId && !previousVersion && !previousGone)) [previous, previousVersion, previousGone] = ["", "", false];
    else if (previous !== themeId) previousVersion = "";
    return this.append(id, this.item(id, { case: "theme", value: { ...theme, previous, previousVersion, previousGone } }));
  }

  send(id: string, text: string, attachments: string[], composerText = ""): ItemInit {
    // Like the daemon's: nothing is recorded for a thread whose transcript is gone.
    this.world.refuseTranscriptMissing(id);
    if (this.world.statusOf(id) === ThreadStatus.BUSY) {
      for (const x of this.log(id).items) if (x.streaming) this.update(id, { ...x, streaming: false, updatedAt: timestampFromDate(new Date()) });
    }
    const msg = this.append(id, this.item(id, { case: "userMessage", value: { text, attachments, composerText } }));
    if (this.world.isConnected(id)) this.reply(id);
    else {
      const gen = this.generation;
      this.world.start(id, () => {
        if (gen === this.generation) this.reply(id);
      });
    }
    return msg;
  }

  /** The scripted reply to a message: thinking, a streamed answer, the turn's end. */
  private reply(id: string): void {
    this.world.setStatus(id, ThreadStatus.BUSY, "working");
    const gen = this.generation;
    void (async () => {
      await sleep(250);
      if (gen !== this.generation) return;
      if (this.apiError) {
        // POST /__mock/thread/api-error: Claude Code's synthetic API-error message, not streamed
        // and with nothing before it (the request never reached the model).
        const text = this.apiError;
        this.apiError = "";
        this.append(id, this.item(id, { case: "assistantText", value: { text, apiError: true } }));
        this.append(id, this.item(id, { case: "turnEnd", value: { subtype: "success", isError: true, terminalReason: "api_error", durationMs: BigInt(120), numTurns: 1 } }));
        const l = this.log(id);
        this.world.setStatus(id, l.watchers > 0 ? ThreadStatus.IDLE : ThreadStatus.NEEDS_ATTENTION, l.watchers > 0 ? "at prompt" : "finished");
        return;
      }
      this.append(id, this.item(id, { case: "thinking", value: { text: "" } }));
      await sleep(250);
      if (gen !== this.generation) return;
      if (this.failTurn) {
        // POST /__mock/thread/fail-turn: the turn ends in error before any text.
        const subtype = this.failTurn;
        this.failTurn = "";
        this.append(id, this.item(id, { case: "turnEnd", value: { subtype, isError: true, durationMs: BigInt(500), numTurns: 1 } }));
        const l = this.log(id);
        this.world.setStatus(id, l.watchers > 0 ? ThreadStatus.IDLE : ThreadStatus.NEEDS_ATTENTION, l.watchers > 0 ? "at prompt" : "finished");
        return;
      }
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
  }

  /** The thread.* commands (mock/world.ts registry): the GUI passes the thread as `id`. */
  commands(): {
    cmd: { name: string; title: string; category: string; description: string; keybindings: string[]; noPalette?: boolean; args: { name: string; type: ArgType; required: boolean; description: string; enumValues?: string[] }[] };
    when: (ctx: UiContext | undefined) => boolean;
    run: (ctx: UiContext | undefined, args: Record<string, string>) => string;
  }[] {
    // Every thread (the CLI's context has no view; the GUI's has "thread").
    const when = (ctx: UiContext | undefined) => Boolean(ctx?.activeThreadId);
    // Like the daemon's: an arg with a context default is listed as not required (the GUI
    // does not prompt for it) and filled from the context when omitted.
    const id = { name: "id", type: ArgType.STRING, required: false, description: "Thread id (default: the active thread)" };
    const list: ReturnType<MockThreadLogs["commands"]> = [
      {
        cmd: { name: "thread.send", noPalette: true, title: "Send to Thread", category: "Thread", description: "Send a message to a thread", keybindings: [], args: [id, { name: "text", type: ArgType.STRING, required: true, description: "The message" }, { name: "attachments", type: ArgType.STRING, required: false, description: "Comma-separated image paths" }, { name: "composer-text", type: ArgType.STRING, required: false, description: "The composer's text with its tag tokens" }] },
        when,
        run: (_ctx, a) => {
          const atts = (a.attachments ?? "").split(",").filter(Boolean);
          // Like the daemon's Manager.Send: nothing reaches Claude and nothing is recorded.
          refuseSlashCommand(a.text ?? "");
          this.calls.push(`send ${a.id ?? ""} ${a.text ?? ""}${atts.length > 0 ? ` [${atts.join(",")}]` : ""}`);
          this.send(a.id ?? "", a.text ?? "", atts, a["composer-text"] ?? "");
          // The daemon's message is for the CLI (commands_thread.go sendNext); the GUI must not toast it as is.
          return `sent to thread ${a.id ?? ""}; wait with: code-foundry thread wait ${a.id ?? ""}`;
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
          name: "thread.respond", noPalette: true,
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
          const when = this.setEffort(a.id ?? "", a.effort ?? "");
          if (when === "next-message") return `thread uses effort ${a.effort ?? ""} from its next message`;
          return when === "after-turn" ? `thread switches to effort ${a.effort ?? ""} after this turn` : `thread restarts with effort ${a.effort ?? ""}`;
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
    return list.map((c) => ({ ...c, run: (ctx, a) => c.run(ctx, { ...a, id: a.id || ctx?.activeThreadId || "" }) }));
  }

  /** Text for the streaming answer's remainder (finish). */
  static readonly answerRest = ANSWER_REST;
}
