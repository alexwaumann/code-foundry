/**
 * Mock Ember, the resident agent (docs/notes/ember-2-store.md): its status and task board,
 * served by EmberService (GetStatus, ListTasks, WatchBoard). Enabled follows the
 * ember.enabled setting (world.ts wires it: turning it on adds the resident thread
 * s-resident-ember and the worker threads below). A task's worker thread is derived from
 * the world's thread when it exists, else from its fixture here; an unknown id reads as
 * removed. Ember's timers (EmberBoard.timers) are none after a reset; /__mock/ember/timer adds
 * one and thread.unsubscribe <id> cancels it. Controls: POST /__mock/ember[?enabled=],
 * /__mock/ember/task, /__mock/ember/task/add, /__mock/ember/timer, /__mock/ember/consolidating,
 * /__mock/ember/epoch; GET /__mock/ember (server.ts).
 */
import { randomBytes } from "node:crypto";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  EmberTaskState,
  type EmberBoardSchema,
  type EmberStatusSchema,
  type EmberTaskDescendantSchema,
  type EmberTaskSchema,
  type EmberTaskThreadSchema,
  type EmberTimerSchema,
} from "../src/gen/codefoundry/v1/ember_pb";
import { ThreadReportStatus, ThreadState, ThreadStatus } from "../src/gen/codefoundry/v1/thread_lifecycle_pb";
import { CommandError } from "./errors";
import { Hub } from "./hub";

export type EmberBoardInit = MessageInitShape<typeof EmberBoardSchema>;
type EmberStatusInit = MessageInitShape<typeof EmberStatusSchema>;
type EmberTaskInit = MessageInitShape<typeof EmberTaskSchema>;
type EmberTaskThreadInit = MessageInitShape<typeof EmberTaskThreadSchema>;
type EmberTaskDescendantInit = MessageInitShape<typeof EmberTaskDescendantSchema>;
type EmberTimerInit = MessageInitShape<typeof EmberTimerSchema>;

/** One of Ember's timers: a timer wake subscription of its thread. */
interface MockTimer {
  id: string;
  nextAt: Date;
  /** "2m" for a repeating timer; "" for a one-shot. */
  every: string;
  note: string;
  createdAt: Date;
}

export const EMBER_THREAD = "s-resident-ember";

/** query value -> state, for the controls. */
export const emberStateNames: Record<string, EmberTaskState> = {
  todo: EmberTaskState.TODO,
  doing: EmberTaskState.DOING,
  blocked: EmberTaskState.BLOCKED,
  done: EmberTaskState.DONE,
  cancelled: EmberTaskState.CANCELLED,
};

/** A worker thread as the world has it, for the board (World.emberThread). */
export interface EmberThreadView {
  name: string;
  state: ThreadState;
  status: ThreadStatus;
  statusReason: string;
  createdAt: Date;
  lastActivityAt: Date;
  archived: boolean;
}

/** A seeded worker thread: what World.addEmberWorkers creates, and the board's fallback while it does not exist. */
export interface EmberWorkerFixture extends EmberThreadView {
  id: string;
  /** Its creator: Ember's thread when "", else a lead (a team member). */
  createdBy?: string;
  model: string;
  brief: string;
  report: { status: ThreadReportStatus; summary: string; at: Date } | null;
}

interface MockTask {
  id: string;
  title: string;
  detail: string;
  state: EmberTaskState;
  parentId: string;
  threadId: string;
  outcome: string;
  /** The branch its worker pushed (ember task done --branch); "" for none. */
  branch: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  doneAt: Date | null;
}

const ago = (min: number) => new Date(Date.now() - min * 60_000);

/** Earlier today: two hours ago, or just after midnight when that would be yesterday. */
function earlierToday(): Date {
  const midnight = new Date();
  midnight.setHours(0, 1, 0, 0);
  return new Date(Math.max(midnight.getTime(), Date.now() - 2 * 3_600_000));
}

