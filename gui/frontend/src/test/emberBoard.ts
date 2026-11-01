/**
 * Ember's board for component tests, as the mock daemon seeds it (mock/ember.ts) so the
 * words match the e2e tests': the release-notes task (its worker busy, a done piece and a
 * todo one), the blocked wails bump, the done flaky-test fix and the cancelled rename
 * (both today), and the notes-API lead waiting on its team of three. Helpers change a
 * worker thread, a task or the timers the way the mock's controls do, recounting a lead's
 * team as the daemon does (internal/store/ember/team.go).
 */
import type { EmberBoardView, EmberTaskDescendantView, EmberTaskThreadView, EmberTaskView, EmberTimerView } from "@/api/ember";
import type { ThreadReportStatusView, ThreadView } from "@/api/threads";
import { useEmberStore } from "@/stores/ember";
import { useSettingsStore } from "@/stores/settings";
import { useThreadsStore } from "@/stores/threads";

export const EMBER_THREAD = "s-resident-ember";
const MIN = 60_000;

type Report = { status: ThreadReportStatusView; summary: string; atMs: number } | null;

/** A worker thread (a task's, or a lead's team member) as the world has it. */
interface Worker {
  id: string;
  name: string;
  state: EmberTaskThreadView["state"];
  status: EmberTaskThreadView["status"];
  statusReason: string;
  createdAtMs: number;
  lastActivityAtMs: number;
  report: Report;
  /** The lead that created it; "" for a task's own worker. */
  createdBy: string;
}

/** Earlier today: two hours ago, or just after midnight when that would be yesterday. */
function earlierToday(now: number): number {
  const midnight = new Date(now);
  midnight.setHours(0, 1, 0, 0);
  return Math.max(midnight.getTime(), now - 2 * 3_600_000);
}

function workers(now: number): Worker[] {
  const ago = (m: number) => now - m * MIN;
  const today = earlierToday(now);
  const w = (o: Omit<Worker, "createdBy"> & { createdBy?: string }): Worker => ({ createdBy: "", ...o });
  return [
    w({ id: "s-ember-notes", name: "Release notes for 0.20", state: "connected", status: "busy", statusReason: "working", createdAtMs: ago(25), lastActivityAtMs: ago(1), report: { status: "progress", summary: "Drafting the notes", atMs: ago(6) } }),
    w({
      id: "s-ember-wails",
      name: "Bump wails to v3.1",
      state: "disconnected",
      status: "attention",
      statusReason: "finished",
      createdAtMs: ago(80),
      lastActivityAtMs: ago(40),
      report: { status: "blocked", summary: "wails v3.1 needs Go 1.27; the toolchain here is 1.26", atMs: ago(40) },
    }),
    w({
      id: "s-ember-flaky",
      name: "Fix flaky TestSendSpawnFailure",
      state: "disconnected",
      status: "attention",
      statusReason: "finished",
      createdAtMs: today - 50 * MIN,
      lastActivityAtMs: today,
      report: { status: "done", summary: "Raised the spawn timeout to 5s under -race; PR #251 merged", atMs: today },
    }),
    w({
      id: "s-ember-lead",
      name: "Lead: notes API input validation",
      state: "connected",
      status: "idle",
      statusReason: "waiting on 2 child threads",
      createdAtMs: ago(20),
      lastActivityAtMs: ago(3),
      report: { status: "progress", summary: "Schema done; handlers in s-ember-team-post and s-ember-team-put", atMs: ago(3) },
    }),
    w({
      id: "s-ember-team-schema",
      createdBy: "s-ember-lead",
      name: "Notes API: request schema",
      state: "disconnected",
      status: "attention",
      statusReason: "finished",
      createdAtMs: ago(18),
      lastActivityAtMs: ago(6),
      report: { status: "done", summary: "Schema in internal/api/notes_schema.go", atMs: ago(6) },
    }),
    w({ id: "s-ember-team-post", createdBy: "s-ember-lead", name: "Notes API: validate POST /notes", state: "connected", status: "busy", statusReason: "working", createdAtMs: ago(17), lastActivityAtMs: ago(1), report: null }),
    w({
      id: "s-ember-team-put",
      createdBy: "s-ember-lead",
      name: "Notes API: validate PUT /notes/:id",
      state: "connected",
      status: "busy",
      statusReason: "working",
      createdAtMs: ago(16),
      lastActivityAtMs: ago(2),
      report: { status: "progress", summary: "Rejecting unknown fields", atMs: ago(2) },
    }),
  ];
}

type TaskSeed = Omit<EmberTaskView, "thread">;

function tasks(now: number): TaskSeed[] {
  const ago = (m: number) => now - m * MIN;
  const today = earlierToday(now);
  const t = (o: Partial<TaskSeed> & Pick<TaskSeed, "id" | "title" | "state" | "position">, min: number): TaskSeed => ({
    detail: "",
    parentId: "",
    threadId: "",
    outcome: "",
    branch: "",
    createdAtMs: ago(min),
    updatedAtMs: ago(min),
    doneAtMs: null,
    ...o,
  });
  return [
    t({ id: "t-1a2b3c4d", title: "Add release notes for 0.20", state: "doing", threadId: "s-ember-notes", position: 1, updatedAtMs: ago(25) }, 30),
    t(
      { id: "t-2b3c4d5e", title: "List the PRs merged since v0.19.1", state: "done", parentId: "t-1a2b3c4d", outcome: "42 PRs in docs/release-notes/prs.txt", branch: "cf/release-notes-prs", position: 2, updatedAtMs: ago(20), doneAtMs: ago(20) },
      29,
    ),
    t({ id: "t-5e6f7a8b", title: "Link each note to its PR", state: "todo", parentId: "t-1a2b3c4d", position: 2 }, 28),
    t({ id: "t-9c0d1e2f", title: "Bump wails to v3.1", state: "blocked", threadId: "s-ember-wails", outcome: "wails v3.1 needs Go 1.27; the toolchain here is 1.26", position: 3, updatedAtMs: ago(40) }, 90),
    t(
      {
        id: "t-3a4b5c6d",
        title: "Fix the flaky TestSendSpawnFailure",
        state: "done",
        threadId: "s-ember-flaky",
        outcome: "Raised the spawn timeout to 5s under -race; PR #251 merged",
        branch: "cf/spawn-timeout-race",
        position: 4,
        updatedAtMs: today,
        doneAtMs: today,
      },
      200,
    ),
    t({ id: "t-7e8f9a0b", title: "Rename the agents panel to Runs", state: "cancelled", outcome: "The user kept the name", position: 5, updatedAtMs: today }, 240),
    t({ id: "t-4c5d6e7f", title: "Validate notes API input", state: "doing", threadId: "s-ember-lead", position: 6, updatedAtMs: ago(20) }, 20),
  ];
}

/** A team member works: starting, on a turn while its process runs, or waiting on child threads of its own. */
function teamWorking(w: Worker): boolean {
  if (w.state === "starting") return true;
  if (w.status === "idle") return /^waiting on [1-9]\d* child thread/.test(w.statusReason);
  return w.status === "busy" && w.state !== "disconnected" && w.state !== "closing";
}

/** A team member waits on the user: a pending permission request or question while its process runs. */
function teamAsks(w: Worker): boolean {
  return w.status === "attention" && w.state !== "disconnected" && w.state !== "closing" && /^(permission|question):/.test(w.statusReason);
}

/** The world behind a board: tasks, worker threads and timers, which tests change and publish. */
export class EmberWorld {
  tasks: TaskSeed[];
  workers: Worker[];
  timers: EmberTimerView[] = [];

  constructor(readonly now = Date.now()) {
    this.tasks = tasks(now);
    this.workers = workers(now);
  }

  private threadOf(id: string, open: boolean): EmberTaskThreadView {
    const w = this.workers.find((x) => x.id === id);
    if (!w) throw new Error(`no worker ${id}`);
    const team = open ? this.workers.filter((x) => x.createdBy === id) : [];
    const descendants: EmberTaskDescendantView[] = team.map((x) => ({
      id: x.id,
      name: x.name,
      state: x.state,
      status: x.status,
      statusReason: x.statusReason,
      reportStatus: x.report?.status ?? null,
      reportSummary: x.report?.summary ?? "",
      lastActivityAtMs: x.lastActivityAtMs,
      depth: 1,
    }));
    return {
      id,
      name: w.name,
      state: w.state,
      status: w.status,
      statusReason: w.statusReason,
      reportStatus: w.report?.status ?? null,
      reportSummary: w.report?.summary ?? "",
      reportAtMs: w.report?.atMs ?? null,
      createdAtMs: w.createdAtMs,
      lastActivityAtMs: w.lastActivityAtMs,
      archived: false,
      removed: false,
      descendantsWorking: team.filter((x) => !teamAsks(x) && teamWorking(x)).length,
      descendantsWaiting: team.filter(teamAsks).length,
      descendantsTotal: team.length,
      descendants,
    };
  }