/** The seeded worker threads (World.addEmberWorkers adds them when Ember is enabled). */
export function emberWorkers(): EmberWorkerFixture[] {
  const today = earlierToday();
  return [
    {
      id: "s-ember-notes", name: "Release notes for 0.20", model: "claude-opus-4-7[1m]", brief: "Write docs/release-notes/0.20.md from the PRs merged since v0.19.1",
      state: ThreadState.CONNECTED, status: ThreadStatus.BUSY, statusReason: "working", createdAt: ago(25), lastActivityAt: ago(1), archived: false,
      report: { status: ThreadReportStatus.PROGRESS, summary: "Drafting the notes", at: ago(6) },
    },
    {
      id: "s-ember-wails", name: "Bump wails to v3.1", model: "claude-opus-4-8[1m]", brief: "Bump wails to v3.1 and fix what breaks",
      state: ThreadState.DISCONNECTED, status: ThreadStatus.NEEDS_ATTENTION, statusReason: "finished", createdAt: ago(80), lastActivityAt: ago(40), archived: false,
      report: { status: ThreadReportStatus.BLOCKED, summary: "wails v3.1 needs Go 1.27; the toolchain here is 1.26", at: ago(40) },
    },
    {
      id: "s-ember-flaky", name: "Fix flaky TestSendSpawnFailure", model: "claude-opus-4-7[1m]", brief: "Make TestSendSpawnFailure pass reliably under -race",
      state: ThreadState.DISCONNECTED, status: ThreadStatus.NEEDS_ATTENTION, statusReason: "finished", createdAt: new Date(today.getTime() - 50 * 60_000), lastActivityAt: today, archived: false,
      report: { status: ThreadReportStatus.DONE, summary: "Raised the spawn timeout to 5s under -race; PR #251 merged", at: today },
    },
    // A lead and its team (docs/notes/ember-fixes-1-gui.md): the lead waits on three workers it created.
    {
      id: "s-ember-lead", name: "Lead: notes API input validation", model: "claude-opus-4-8[1m]", brief: "Validate the notes API's input; split the work across a few threads",
      state: ThreadState.CONNECTED, status: ThreadStatus.IDLE, statusReason: "waiting on 2 child threads", createdAt: ago(20), lastActivityAt: ago(3), archived: false,
      report: { status: ThreadReportStatus.PROGRESS, summary: "Schema done; handlers in two threads", at: ago(3) },
    },
    {
      id: "s-ember-team-schema", createdBy: "s-ember-lead", name: "Notes API: request schema", model: "claude-opus-4-7[1m]", brief: "Define the request schema for POST and PUT /notes",
      state: ThreadState.DISCONNECTED, status: ThreadStatus.NEEDS_ATTENTION, statusReason: "finished", createdAt: ago(18), lastActivityAt: ago(6), archived: false,
      report: { status: ThreadReportStatus.DONE, summary: "Schema in internal/api/notes_schema.go", at: ago(6) },
    },
    {
      id: "s-ember-team-post", createdBy: "s-ember-lead", name: "Notes API: validate POST /notes", model: "claude-opus-4-8[1m]", brief: "Validate POST /notes against the schema",
      state: ThreadState.CONNECTED, status: ThreadStatus.BUSY, statusReason: "working", createdAt: ago(17), lastActivityAt: ago(1), archived: false,
      report: null,
    },
    {
      id: "s-ember-team-put", createdBy: "s-ember-lead", name: "Notes API: validate PUT /notes/:id", model: "claude-opus-4-7[1m]", brief: "Validate PUT /notes/:id against the schema",
      state: ThreadState.CONNECTED, status: ThreadStatus.BUSY, statusReason: "working", createdAt: ago(16), lastActivityAt: ago(2), archived: false,
      report: { status: ThreadReportStatus.PROGRESS, summary: "Rejecting unknown fields", at: ago(2) },
    },
  ];
}

function seedTasks(): MockTask[] {
  const today = earlierToday();
  const t = (o: Partial<MockTask> & Pick<MockTask, "id" | "title" | "state" | "position">, min: number): MockTask => ({
    detail: "", parentId: "", threadId: "", outcome: "", branch: "", createdAt: ago(min), updatedAt: ago(min), doneAt: null, ...o,
  });
  return [
    t({ id: "t-1a2b3c4d", title: "Add release notes for 0.20", detail: "Write docs/release-notes/0.20.md from the PRs merged since v0.19.1.", state: EmberTaskState.DOING, threadId: "s-ember-notes", position: 1, updatedAt: ago(25) }, 30),
    t({ id: "t-5e6f7a8b", title: "Link each note to its PR", state: EmberTaskState.TODO, parentId: "t-1a2b3c4d", position: 2 }, 28),
    t({ id: "t-9c0d1e2f", title: "Bump wails to v3.1", state: EmberTaskState.BLOCKED, threadId: "s-ember-wails", outcome: "wails v3.1 needs Go 1.27; the toolchain here is 1.26", position: 3, updatedAt: ago(40) }, 90),
    t({ id: "t-3a4b5c6d", title: "Fix the flaky TestSendSpawnFailure", state: EmberTaskState.DONE, threadId: "s-ember-flaky", outcome: "Raised the spawn timeout to 5s under -race; PR #251 merged", branch: "cf/spawn-timeout-race", position: 4, updatedAt: today, doneAt: today }, 200),
    t({ id: "t-7e8f9a0b", title: "Rename the agents panel to Runs", state: EmberTaskState.CANCELLED, outcome: "Alex kept the name", position: 5, updatedAt: ago(120) }, 240),
    t({ id: "t-4c5d6e7f", title: "Validate notes API input", state: EmberTaskState.DOING, threadId: "s-ember-lead", position: 6, updatedAt: ago(20) }, 20),
  ];
}

export interface EmberDeps {
  /** ember.enabled. */
  enabled: () => boolean;
  /** ember.epoch_context_tokens. */
  epochContextTokens: () => number;
  /** The resident thread's id when it exists, else "". */
  residentId: () => string;
  /** A worker thread as the world has it; undefined when it has none. */
  thread: (id: string) => EmberThreadView | undefined;
  /** The threads a thread created, oldest first (thread.new's created-by). */
  children: (id: string) => string[];
  /** The thread that created a thread; "" for none. */
  createdBy: (id: string) => string;
}

/** How many of a team the board lists (the daemon's MaxTeamList). */
const TEAM_LIST = 10;

/** A team member is working: on a turn, starting, or waiting on its own child threads (internal/store/ember/team.go). */
function teamWorking(t: EmberThreadView): boolean {
  return t.status === ThreadStatus.BUSY || t.state === ThreadState.STARTING || (t.status === ThreadStatus.IDLE && /^waiting( on |$)/.test(t.statusReason));
}

/** A team member waits on the user: a pending permission request or question while its process runs. */
function teamAsks(t: EmberThreadView): boolean {
  return t.status === ThreadStatus.NEEDS_ATTENTION && t.state !== ThreadState.DISCONNECTED && t.state !== ThreadState.CLOSING && /^(permission|question):/.test(t.statusReason);
}

export class MockEmber {
  private tasks: MockTask[] = [];
  private timers: MockTimer[] = [];
  private workers = new Map<string, EmberWorkerFixture>();
  epoch = 2;
  epochStartedAt = ago(180);
  contextTokens = 182_000;
  consolidating = false;
  lastConsolidatedAt: Date | null = null;
  lastConsolidationError = "";
  private readonly hub = new Hub<EmberBoardInit>();

  constructor(private readonly deps: EmberDeps) {}

  /** The seeded state; republished so connected WatchBoard streams converge on it. */
  reset(): void {
    this.tasks = seedTasks();
    this.timers = [];
    this.workers = new Map(emberWorkers().map((w) => [w.id, w]));
    this.epoch = 2;
    this.epochStartedAt = ago(180);
    this.contextTokens = 182_000;
    this.consolidating = false;
    this.lastConsolidatedAt = ago(185);
    this.lastConsolidationError = "";
    this.changed();
  }

  /** Every WatchBoard stream gets the board again. */
  changed(): void {
    if (this.hub.size > 0) this.hub.publish(this.board());
  }

  /** Ends every WatchBoard stream (a daemon restart). */
  endAll(): void {
    this.hub.endAll();
  }

  /** Whether a thread is a task's worker or below one (its changes change the board). */
  watches(threadId: string): boolean {
    let id = threadId;
    for (let i = 0; id !== "" && i < 9; i++) {
      if (this.tasks.some((t) => t.threadId === id)) return true;
      id = this.deps.createdBy(id);
    }
    return false;
  }

  /** WatchBoard: the board now, then again on every change. */
  watch(signal: AbortSignal): AsyncGenerator<EmberBoardInit> {
    return this.hub.subscribe(signal, [this.board()]);
  }

  status(): EmberStatusInit {
    const counts = { todo: 0, doing: 0, blocked: 0, done: 0, cancelled: 0 };
    for (const t of this.tasks) {
      const name = EmberTaskState[t.state].toLowerCase() as keyof typeof counts;
      counts[name]++;
    }
    return {
      enabled: this.deps.enabled(),
      threadId: this.deps.residentId(),
      epoch: this.epoch,
      epochStartedAt: timestampFromDate(this.epochStartedAt),
      contextTokens: BigInt(this.contextTokens),
      epochContextTokens: BigInt(this.deps.epochContextTokens()),
      consolidating: this.consolidating,
      ...(this.lastConsolidatedAt ? { lastConsolidatedAt: timestampFromDate(this.lastConsolidatedAt) } : {}),
      lastConsolidationError: this.lastConsolidationError,
      counts,
    };
  }