  board(): EmberBoardView {
    const counts = { todo: 0, doing: 0, blocked: 0, done: 0, cancelled: 0 };
    for (const t of this.tasks) counts[t.state]++;
    const open = (t: TaskSeed) => t.state === "todo" || t.state === "doing" || t.state === "blocked";
    return {
      status: { enabled: true, threadId: EMBER_THREAD, epoch: 2, consolidating: false, counts },
      tasks: [...this.tasks].sort((a, b) => a.position - b.position).map((t) => ({ ...t, thread: t.threadId ? this.threadOf(t.threadId, open(t)) : null })),
      timers: [...this.timers].sort((a, b) => (a.nextAtMs ?? 0) - (b.nextAtMs ?? 0)),
    };
  }

  /** Sends the board, as WatchBoard does on every change. */
  publish(): void {
    useEmberStore.setState({ board: this.board(), error: null });
  }

  /** POST /__mock/thread/status: a worker's status and its reason. */
  status(id: string, status: Worker["status"], statusReason = ""): void {
    const w = this.workers.find((x) => x.id === id);
    if (!w) throw new Error(`no worker ${id}`);
    w.status = status;
    w.statusReason = statusReason;
    w.lastActivityAtMs = Date.now();
    this.publish();
  }

  /** POST /__mock/ember/report: a worker's report, filed now. */
  report(id: string, status: ThreadReportStatusView, summary: string): void {
    const w = this.workers.find((x) => x.id === id);
    if (!w) throw new Error(`no worker ${id}`);
    w.report = { status, summary, atMs: Date.now() };
    this.publish();
  }

  /** POST /__mock/ember/task: a task's state, and its outcome and title when given. */
  task(id: string, o: Partial<Pick<TaskSeed, "state" | "outcome" | "title" | "branch">>): void {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`no task ${id}`);
    if (o.state && o.state !== t.state) t.doneAtMs = o.state === "done" ? Date.now() : null;
    Object.assign(t, o, { updatedAtMs: Date.now() });
    this.publish();
  }

  /** POST /__mock/ember/task/add: a todo task at the end. */
  addTask(id: string, title: string): void {
    this.tasks.push({ id, title, detail: "", state: "todo", parentId: "", threadId: "", outcome: "", branch: "", position: this.tasks.length + 1, createdAtMs: Date.now(), updatedAtMs: Date.now(), doneAtMs: null });
    this.publish();
  }

  /** POST /__mock/ember/timer: a timer of Ember's thread firing in `minutes`. */
  addTimer(id: string, minutes: number, o: { every?: string; note?: string } = {}): void {
    this.timers.push({ id, nextAtMs: Date.now() + minutes * MIN, every: o.every ?? "", note: o.note ?? "" });
    this.publish();
  }

  removeTimer(id: string): void {
    this.timers = this.timers.filter((t) => t.id !== id);
    this.publish();
  }
}

/** Turns Ember on (or off) in the settings snapshot. */
export function setEmberEnabled(on: boolean): void {
  useSettingsStore.setState({ snapshot: { values: { "ember.enabled": on ? "true" : "false" } } as never });
}

/** Ember's resident thread in the thread list (idle at its prompt, as the mock has it), with `others` beside it. */
export function putEmberThread(o: Partial<ThreadView> = {}, others: ThreadView[] = []): void {
  const ember = {
    id: EMBER_THREAD,
    name: "Ember",
    resident: "ember",
    projectId: "",
    workspaceId: "",
    worktreePath: "/Users/dev/.code-foundry/ember",
    pendingWorktreePath: "",
    state: "disconnected",
    status: "idle",
    statusReason: "",
    archivedAtMs: null,
    linkedPullRequests: [],
    usage: [],
    agentRuns: [],
    ...o,
  } as unknown as ThreadView;
  const all = [ember, ...others];
  useThreadsStore.setState({ byId: Object.fromEntries(all.map((t) => [t.id, t])), order: others.map((t) => t.id), owned: [EMBER_THREAD] });
}