  /** Tasks in board order; open: todo, doing and blocked only. */
  list(open = false): EmberTaskInit[] {
    const live = [EmberTaskState.TODO, EmberTaskState.DOING, EmberTaskState.BLOCKED];
    return [...this.tasks]
      .sort((a, b) => a.position - b.position)
      .filter((t) => !open || live.includes(t.state))
      .map((t) => this.taskMsg(t));
  }

  board(): EmberBoardInit {
    return { status: this.status(), tasks: this.list(), timers: this.timerMsgs() };
  }

  /** Ember's timers, soonest first. */
  private timerMsgs(): EmberTimerInit[] {
    return [...this.timers]
      .sort((a, b) => a.nextAt.getTime() - b.nextAt.getTime())
      .map((t) => ({ id: t.id, nextAt: timestampFromDate(t.nextAt), every: t.every, note: t.note, createdAt: timestampFromDate(t.createdAt) }));
  }

  /** POST /__mock/ember/timer: a timer of Ember's thread firing in `minutes` (every: repeating, "2m"); returns its id. */
  addTimer(o: { minutes: number; every?: string; note?: string }): string {
    if (!Number.isFinite(o.minutes) || o.minutes <= 0) throw new CommandError("invalid", "minutes must be a positive number");
    const id = `sub-${randomBytes(6).toString("hex")}`;
    const now = new Date();
    this.timers.push({ id, nextAt: new Date(now.getTime() + o.minutes * 60_000), every: o.every ?? "", note: o.note ?? "", createdAt: now });
    this.changed();
    return id;
  }

  /** thread.unsubscribe <id> for one of Ember's timers: false when it is not one. */
  removeTimer(id: string): boolean {
    const before = this.timers.length;
    this.timers = this.timers.filter((t) => t.id !== id);
    if (this.timers.length === before) return false;
    this.changed();
    return true;
  }

  private taskMsg(t: MockTask): EmberTaskInit {
    return {
      id: t.id,
      title: t.title,
      detail: t.detail,
      state: t.state,
      parentId: t.parentId,
      threadId: t.threadId,
      outcome: t.outcome,
      branch: t.branch,
      position: t.position,
      createdAt: timestampFromDate(t.createdAt),
      updatedAt: timestampFromDate(t.updatedAt),
      ...(t.doneAt ? { doneAt: timestampFromDate(t.doneAt) } : {}),
      ...(t.threadId ? { thread: this.threadMsg(t.threadId, [EmberTaskState.TODO, EmberTaskState.DOING, EmberTaskState.BLOCKED].includes(t.state)) } : {}),
    };
  }

  /** A task's worker thread; with its team (the threads below it, not archived) for an open task, as the daemon derives it. */
  private threadMsg(id: string, team = false): EmberTaskThreadInit {
    const fixture = this.workers.get(id);
    const live = this.deps.thread(id) ?? fixture;
    if (!live) return { id, name: "", removed: true };
    const report = fixture?.report;
    return {
      id,
      name: live.name,
      state: live.state,
      status: live.status,
      statusReason: live.statusReason,
      ...(report ? { reportStatus: report.status, reportSummary: report.summary, reportAt: timestampFromDate(report.at) } : {}),
      createdAt: timestampFromDate(live.createdAt),
      lastActivityAt: timestampFromDate(live.lastActivityAt),
      archived: live.archived,
      ...(team ? this.team(id) : {}),
    };
  }

  /** The team below thread root: depth first, siblings oldest first, archived ones left out. */
  private team(root: string): Pick<EmberTaskThreadInit, "descendantsWorking" | "descendantsWaiting" | "descendantsTotal" | "descendants"> {
    const out = { descendantsWorking: 0, descendantsWaiting: 0, descendantsTotal: 0, descendants: [] as EmberTaskDescendantInit[] };
    const seen = new Set([root]);
    const walk = (id: string, depth: number) => {
      if (depth > 8) return;
      for (const kid of this.deps.children(id)) {
        if (seen.has(kid)) continue;
        seen.add(kid);
        const t = this.deps.thread(kid);
        if (t && !t.archived) {
          out.descendantsTotal++;
          if (teamAsks(t)) out.descendantsWaiting++;
          else if (teamWorking(t)) out.descendantsWorking++;
          if (out.descendants.length < TEAM_LIST) {
            const report = this.workers.get(kid)?.report;
            out.descendants.push({
              id: kid, name: t.name, state: t.state, status: t.status, statusReason: t.statusReason, lastActivityAt: timestampFromDate(t.lastActivityAt), depth,
              ...(report ? { reportStatus: report.status, reportSummary: report.summary } : {}),
            });
          }
        }
        walk(kid, depth + 1);
      }
    };
    walk(root, 1);
    return out;
  }

  private task(id: string): MockTask {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) throw new CommandError("notfound", `task ${id} not found`);
    return t;
  }

  /** POST /__mock/ember/task: a task's state, and its outcome and branch when given. */
  setTask(id: string, state: EmberTaskState, outcome: string | null, branch: string | null = null): EmberTaskInit {
    const t = this.task(id);
    if (state !== t.state) t.doneAt = state === EmberTaskState.DONE ? new Date() : null;
    t.state = state;
    if (outcome !== null) t.outcome = outcome;
    if (branch !== null) t.branch = branch;
    t.updatedAt = new Date();
    this.changed();
    return this.taskMsg(t);
  }

  /** POST /__mock/ember/task/add: a new task at the end of the board; returns its id. */
  addTask(o: { title: string; state?: EmberTaskState; parentId?: string; threadId?: string; detail?: string }): string {
    if (!o.title.trim()) throw new CommandError("invalid", "title is required");
    if (o.parentId) {
      const p = this.task(o.parentId);
      if (p.parentId) throw new CommandError("invalid", `task ${p.id} is itself a subtask (one level only)`);
    }
    let id: string;
    do id = `t-${randomBytes(4).toString("hex")}`;
    while (this.tasks.some((t) => t.id === id));
    const now = new Date();
    const state = o.state ?? EmberTaskState.TODO;
    this.tasks.push({
      id, title: o.title.trim(), detail: o.detail ?? "", state, parentId: o.parentId ?? "", threadId: o.threadId ?? "", outcome: "", branch: "",
      position: Math.max(0, ...this.tasks.map((t) => t.position)) + 1, createdAt: now, updatedAt: now, doneAt: state === EmberTaskState.DONE ? now : null,
    });
    this.changed();
    return id;
  }

  /** POST /__mock/ember/consolidating: on starts one; off finishes it (a fresh epoch follows, like the daemon). */
  setConsolidating(on: boolean): void {
    if (on === this.consolidating) return;
    this.consolidating = on;
    if (!on) {
      this.lastConsolidatedAt = new Date();
      this.lastConsolidationError = "";
    }
    this.changed();
  }

  /** POST /__mock/ember/epoch: a fresh session, started now, with an empty context. */
  nextEpoch(): number {
    this.epoch++;
    this.epochStartedAt = new Date();
    this.contextTokens = 0;
    this.changed();
    return this.epoch;
  }

  /** GET /__mock/ember: the board as JSON (dates as RFC 3339, enums by name). */
  json(): Record<string, unknown> {
    const s = this.status();
    return {
      status: {
        enabled: s.enabled, threadId: s.threadId, epoch: this.epoch, epochStartedAt: this.epochStartedAt.toISOString(), contextTokens: this.contextTokens,
        epochContextTokens: this.deps.epochContextTokens(), consolidating: this.consolidating, lastConsolidatedAt: this.lastConsolidatedAt?.toISOString() ?? null,
        lastConsolidationError: this.lastConsolidationError, counts: s.counts,
      },
      timers: [...this.timers].sort((a, b) => a.nextAt.getTime() - b.nextAt.getTime()).map((t) => ({ id: t.id, nextAt: t.nextAt.toISOString(), every: t.every, note: t.note })),
      tasks: [...this.tasks].sort((a, b) => a.position - b.position).map((t) => {
        const th = t.threadId ? this.threadMsg(t.threadId) : undefined;
        return {
          id: t.id, title: t.title, detail: t.detail, state: EmberTaskState[t.state].toLowerCase(), parentId: t.parentId, threadId: t.threadId, outcome: t.outcome, branch: t.branch, position: t.position,
          createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString(), doneAt: t.doneAt?.toISOString() ?? null,
          thread: th && {
            id: th.id, name: th.name, state: ThreadState[th.state ?? 0], status: ThreadStatus[th.status ?? 0], statusReason: th.statusReason ?? "",
            reportStatus: ThreadReportStatus[th.reportStatus ?? 0], reportSummary: th.reportSummary ?? "", archived: th.archived ?? false, removed: th.removed ?? false,
          },
        };
      }),
    };
  }
}
