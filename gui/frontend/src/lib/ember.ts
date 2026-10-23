/**
 * Ember in the GUI (docs/notes/ember-3-gui.md), pure: the flame's state, the board's
 * sections and cards, the words the pinned row, the chat header and a task link say, the
 * task links in Ember's text, and the chat's rows, where every run of work between two
 * visible messages folds into one "Worked for" row.
 */
import type { EmberTaskDescendantView, EmberTaskStateView, EmberTaskThreadView, EmberTaskView, EmberTimerView } from "@/api/ember";
import type { ThreadItemView, WakeView } from "@/api/thread";
import type { ThreadStateView, ThreadStatusView } from "@/api/threads";
import { statusLine, type StatusTone } from "./statusLine";
import { threadBadge } from "./thread";
import { snoozeTimeShort } from "./snooze";
import { waitingCount } from "./waiting";
import { AGENT_TOOLS, EXPLORE_TOOLS, workNodes, type TimelineItem, type TimelineRow, type WorkNode } from "./threadTimeline";

// ---------- the flame ----------

/** idle: slow wobble, dim; thinking: Ember is on a turn; working: its workers are; attention: it has something for the user. */
export type FlameState = "idle" | "thinking" | "working" | "attention";

/**
 * The flame's state for Ember's thread, the number of worker threads working
 * (workingThreads: on a turn, starting, or a lead waiting on its own running children)
 * and of workers waiting on the user: needs attention (a prompt, a reply the user has not
 * seen: the daemon's finished-turn attention, cleared when the chat is open; or a
 * worker's prompt, cleared only by answering it) wins, then busy (thinking), then a
 * working worker (working). A doing task whose worker is idle (it reported done and
 * waits on Ember's check) leaves the flame idle.
 */
export function flameState(t: { state: ThreadStateView; status: ThreadStatusView } | undefined, working: number, waiting = 0): FlameState {
  if (t?.status === "attention" || waiting > 0) return "attention";
  if (t && threadBadge(t) === "busy") return "thinking";
  return working > 0 ? "working" : "idle";
}

// ---------- worker threads ----------

/** A worker thread as the board's words read it: a task's thread or one of its team. */
type WorkerLike = Pick<EmberTaskThreadView, "state" | "status" | "statusReason" | "reportStatus" | "reportSummary"> & { archived?: boolean; removed?: boolean };

/**
 * A task's worker is working: on a turn, starting, or waiting on its own child threads
 * (a lead whose workers run: "waiting on 2 child threads"); not archived or removed. A
 * bare "waiting" (only a wake queued to it, which a failed start may hold) names no
 * child and is not working; nor is an idle worker whose task is still doing. The
 * daemon's rule is the same (internal/store/ember/team.go working).
 */
export function workerBusy(th: WorkerLike | null): boolean {
  if (th === null || th.archived === true || th.removed === true || th.status === "attention") return false;
  return threadBadge(th) === "busy" || waitingCount(th) > 0;
}

/** A worker waits on the user: a pending permission request or question (the sidebar's "Needs input"). */
export function workerAsks(th: WorkerLike | null): boolean {
  if (th === null || th.archived === true || th.removed === true) return false;
  const kind = statusLine({ ...th, statusChangedAtMs: null }).kind;
  return kind === "input" || kind === "question";
}

export interface Words {
  text: string;
  tone: StatusTone;
}

/**
 * A worker thread's status in the sidebar's words and colours (lib/lineage's set), or
 * archived / removed. A lead waiting on its child threads is Working: its team is.
 */
export function workerWords(th: Pick<WorkerLike, "state" | "status" | "statusReason" | "archived" | "removed">): Words {
  if (th.removed === true) return { text: "Removed", tone: "muted" };
  if (th.archived === true) return { text: "Archived", tone: "muted" };
  const budget = budgetStop(th);
  if (budget !== null) return { text: budget ? `Stopped at budget · ${budget}` : "Stopped at budget", tone: "amber" };
  switch (statusLine({ ...th, statusChangedAtMs: null }).kind) {
    case "working":
      return { text: "Working", tone: "sky" };
    case "waiting":
      // A lead waiting on its children; a bare "waiting" names none (workerBusy).
      return waitingCount(th) > 0 ? { text: "Working", tone: "sky" } : { text: "Idle", tone: "muted" };
    case "input":
    case "question":
    case "plan":
    case "snoozeEnded":
    case "flagAttention":
      return { text: "Needs input", tone: "amber" };
    case "finished":
      return { text: "Finished", tone: "emerald" };
    case "error":
    case "interrupted":
    case "crashed":
    case "flagError":
      return { text: "Error", tone: "red" };
    case "place":
      return { text: "Idle", tone: "muted" };
  }
}

/** The words of a worker waiting on the user. */
const NEEDS_INPUT: Words = { text: "Needs input", tone: "amber" };

/** The budget stop's status reason (internal/store/thread/budget.go); a daemon may put the amount after it. */
const BUDGET_REASON = /^budget reached\b/;
const BUDGET_AMOUNT = /\$\d+(?:\.\d+)?(?:\s+of\s+\$\d+(?:\.\d+)?)?/;

/**
 * A thread the budget stop interrupted (needs attention "budget reached"): the amount its
 * reason carries ("$0.21 of $0.20"), "" when it carries none; null for any other status.
 */
export function budgetStop(th: Pick<WorkerLike, "status" | "statusReason">): string | null {
  if (th.status !== "attention" || !BUDGET_REASON.test(th.statusReason)) return null;
  return BUDGET_AMOUNT.exec(th.statusReason)?.[0] ?? "";
}

/** A task's state in a card's or a worker row's words. */
const stateWords: Readonly<Record<EmberTaskStateView, string>> = {
  todo: "queued",
  doing: "in progress",
  blocked: "blocked",
  done: "done",
  cancelled: "cancelled",
};

/** A task's state in a task link's words (where it sits on the board). */
const linkWords: Readonly<Record<EmberTaskStateView, string>> = {
  todo: "up next",
  doing: "in progress",
  blocked: "blocked",
  done: "done",
  cancelled: "cancelled",
};

/** A task's dot: sky doing, amber blocked, emerald done, a muted ring for todo and cancelled. */
export type TaskDot = "doing" | "blocked" | "done" | "open";

export function taskDot(state: EmberTaskStateView): TaskDot {
  return state === "doing" ? "doing" : state === "blocked" ? "blocked" : state === "done" ? "done" : "open";
}

// ---------- the board ----------

/** A card: a top-level task and its subtasks, in board order. */
export interface BoardCard {
  task: EmberTaskView;
  subtasks: EmberTaskView[];
}

export interface BoardSections {
  /** Doing and blocked. */
  inProgress: BoardCard[];
  /** Todo. */
  upNext: BoardCard[];
  /** Done or cancelled since local midnight. */
  doneToday: BoardCard[];
}

/** Local midnight before `now`. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Top-level tasks as cards with their subtasks (a subtask whose parent is not on the board is a card of its own). */
export function boardCards(tasks: readonly EmberTaskView[]): BoardCard[] {
  const ids = new Set(tasks.map((t) => t.id));
  const subs = new Map<string, EmberTaskView[]>();
  for (const t of tasks) {
    if (t.parentId === "" || !ids.has(t.parentId)) continue;
    const list = subs.get(t.parentId) ?? [];
    list.push(t);
    subs.set(t.parentId, list);
  }
  return tasks.filter((t) => t.parentId === "" || !ids.has(t.parentId)).map((task) => ({ task, subtasks: subs.get(task.id) ?? [] }));
}

/** The board's sections: a card sits where its own task's state puts it; earlier done and cancelled tasks are left out. */
export function boardSections(tasks: readonly EmberTaskView[], now: number): BoardSections {
  const midnight = startOfDay(now);
  const out: BoardSections = { inProgress: [], upNext: [], doneToday: [] };
  for (const c of boardCards(tasks)) {
    const t = c.task;
    if (t.state === "doing" || t.state === "blocked") out.inProgress.push(c);
    else if (t.state === "todo") out.upNext.push(c);
    else if ((t.doneAtMs ?? t.updatedAtMs ?? 0) >= midnight) out.doneToday.push(c);
  }
  return out;
}

/** A parent's progress: its done subtasks of those not cancelled. */
export function cardProgress(c: BoardCard): { done: number; total: number } | null {
  if (c.subtasks.length === 0) return null;
  const counted = c.subtasks.filter((s) => s.state !== "cancelled");
  return { done: counted.filter((s) => s.state === "done").length, total: counted.length };
}

/**
 * A card's right side: "x of y" for a parent, else "reported done" while the task waits
 * on Ember's check, else its worker's status words (Needs input while one of a lead's
 * team asks), else its state.
 */
export function cardMeta(c: BoardCard): Words {
  const p = cardProgress(c);
  if (p) return { text: `${String(p.done)} of ${String(p.total)}`, tone: "muted" };
  const t = c.task;
  if (t.state === "done" || t.state === "cancelled" || t.state === "todo") return { text: stateWords[t.state], tone: "muted" };
  if (t.state === "blocked") return { text: stateWords.blocked, tone: "amber" };
  if (unclosed(t, c.subtasks) === "report" && t.thread?.reportStatus) return reportedWords(t.thread.reportStatus);
  if (t.thread) {
    const words = workerWords(t.thread);
    return t.thread.descendantsWaiting > 0 && words.tone !== "red" ? NEEDS_INPUT : words;
  }
  return { text: stateWords[t.state], tone: "muted" };
}

/** A worker row under a card: the task's own worker, or a subtask with its worker. */
export interface WorkerRow {
  key: string;
  /** The thread a click opens; "" when none (a subtask without a worker, a removed one). */
  threadId: string;
  title: string;
  dot: TaskDot;
  /** The worker's report summary, else its status words, else the subtask's state. */
  meta: Words;
  /** When the worker last did something (else the subtask's last change), for the age. */
  atMs: number | null;
  /** A done subtask's branch (ember task done --branch); "" for none. */
  branch: string;
  /** A done or cancelled subtask's outcome (what the piece came to); "" for none. Drawn under the row with the branch. */
  outcome: string;
  subtask: boolean;
  /** 0 for a task's own worker or a subtask; 1+ for a thread of a lead's team, by how far below the lead it is. */
  depth: number;
}

/**
 * A worker row's dot: sky while it works, amber while it waits on the user; under a doing
 * task an idle worker's dot says what it is (emerald once it reported done, a muted ring
 * otherwise), not the task's sky; else the task's.
 */
function workerDot(th: WorkerLike, state: EmberTaskStateView): TaskDot {
  if (workerBusy(th)) return "doing";
  if (workerAsks(th)) return "blocked";
  if (state === "doing") return th.reportStatus === "done" ? "done" : "open";
  return taskDot(state);
}

/**
 * A worker row's words: a blocked or failed report says so (amber, red); a prompt or an
 * error says more than a report; while the task is doing, its latest report's summary
 * (muted) says more than "Working" or "Idle"; else the worker's status words.
 */
function workerMeta(th: WorkerLike, doing: boolean, names: ReadonlyMap<string, string>): Words {
  const words = workerWords(th);
  if (words.tone === "amber" || words.tone === "red") return words;
  if (th.reportStatus === "blocked") return { text: "Blocked", tone: "amber" };
  if (th.reportStatus === "failed") return { text: "Failed", tone: "red" };
  if (doing && th.reportSummary) return { text: withNames(th.reportSummary, names), tone: "muted" };
  return words;
}

/** A thread id in a report ("6 workers started: s-b9fb31a8c2d1, …"). */
const THREAD_ID = /\bs-[0-9a-z][0-9a-z-]*[0-9a-z]\b/g;

/** `text` with the thread ids it names replaced by those threads' names, where `names` has them. */
export function withNames(text: string, names: ReadonlyMap<string, string>): string {
  if (names.size === 0 || !text.includes("s-")) return text;
  return text.replace(THREAD_ID, (id) => names.get(id) || id);
}

/** The names of the card's threads (its workers and their teams), by id: what a lead's report names. */
function cardNames(c: BoardCard): Map<string, string> {
  const names = new Map<string, string>();
  for (const t of [c.task, ...c.subtasks]) {
    const th = t.thread;
    if (!th) continue;
    if (th.name) names.set(th.id, th.name);
    for (const d of th.descendants) if (d.name) names.set(d.id, d.name);
  }
  return names;
}

/** Two titles say the same thing: the same words, case and punctuation aside. */
function sameTitle(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return norm(a) === norm(b);
}

/**
 * A task's own worker row's title: the thread's name, unless it repeats the task's title
 * above it (Ember names a worker after its task): then "Worker", or "Lead" with a team.
 */
function ownTitle(th: EmberTaskThreadView, task: EmberTaskView): string {
  if (th.name && !sameTitle(th.name, task.title)) return th.name;
  if (!th.name && th.removed) return th.id;
  return th.descendantsTotal > 0 ? "Lead" : "Worker";
}

/**
 * A lead's team under its row, while its task is doing or blocked: the daemon's first ten
 * threads below it (tree order, indented by depth), then "+N more" for the rest. Threads
 * a subtask row already shows are left out.
 */
function teamRows(th: EmberTaskThreadView, t: EmberTaskView, shown: ReadonlySet<string>, names: ReadonlyMap<string, string>): WorkerRow[] {
  if (t.state !== "doing" && t.state !== "blocked") return [];
  const rows = th.descendants
    .filter((d) => !shown.has(d.id))
    .map(
      (d: EmberTaskDescendantView): WorkerRow => ({
        key: `d:${t.id}:${d.id}`,
        threadId: d.id,
        title: d.name || d.id,
        dot: workerDot(d, t.state),
        meta: workerMeta(d, t.state === "doing", names),
        atMs: d.lastActivityAtMs,
        branch: "",
        outcome: "",
        subtask: false,
        depth: Math.max(1, d.depth),
      }),
    );
  const more = th.descendantsTotal - th.descendants.length;
  if (more > 0)
    rows.push({ key: `d:${t.id}:more`, threadId: "", title: `+${String(more)} more ${more === 1 ? "thread" : "threads"}`, dot: "open", meta: { text: "", tone: "muted" }, atMs: null, branch: "", outcome: "", subtask: false, depth: 1 });
  return rows;
}

/** A subtask row's words: a blocked one's outcome (amber); its worker's while it is open; else its state (a done one's outcome goes under it). */
function subtaskMeta(s: EmberTaskView, names: ReadonlyMap<string, string>): Words {
  const th = s.thread;
  if (s.state === "blocked" && s.outcome) return { text: s.outcome, tone: "amber" };
  if (th && (s.state === "doing" || s.state === "blocked")) return workerMeta(th, s.state === "doing", names);
  return { text: stateWords[s.state], tone: "muted" };
}

export function workerRows(c: BoardCard): WorkerRow[] {
  const rows: WorkerRow[] = [];
  const names = cardNames(c);
  // Subtasks' workers have rows of their own: a lead's team does not repeat them.
  const shown = new Set(c.subtasks.flatMap((s) => (s.thread ? [s.thread.id] : [])));
  const own = c.task.thread;
  if (own) {
    rows.push({
      key: `w:${c.task.id}`,
      threadId: own.removed ? "" : own.id,
      title: ownTitle(own, c.task),
      dot: workerDot(own, c.task.state),
      meta: workerMeta(own, c.task.state === "doing", names),
      atMs: own.lastActivityAtMs,
      branch: "",
      outcome: "",
      subtask: false,
      depth: 0,
    });
    rows.push(...teamRows(own, c.task, shown, names));
  }
  for (const s of c.subtasks) {
    const th = s.thread;
    rows.push({
      key: `s:${s.id}`,
      threadId: th && !th.removed ? th.id : "",
      title: s.title,
      dot: th && (s.state === "doing" || s.state === "blocked") ? workerDot(th, s.state) : taskDot(s.state),
      meta: subtaskMeta(s, names),
      atMs: th?.lastActivityAtMs ?? s.updatedAtMs,
      branch: s.state === "done" ? s.branch : "",
      outcome: s.state === "done" || s.state === "cancelled" ? s.outcome : "",
      subtask: true,
      depth: 0,
    });
    if (th) rows.push(...teamRows(th, s, shown, names));
  }
  return rows;
}

/** A worker row's age, labelled: "updated just now", "updated 4m ago". */
export function updatedAgo(atMs: number, now: number): string {
  const m = Math.floor(Math.max(0, now - atMs) / 60_000);
  if (m < 1) return "updated just now";
  if (m < 60) return `updated ${String(m)}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `updated ${String(h)}h ago` : `updated ${String(Math.floor(h / 24))}d ago`;
}

/**
 * Distinct threads matching `is` over the tasks' worker threads and their teams (a
 * subtask's worker may sit in its parent lead's team too). The daemon lists ten of a
 * team; its counts (`extra` of a thread) cover the rest.
 */
function countThreads(tasks: readonly EmberTaskView[], is: (th: WorkerLike) => boolean, extra: (th: EmberTaskThreadView) => number, only: (t: EmberTaskView) => boolean): number {
  const ids = new Set<string>();
  const seen = new Set<string>();
  let unlisted = 0;
  for (const t of tasks) {
    const th = t.thread;
    if (!th || !only(t)) continue;
    if (is(th)) ids.add(th.id);
    if (seen.has(th.id)) continue;
    seen.add(th.id);
    const listed = th.descendants.filter(is);
    for (const d of listed) ids.add(d.id);
    unlisted += Math.max(0, extra(th) - listed.length);
  }
  return ids.size + unlisted;
}

/** Distinct threads that are working, over the given tasks: their workers (a lead waiting on its team included) and the leads' teams. */
export function workingThreads(tasks: readonly EmberTaskView[]): number {
  return countThreads(tasks, workerBusy, (th) => th.descendantsWorking, () => true);
}

/**
 * Threads waiting on the user's answer (a permission request or question) among the
 * workers of doing and blocked tasks and their teams: the pinned row's "Needs input" and
 * Ember's place in the bell. Only answering clears it, not opening Ember's chat.
 */
export function waitingThreads(tasks: readonly EmberTaskView[]): number {
  return countThreads(tasks, workerAsks, (th) => th.descendantsWaiting, (t) => t.state === "doing" || t.state === "blocked");
}

/** A task's worker, or one of its team, waits on the user. */
function taskAsks(t: EmberTaskView): boolean {
  return t.thread !== null && (workerAsks(t.thread) || t.thread.descendantsWaiting > 0 || t.thread.descendants.some(workerAsks));
}

/**
 * Blocked tasks the user may need to look at: blocked ones with no blocked subtask (a parent
 * blocked because all its pieces are counts as its pieces), leaving out those whose worker
 * waits on the user (waitingThreads counts them).
 */
export function blockedTasks(tasks: readonly EmberTaskView[]): number {
  const parents = new Set(tasks.filter((t) => t.state === "blocked" && t.parentId !== "").map((t) => t.parentId));
  return tasks.filter((t) => t.state === "blocked" && !parents.has(t.id) && !taskAsks(t)).length;
}

// ---------- unclosed: waiting on Ember alone ----------

/**
 * Why an open task waits on Ember and on nothing else (docs/notes/ember-fixes-3-board.md;
 * the daemon's ember.Unclosed): "report", it is doing and its worker reported (done,
 * failed or blocked) and is idle with its team (Ember checks the work, then closes or
 * blocks it); "pieces", a parent whose pieces are all done or cancelled (Ember closes it);
 * null otherwise. The board leaves out a report from before the task last changed, so a
 * reopened task is not unclosed by its old report.
 */
export type Unclosed = "report" | "pieces" | null;

export function unclosed(t: EmberTaskView, tasks: readonly EmberTaskView[]): Unclosed {
  if (t.state !== "todo" && t.state !== "doing" && t.state !== "blocked") return null;
  const pieces = tasks.filter((x) => x.parentId === t.id);
  if (pieces.length > 0) return pieces.every((x) => x.state === "done" || x.state === "cancelled") ? "pieces" : null;
  const th = t.thread;
  if (t.state !== "doing" || !th || th.removed) return null;
  if (th.reportStatus !== "done" && th.reportStatus !== "failed" && th.reportStatus !== "blocked") return null;
  // An archived worker counts as idle: its report still waits on the check.
  const live = { ...th, archived: false };
  const teamWorks = th.descendantsWorking > 0 || th.descendants.some(workerBusy);
  return workerBusy(live) || workerAsks(live) || teamWorks || th.descendantsWaiting > 0 ? null : "report";
}

/** A worker's report on a task that waits on Ember's check: "reported done" (emerald), "reported failed" (red), "reported blocked" (amber). */
function reportedWords(status: "done" | "failed" | "blocked" | "progress"): Words {
  return { text: `reported ${status}`, tone: status === "done" ? "emerald" : status === "failed" ? "red" : "amber" };
}

/** The board's sentence for a task that waits on Ember alone ("Worker reported done, waiting for Ember to check"); "" for any other. */
export function unclosedWords(t: EmberTaskView, tasks: readonly EmberTaskView[]): string {
  switch (unclosed(t, tasks)) {
    case "report":
      return `Worker reported ${t.thread?.reportStatus ?? "done"}, waiting for Ember to check`;
    case "pieces":
      return "All pieces closed, waiting for Ember to close it";
    case null:
      return "";
  }
}

/** Tasks waiting on Ember alone (unclosed): the header's "N to check", the pinned row's To check. */
export function unclosedTasks(tasks: readonly EmberTaskView[]): number {
  return tasks.filter((t) => unclosed(t, tasks) !== null).length;
}

/** Whether a task's work goes on: its worker, a thread of its team or one of its doing pieces' works. */
function taskWorks(t: EmberTaskView, tasks: readonly EmberTaskView[]): boolean {
  return workingThreads([t, ...tasks.filter((x) => x.parentId === t.id && x.state === "doing")]) > 0;
}

/** The chat header's dot: amber while something waits on the user (a question, a blocked task), sky while workers run. */
export type HeaderDot = "amber" | "sky" | "";

/**
 * The chat header's summary, "1 needs you · 2 threads working · 1 to check · 1 blocked ·
 * 1 queued · 1 scheduled" (workers waiting on the user, working threads, tasks waiting on
 * Ember alone, blocked tasks, todo tasks and Ember's pending timers), and its dot. With
 * none of those, a doing task still says "1 in progress" (its worker is idle without a
 * report), so the header never says less than the board; "" only when nothing goes on.
 */
export function headerSummary(tasks: readonly EmberTaskView[], timers = 0): { text: string; dot: HeaderDot } {
  const waiting = waitingThreads(tasks);
  const working = workingThreads(tasks);
  const toCheck = unclosedTasks(tasks);
  const blocked = blockedTasks(tasks);
  const queued = tasks.filter((t) => t.state === "todo" && unclosed(t, tasks) === null).length;
  const parts: string[] = [];
  if (waiting > 0) parts.push(`${String(waiting)} ${waiting === 1 ? "needs" : "need"} you`);
  if (working > 0) parts.push(`${String(working)} ${working === 1 ? "thread" : "threads"} working`);
  if (toCheck > 0) parts.push(`${String(toCheck)} to check`);
  if (blocked > 0) parts.push(`${String(blocked)} blocked`);
  if (queued > 0) parts.push(`${String(queued)} queued`);
  if (timers > 0) parts.push(`${String(timers)} scheduled`);
  const doing = tasks.filter((t) => t.state === "doing").length;
  if (parts.length === 0 && doing > 0) parts.push(`${String(doing)} in progress`);
  const dot: HeaderDot = waiting > 0 || blocked > 0 ? "amber" : working > 0 ? "sky" : "";
  return { text: parts.join(" · "), dot };
}

/** The first doing task's title (a top-level one first). */
export function firstDoingTitle(tasks: readonly EmberTaskView[]): string {
  return (tasks.find((t) => t.state === "doing" && t.parentId === "") ?? tasks.find((t) => t.state === "doing"))?.title ?? "";
}

/**
 * The task whose worker waits on the user (a subtask's own worker before a lead whose team
 * member asks), "+N" after it when more threads wait; "" when none does.
 */
export function waitingTitle(tasks: readonly EmberTaskView[]): string {
  const open = tasks.filter((t) => t.state === "doing" || t.state === "blocked");
  const t = open.find((x) => x.thread !== null && workerAsks(x.thread)) ?? open.find(taskAsks);
  if (!t) return "";
  const more = waitingThreads(tasks) - 1;
  return more > 0 ? `${t.title} +${String(more)}` : t.title;
}

/**
 * The pinned row's line 2: the task a waiting worker belongs to, else the first doing
 * task whose work goes on, else the first task waiting on Ember alone, else the first
 * doing task, else the first blocked one (a piece, not its rolled-up parent). The order
 * follows emberStatusWords', so the title is the task the status is about.
 */
export function rowTitle(tasks: readonly EmberTaskView[]): string {
  const waiting = waitingTitle(tasks);
  if (waiting) return waiting;
  const doing = tasks.filter((t) => t.state === "doing");
  const works = doing.find((t) => t.parentId === "" && taskWorks(t, tasks)) ?? doing.find((t) => taskWorks(t, tasks));
  if (works) return works.title;
  const check = tasks.find((t) => t.parentId === "" && unclosed(t, tasks) !== null) ?? tasks.find((t) => unclosed(t, tasks) !== null);
  if (check) return check.title;
  const first = firstDoingTitle(tasks);
  if (first) return first;
  const parents = new Set(tasks.filter((t) => t.state === "blocked" && t.parentId !== "").map((t) => t.parentId));
  return tasks.find((t) => t.state === "blocked" && !parents.has(t.id))?.title ?? "";
}

/** Ember's own thread, as the pinned row reads it. */
type EmberThreadLike = { state: ThreadStateView; status: ThreadStatusView; statusReason: string; statusChangedAtMs: number | null };

/** What else the board holds for the pinned row's words: worker threads working, tasks waiting on Ember alone, doing tasks, workers waiting on the user (and their words), blocked tasks. */
export interface RowCounts {
  /** Worker threads working (workingThreads). */
  working: number;
  /** Tasks waiting on Ember alone (unclosedTasks). */
  toCheck?: number;
  /** Doing tasks, whatever their workers do. */
  doing: number;
  waiting?: number;
  /** The waiting worker's words when one waits ("Stopped at budget"); Needs input otherwise. */
  waitingWords?: Words | null;
  blocked?: number;
}

/**
 * The pinned row's status: Ember's own prompt or error (a turn the app's restart cut reads
 * Interrupted, amber: the chat says what happened); else Needs input (or a budget stop's
 * words) while a worker waits on the user; else what Ember's own thread is doing
 * (Finished, Working); else Working while a worker thread works; else To check while a
 * task waits on Ember alone (its worker reported and is idle, or a parent's pieces all
 * closed); else Worker idle while a task is doing with no one on it; else Blocked while
 * a task is blocked (the row counts blocked tasks after the status), else Idle.
 */
export function emberStatusWords(t: EmberThreadLike | undefined, c: RowCounts): Words {
  if (t && t.status === "error" && t.statusReason === "interrupted") return { text: "Interrupted", tone: "amber" };
  const own = t && (t.status === "attention" || t.status === "error" || threadBadge(t) === "busy") ? workerWords(t) : null;
  if (own && (own.tone === "amber" || own.tone === "red")) return own;
  if ((c.waiting ?? 0) > 0) return c.waitingWords ?? NEEDS_INPUT;
  if (own && own.text !== "Idle") return own;
  if (c.working > 0) return { text: "Working", tone: "sky" };
  if ((c.toCheck ?? 0) > 0) return { text: "To check", tone: "emerald" };
  if (c.doing > 0) return { text: "Worker idle", tone: "muted" };
  return (c.blocked ?? 0) > 0 ? { text: "Blocked", tone: "amber" } : { text: "Idle", tone: "muted" };
}

/** The words of the first worker waiting on the user (a budget stop says so), null when none waits. */
export function waitingWords(tasks: readonly EmberTaskView[]): Words | null {
  for (const t of tasks) {
    if ((t.state !== "doing" && t.state !== "blocked") || !t.thread) continue;
    const th = [t.thread, ...t.thread.descendants].find(workerAsks);
    if (th) return workerWords(th);
  }
  return null;
}

/**
 * A task link's words after its title: "in progress · 3 pieces · 2 working · 1 to check"
 * ("needs you" in place of the state while one of its workers waits on the user:
 * `waiting`; "worker reported done, waiting for Ember to check" or "all pieces closed,
 * waiting for Ember to close it" while it waits on Ember alone); no parts for a task the
 * board does not have.
 */
export function linkMeta(tasks: readonly EmberTaskView[], id: string): { parts: string[]; waiting: boolean } {
  const t = tasks.find((x) => x.id === id);
  if (!t) return { parts: [], waiting: false };
  const subs = tasks.filter((x) => x.parentId === id);
  const waiting = (t.state === "doing" || t.state === "blocked") && [t, ...subs].some((x) => (x.state === "doing" || x.state === "blocked") && taskAsks(x));
  const own = unclosedWords(t, tasks);
  const parts = [waiting ? "needs you" : own ? own.charAt(0).toLowerCase() + own.slice(1) : linkWords[t.state]];
  if (subs.length > 0) parts.push(`${String(subs.length)} ${subs.length === 1 ? "piece" : "pieces"}`);
  const working = workingThreads([t, ...subs]);
  if (working > 0) parts.push(`${String(working)} working`);
  const toCheck = subs.filter((x) => unclosed(x, tasks) !== null).length;
  if (toCheck > 0) parts.push(`${String(toCheck)} to check`);
  return { parts, waiting };
}

// ---------- task links in Ember's text ----------

export type EmberTextPart = { kind: "md"; text: string } | { kind: "task"; title: string; id: string };

/** A task link alone on its line (a list bullet allowed): `[Title](cf-task://t-…)`. */
const TASK_LINE = /^\s*(?:[-*]\s+)?\[([^\]\n]+)\]\(cf-task:\/\/(t-[0-9a-f]+)\)\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Ember's text split into markdown and task links (each alone on its line, as its rules
 * write them; one inside a code fence stays code). Text without a link is one part.
 */
export function splitTaskLinks(text: string): EmberTextPart[] {
  if (!text.includes("cf-task://")) return [{ kind: "md", text }];
  const parts: EmberTextPart[] = [];
  let md: string[] = [];
  let fenced = false;
  const flush = () => {
    const t = md.join("\n");
    if (t.trim() !== "") parts.push({ kind: "md", text: t });
    md = [];
  };
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const m = fenced ? null : TASK_LINE.exec(line);
    if (m) {
      flush();
      parts.push({ kind: "task", title: m[1] ?? "", id: m[2] ?? "" });
    } else md.push(line);
  }
  flush();
  return parts;
}

// ---------- the chat's rows ----------

/** A run of work between two visible messages, folded into one line ("Worked for 2m · read 5 files"). */
export interface WorkRow {
  type: "work";
  /** `w:<the run's first item>`, stable while the run grows. */
  key: string;
  /** Every item of the run, top level, in order (turn ends included: the duration's segments). */
  ids: string[];
  expanded: boolean;
  /** The run is the thread's current work (Ember is on a turn): "Working". */
  live: boolean;
}

/** "Code Foundry restarted at 01:26 while Ember was working": the line where the app's restart cut Ember's turn. */
export interface RestartRow {
  type: "restart";
  /** `r:<the cut turn's end>`. */
  key: string;
  atMs: number | null;
}

export type EmberRow = TimelineRow | WorkRow | RestartRow;

export interface EmberRowOptions {
  /** Whether a user message is a wake (the daemon's, not the user's). */
  wake: (id: string) => boolean;
  /** The turn ends where the app's restart cut Ember's turn (restartCuts), with the restart's time. */
  cuts?: ReadonlyMap<string, number | null>;
  /** The user's choice for a work row, by key; undefined: showWork. */
  expanded: (key: string) => boolean | undefined;
  /** "Show work": every work row open by default. */
  showWork: boolean;
  /** Ember is on a turn: the last run is live (and a live row stands alone after the last message). */
  working: boolean;
}

/**
 * The top-level text items that are Ember's reply: the last text of a turn that has ended
 * (a turn end follows it before any later message) or that waits on the user (a pending
 * question or permission follows it, no turn end between). Any other text (written
 * between tool calls, or trailing a live turn) is work. A page or a theme card after the
 * text does not take its place.
 */
function replyTexts(top: readonly TimelineItem[], pendingTool: (it: TimelineItem) => boolean): Set<string> {
  const out = new Set<string>();
  // Walking back: whether the next text seen is the last of a turn that ended or waits.
  let closed = false;
  for (let i = top.length - 1; i >= 0; i--) {
    const it = top[i];
    if (!it) continue;
    if (it.kind === "turnEnd" || (it.kind === "question" && it.requestState === "pending") || (it.kind === "permission" && it.requestState === "pending") || pendingTool(it)) closed = true;
    else if (it.kind === "user") closed = false;
    else if (it.kind === "text") {
      if (closed) out.add(it.id);
      closed = false;
    }
  }
  return out;
}

/**
 * The chat's rows: the user's messages, Ember's reply (the last text of a turn that ended
 * or waits on the user: replyTexts), inline pages, theme cards, system notes, errors and
 * the prompts waiting on the user (a pending permission's tool row, a pending question)
 * show; every run of anything else between them (tool calls, the text Ember writes
 * between them, subagents, thinking, answered prompts, wakes, compactions) is one work
 * row, followed by its ordinary rows while expanded. A reply does not stream: it shows
 * when its turn ends.
 */
export function buildEmberRows(items: readonly TimelineItem[], opts: EmberRowOptions): EmberRow[] {
  // Subagent items nest under their Agent call (as buildTurns does); permissions by tool_use id.
  const agentIds = new Set(items.filter((it) => it.kind === "tool" && AGENT_TOOLS.has(it.name)).map((it) => it.toolUseId));
  const children = new Map<string, TimelineItem[]>();
  const top: TimelineItem[] = [];
  for (const it of items) {
    if (it.parentToolUseId && agentIds.has(it.parentToolUseId)) {
      const list = children.get(it.parentToolUseId) ?? [];
      list.push(it);
      children.set(it.parentToolUseId, list);
    } else top.push(it);
  }
  const toolUses = new Set(items.filter((it) => it.kind === "tool" && it.name !== "AskUserQuestion").map((it) => it.toolUseId));
  const permissions = new Map<string, TimelineItem>();
  for (const it of items) if (it.kind === "permission" && it.toolUseId && toolUses.has(it.toolUseId)) permissions.set(it.toolUseId, it);

  const pendingTool = (it: TimelineItem): boolean => it.kind === "tool" && permissions.get(it.toolUseId)?.requestState === "pending";
  const replies = replyTexts(top, pendingTool);

  const visible = (it: TimelineItem): boolean => {
    switch (it.kind) {
      case "user":
        return !opts.wake(it.id);
      case "text":
        return replies.has(it.id);
      case "note":
      case "error":
      case "html":
      case "theme":
        return true;
      case "question":
        return it.requestState === "pending";
      case "permission":
        return it.requestState === "pending";
      case "tool":
        return pendingTool(it);
      default:
        return false;
    }
  };

  /** Only a wake, thinking and turn ends, the wake included. */
  const quiet = (r: readonly TimelineItem[]): boolean =>
    r.some((it) => it.kind === "user") && r.every((it) => it.kind === "thinking" || it.kind === "turnEnd" || (it.kind === "user" && opts.wake(it.id)));

  const rows: EmberRow[] = [];
  let run: TimelineItem[] = [];
  /**
   * Pushes the run (its work row, then its rows while expanded); false when it had no work.
   * `reply`: Ember's text follows it.
   */
  const flush = (live: boolean, reply = false): boolean => {
    const first = run[0];
    // Only turn ends (a reply's own): nothing worked. A wake with only thinking after it
    // (a progress wake Ember just acknowledged) did nothing worth a row either, unless
    // Ember replied to it: then the row says what woke it and when.
    if (!first || run.every((it) => it.kind === "turnEnd") || (!live && !reply && quiet(run))) {
      run = [];
      return false;
    }
    const key = `w:${first.id}`;
    const expanded = opts.expanded(key) ?? opts.showWork;
    rows.push({ type: "work", key, ids: run.map((it) => it.id), expanded, live });
    if (expanded) rows.push(...workNodes(run, children, permissions));
    run = [];
    return true;
  };
  for (const it of top) {
    // A permission on a tool call shows on that call's row (workNodes): it is in no run.
    if (it.kind === "permission" && permissions.get(it.toolUseId)?.id === it.id) continue;
    const cut = it.kind === "turnEnd" ? opts.cuts?.get(it.id) : undefined;
    if (cut !== undefined) {
      // The app's restart cut this turn: its run ends here, and a line says so.
      run.push(it);
      flush(false);
      rows.push({ type: "restart", key: `r:${it.id}`, atMs: cut });
      continue;
    }
    if (!visible(it)) {
      run.push(it);
      continue;
    }
    flush(false, it.kind === "text");
    if (it.kind === "user") rows.push({ type: "user", key: it.id, id: it.id });
    // The reply is the thread's own text row (its Copy answer copies this text alone).
    else if (it.kind === "text") rows.push({ type: "text", key: it.id, id: it.id, final: true, answer: it.id });
    else rows.push(...workNodes([it], children, permissions));
  }
  const liveRun = flush(opts.working);
  // Working with no work since the last message yet (Claude starting): a live row alone.
  const last = rows[rows.length - 1];
  if (opts.working && !liveRun) rows.push({ type: "work", key: `w:live:${last?.key ?? ""}`, ids: [], expanded: false, live: true });
  return rows;
}

/** A work row's estimated height before it is measured. */
export const WORK_ROW_HEIGHT = 28;

// ---------- a work row's line ----------

function bashCommand(it: Extract<ThreadItemView, { kind: "tool" }>): string {
  try {
    const v = JSON.parse(it.inputJson) as unknown;
    return v && typeof v === "object" && "command" in v && typeof v.command === "string" ? v.command : "";
  } catch {
    return "";
  }
}

function count(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** A heredoc's start in a command (`<<'EOF'`, `<<-EOF`): its terminator. */
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
/** A quoted string that is not a heredoc's terminator. */
const QUOTED = /(?<!<<-?\s*)('[^']*'|"(?:[^"\\]|\\.)*")/g;

/**
 * A shell command's simple commands, in order: split on newlines, `;`, `&&` and `||`
 * outside quotes (a pipeline stays one), heredoc bodies and comment lines left out.
 */
export function shellSegments(command: string): string[] {
  const out: string[] = [];
  const heredocs: string[] = [];
  let cur = "";
  let quote: string | null = null;
  const push = () => {
    // Quoted text is no heredoc ("a << b"); a heredoc's quoted terminator is.
    for (const m of cur.replace(QUOTED, "''").matchAll(HEREDOC)) heredocs.push(m[2] ?? "");
    const s = cur.trim();
    if (s && !s.startsWith("#")) out.push(s);
    cur = "";
  };
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i);
    if (quote !== null) {
      cur += c;
      if (c === "\\" && quote === '"') cur += command.charAt(++i);
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === "\\") {
      // A line continuation joins the lines; any other escape is kept.
      const next = command.charAt(++i);
      cur += next === "\n" ? " " : c + next;
    } else if (c === ";" || c === "\n" || ((c === "&" || c === "|") && command.charAt(i + 1) === c)) {
      push();
      if (c !== ";" && c !== "\n") i++;
      // A heredoc's body starts on the next line and runs to its terminator.
      if (c === "\n") {
        while (heredocs.length > 0) {
          const end = heredocs.shift() ?? "";
          let nl = i;
          for (;;) {
            const from = nl + 1;
            nl = command.indexOf("\n", from);
            const line = command.slice(from, nl < 0 ? undefined : nl);
            if (nl < 0 || line.trim() === end) break;
          }
          i = nl < 0 ? command.length : nl;
        }
      }
    } else cur += c;
  }
  push();
  return out;
}

/** `NAME=value` alone: a shell variable set for the commands after it. */
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\$\([^)]*\)|\S*))$/;
/** A shell keyword or grouping before a command (`do git …`, `{ git …`), left off. */
const KEYWORD = /^(?:(?:do|then|else|elif|if|while|until|!)\s+|[{(]\s*)/;
/** Commands that do nothing worth a word: moving around, printing, loops and tests. */
const QUIET_COMMAND = /^(?:(?:cd|echo|printf|set|export|local|read|sleep|true|false|for|done|fi|esac|case|test)\b|(?:\[\[?|[:}\])])(?:\s|$))/;
/** Reading files by hand (`cat`, `sed -n`, `head`). */
const READ_COMMAND = /^(?:cat|head|tail|sed\s+-n|less|wc|nl)\b/;
/** Looking for files or text (`grep`, `rg`, `find`, `ls`). */
const SEARCH_COMMAND = /^(?:grep|rg|find|fd|ls|tree)\b/;
/** `git -C <dir> <subcommand> <args>` (flags before the subcommand allowed). */
const GIT_C = /(?:^|[\s(|])git\s+-C\s+("[^"]*"|'[^']*'|\S+)\s+(?:--?[\w-]+(?:=\S+)?\s+)*([\w-]+)(.*)$/;
/** A plain `git <subcommand> <args>`. */
const GIT = /(?:^|[\s(|])git\s+(?:--?[\w-]+(?:=\S+)?\s+)*([\w-]+)(.*)$/;
/** A git command that only reads: a branch check. */
const GIT_READ = /^(?:log|diff|show|merge-base|merge-tree|rev-list|rev-parse|status|branch|cherry|shortlog|ls-files|ls-tree|fetch)$/;
/** The base a branch is compared with, not a branch the check is about. */
const BASE_REF = /^(?:HEAD|main|master|trunk|develop)$/;

/** `$NAME` and `${NAME}` in s replaced by the values set before. */
function expand(s: string, vars: ReadonlyMap<string, string>): string {
  return s.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name: string) => vars.get(name) ?? m);
}

/**
 * The branches a git command's arguments name: a range's right side ("main..cf/x",
 * "origin/main...origin/cf/x"), or a ref-looking argument ("origin/cf/x"); the remote's
 * prefix dropped, bases (main, HEAD) and unknown variables left out.
 */
function gitRefs(args: string, vars: ReadonlyMap<string, string>): string[] {
  const refs: string[] = [];
  for (const raw of args.split(/\s+/)) {
    const arg = expand(raw.replace(/^["']|["']$/g, ""), vars);
    if (!arg || arg.startsWith("-") || arg.includes("$") || /[<>|&;]/.test(arg)) continue;
    const range = /^[\w./-]+\.{2,3}([\w./-]+)$/.exec(arg);
    const ref = range ? (range[1] ?? "") : /^[\w-]+(?:\/[\w-]+)+$/.test(arg) ? arg : "";
    const name = ref.replace(/^origin\//, "");
    if (name && !BASE_REF.test(name)) refs.push(name);
  }
  return refs;
}

/** How many branches the run's git commands checked: those named, and a checkout with none named as one. */
function branchCount(branches: ReadonlyMap<string, ReadonlySet<string>>): number {
  const named = new Set<string>();
  let bare = 0;
  for (const refs of branches.values()) {
    if (refs.size === 0) bare++;
    for (const r of refs) named.add(r);
  }
  return named.size + bare;
}

/** What a run's Bash commands did, one simple command at a time. */
interface CommandCounts {
  files: number;
  searches: number;
  created: number;
  started: number;
  /** The threads `thread send` went to, in order. */
  sentTo: string[];
  answered: number;
  closed: number;
  boardUpdates: number;
  boardReads: number;
  notes: number;
  readThreads: number;
  archived: number;
  cleanups: number;
  /** The branches git commands looked at, by the checkout (`-C <dir>`; "" for none) they ran in. */
  branches: Map<string, Set<string>>;
  git: number;
  commands: number;
}

/** The thread a `thread send` goes to: `--id s-…` or the first positional id. */
const SEND_TARGET = /\bthread send\b.*?(?:--id[=\s]+|\s)(s-[A-Za-z0-9-]+)/;

function countCommand(c: CommandCounts, segment: string, vars: Map<string, string>): void {
  const assign = ASSIGN.exec(segment);
  if (assign) {
    vars.set(assign[1] ?? "", expand(assign[2] ?? assign[3] ?? assign[4] ?? "", vars));
    return;
  }
  let s = segment;
  for (let prev = ""; prev !== s; ) {
    prev = s;
    // Shell keywords, and NAME=value words before a command (its environment).
    s = s.replace(KEYWORD, "").replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
  }
  if (s === "" || QUIET_COMMAND.test(s)) return;
  if (/\bember task start\b/.test(s)) c.started++;
  else if (/\bthread new\b/.test(s)) c.created++;
  else if (/\bember task done\b/.test(s)) c.closed++;
  else if (/\bember task (?:add|update|cancel|move)\b/.test(s)) c.boardUpdates++;
  else if (/\bember (?:board|status|task (?:list|show))\b/.test(s)) c.boardReads++;
  else if (/\bember remember\b/.test(s)) c.notes++;
  else if (/\bthread send\b/.test(s)) c.sentTo.push(SEND_TARGET.exec(s)?.[1] ?? "");
  else if (/\bthread respond\b/.test(s)) c.answered++;
  else if (/\bthread archive\b/.test(s)) c.archived++;
  else if (/\bproject worktree cleanup\b/.test(s)) c.cleanups++;
  else if (/\bthread (?:read|get|items|events|show|list|wait|reports?|subscriptions)\b/.test(s)) c.readThreads++;
  else if (/(?:^|[\s(|])git\s/.test(s)) {
    const withDir = GIT_C.exec(s);
    const plain = withDir ? null : GIT.exec(s);
    const sub = withDir?.[2] ?? plain?.[1] ?? "";
    const reads = GIT_READ.test(sub);
    const refs = reads ? gitRefs(withDir?.[3] ?? plain?.[2] ?? "", vars) : [];
    if (refs.length > 0 || (withDir && reads)) {
      // A check of a worktree's branch: by the branch it names, else by the checkout.
      const dir = withDir ? expand((withDir[1] ?? "").replace(/^["']|["']$/g, ""), vars) : "";
      const set = c.branches.get(dir) ?? new Set<string>();
      for (const r of refs) set.add(r);
      c.branches.set(dir, set);
    } else c.git++;
  } else if (READ_COMMAND.test(s)) c.files++;
  else if (SEARCH_COMMAND.test(s)) c.searches++;
  else c.commands++;
}

/** A thread wake's thread name from its title (`Thread "Fix the login" (s-…) is idle…`). */
const WAKE_TITLE = /^Thread "(.+?)" \(s-/;

/**
 * What woke Ember, in a few words: "wake from <thread>", "timer" (with its note, when it
 * has one), "restart"; a batch of thread wakes from one thread is that thread's, from
 * several "N wakes"; anything else "1 wake".
 */
export function wakeLabel(w: WakeView): string {
  let v: unknown;
  try {
    v = JSON.parse(w.json);
  } catch {
    v = null;
  }
  const fromTitle = WAKE_TITLE.exec(w.title)?.[1];
  const one = (p: unknown): string => {
    if (!p || typeof p !== "object") return "";
    const o = p as { kind?: unknown; note?: unknown; thread?: { name?: unknown } };
    if (o.kind === "timer") return typeof o.note === "string" && o.note ? `timer: ${o.note}` : "timer";
    if (o.kind === "restart") return "restart";
    if (o.kind === "thread" && typeof o.thread?.name === "string" && o.thread.name) return `wake from ${o.thread.name}`;
    return "";
  };
  const o = v as { kind?: unknown; wakes?: unknown } | null;
  if (o?.kind === "batch" && Array.isArray(o.wakes)) {
    const labels = [...new Set((o.wakes as unknown[]).map(one).filter((l) => l !== "" && l !== "restart"))];
    const restart = (o.wakes as unknown[]).some((p) => one(p) === "restart");
    const rest = labels.length === 1 ? (labels[0] ?? "") : labels.length > 1 ? `${String(labels.length)} wakes` : "";
    if (restart) return rest ? `restart, ${rest}` : "restart";
    if (rest) return rest;
  }
  return one(v) || (fromTitle ? `wake from ${fromTitle}` : "1 wake");
}

/**
 * What a run did, in a few words ("wake from Notes, read 5 files, started 2 workers,
 * checked 2 branches, updated the board"), from its top-level items: what woke Ember,
 * reads and searches, then the CLI calls Ember makes, each simple command of a Bash call
 * on its own (`a && b; c` counts three), then whatever else ran. `nameOf` names a thread
 * (`thread send`'s target); "" when unknown.
 */
export function workSummary(items: readonly ThreadItemView[], nameOf: (id: string) => string = () => ""): string {
  const n = { files: 0, searches: 0, agents: 0, skills: 0, tools: 0 };
  const wakes: string[] = [];
  const c: CommandCounts = { files: 0, searches: 0, created: 0, started: 0, sentTo: [], answered: 0, closed: 0, boardUpdates: 0, boardReads: 0, notes: 0, readThreads: 0, archived: 0, cleanups: 0, branches: new Map(), git: 0, commands: 0 };
  for (const it of items) {
    if (it.kind === "user" && it.wake) wakes.push(wakeLabel(it.wake));
    if (it.kind !== "tool" || it.parentToolUseId !== "") continue;
    if (it.name === "Read" || it.name === "NotebookRead") n.files++;
    else if (EXPLORE_TOOLS.has(it.name)) n.searches++;
    else if (AGENT_TOOLS.has(it.name)) n.agents++;
    else if (it.name === "Skill") n.skills++;
    else if (it.name === "AskUserQuestion" || it.name === "TodoWrite") continue;
    else if (it.name === "Bash") {
      const vars = new Map<string, string>();
      for (const s of shellSegments(bashCommand(it))) countCommand(c, s, vars);
    } else n.tools++;
  }
  const parts: string[] = [];
  if (wakes.length === 1) parts.push(wakes[0] ?? "");
  else if (wakes.length > 1) {
    // Several: "3 wakes from Notes" when one thread sent them all, else "3 wakes".
    const one = new Set(wakes).size === 1 ? (wakes[0] ?? "") : "";
    parts.push(one.startsWith("wake from ") ? `${String(wakes.length)} wakes from ${one.slice("wake from ".length)}` : count(wakes.length, "wake", "wakes"));
  }
  const files = n.files + c.files;
  const searches = n.searches + c.searches;
  if (files) parts.push(`read ${count(files, "file", "files")}`);
  if (searches) parts.push(`searched ${searches === 1 ? "once" : `${String(searches)} times`}`);
  if (c.readThreads) parts.push(`read ${count(c.readThreads, "thread", "threads")}`);
  if (c.created) parts.push(`created ${count(c.created, "thread", "threads")}`);
  if (c.started) parts.push(`started ${count(c.started, "worker", "workers")}`);
  const sent = [...new Set(c.sentTo)];
  if (sent.length === 1) parts.push(`sent ${c.sentTo.length === 1 ? "a change" : `${String(c.sentTo.length)} changes`} to ${nameOf(sent[0] ?? "") || "a worker"}`);
  else if (sent.length > 1) parts.push(`sent changes to ${String(sent.length)} workers`);
  if (c.answered) parts.push(`answered ${count(c.answered, "question", "questions")}`);
  if (c.closed) parts.push(`closed ${count(c.closed, "task", "tasks")}`);
  if (c.boardUpdates) parts.push("updated the board");
  else if (c.boardReads && !c.closed) parts.push("checked the board");
  if (c.notes) parts.push(`noted ${count(c.notes, "fact", "facts")}`);
  const branches = branchCount(c.branches);
  if (branches) parts.push(`checked ${count(branches, "branch", "branches")}`);
  if (c.git) parts.push("checked git");
  if (c.archived) parts.push(`archived ${count(c.archived, "thread", "threads")}`);
  if (c.cleanups) parts.push("cleaned up worktrees");
  if (c.commands) parts.push(`ran ${count(c.commands, "command", "commands")}`);
  if (n.agents) parts.push(count(n.agents, "subagent", "subagents"));
  if (n.skills) parts.push(`used ${count(n.skills, "skill", "skills")}`);
  if (n.tools) parts.push(`used ${count(n.tools, "tool", "tools")}`);
  return parts.join(", ");
}

/** When a run ended: its last item's last change (epoch ms); null for none. */
export function runEndMs(items: readonly ThreadItemView[]): number | null {
  let end: number | null = null;
  for (const it of items) {
    const t = it.updatedAtMs ?? it.createdAtMs;
    if (t !== null) end = Math.max(end ?? t, t);
  }
  return end;
}

/** "14:02" today, "Oct 20 14:02" before. */
export function clockTime(ms: number, now: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

// ---------- a restart that cut Ember's turn ----------

/** The daemon's turn end for a turn whose process went (internal/store/thread/turnclose.go). */
const PROCESS_ENDED = "process_ended";
/** A running tool's output when the daemon stopped under it (stream.go shutdown). */
const STOPPED_OUTPUT = "Interrupted: the daemon stopped";
/** The resume note's restart cause (resumenote.go). */
const RESTART_NOTE = "app restarted";

/** A restart wake (subscriptions_restart.go): its restarted_at, null when it is none. */
function restartWakeAt(w: WakeView | undefined): number | null {
  if (!w) return null;
  try {
    const v = JSON.parse(w.json) as { kind?: unknown; restarted_at?: unknown; wakes?: unknown };
    const r = v.kind === "restart" ? v : v.kind === "batch" && Array.isArray(v.wakes) ? (v.wakes as { kind?: unknown; restarted_at?: unknown }[]).find((x) => x.kind === "restart") : undefined;
    if (!r) return null;
    const at = typeof r.restarted_at === "string" ? Date.parse(r.restarted_at) : NaN;
    return Number.isNaN(at) ? 0 : at;
  } catch {
    return null;
  }
}

/**
 * The turn ends where the app's restart cut Ember's turn, with when it restarted. A turn
 * end the daemon wrote for a process that went (interrupted, `process_ended`) with no
 * error before it (a crash says so in its own row) is a restart when the daemon's marks
 * say so: a tool it stopped under ("Interrupted: the daemon stopped."), a restart wake or
 * a resume note ("…the Code Foundry app restarted…") on the next message; failing those,
 * when it is the thread's last turn and Ember's status is still the cut ("interrupted",
 * `cutNow`). The time is the restart wake's, else the turn end's.
 */
export function restartCuts(log: { byId: Readonly<Record<string, ThreadItemView>>; order: readonly string[] } | undefined, cutNow: boolean): Map<string, number | null> {
  const cuts = new Map<string, number | null>();
  if (!log) return cuts;
  let stopped = false;
  let failed = false;
  let open: { id: string; at: number | null } | null = null;
  let lastEnd = "";
  for (const id of log.order) {
    const it = log.byId[id];
    if (!it || it.parentToolUseId !== "") continue;
    if (it.kind === "user" && open) {
      const wakeAt = restartWakeAt(it.wake);
      if (wakeAt !== null) cuts.set(open.id, wakeAt || open.at);
      else if (it.resumeNote?.includes(RESTART_NOTE)) cuts.set(open.id, open.at);
      open = null;
    }
    if (it.kind === "tool" && it.output.startsWith(STOPPED_OUTPUT)) stopped = true;
    if (it.kind === "error") failed = true;
    if (it.kind === "turnEnd") {
      lastEnd = it.id;
      if (it.subtype === PROCESS_ENDED && it.interrupted && !failed) {
        // The next message may still say when the app came back (a restart wake).
        open = { id: it.id, at: it.createdAtMs };
        if (stopped) cuts.set(it.id, it.createdAtMs);
      }
      stopped = failed = false;
    }
  }
  if (open && cutNow && open.id === lastEnd) cuts.set(open.id, open.at);
  return cuts;
}

/**
 * How long a run worked: the sum of its segments' spans, a segment ending at a turn end or
 * a wake (the time between turns is not work). `now` closes a live run's last segment.
 */
export function workMs(items: readonly ThreadItemView[], now: number | null): number {
  let total = 0;
  let from: number | null = null;
  let to: number | null = null;
  const close = () => {
    if (from !== null && to !== null) total += Math.max(0, to - from);
    from = to = null;
  };
  for (const it of items) {
    if (it.kind === "user" && it.wake) close();
    const start = it.createdAtMs;
    const end = it.updatedAtMs ?? it.createdAtMs;
    if (start !== null) from ??= start;
    if (end !== null) to = Math.max(to ?? end, end);
    if (it.kind === "turnEnd") close();
  }
  if (now !== null && from !== null) to = Math.max(to ?? now, now);
  close();
  return total;
}

/**
 * A finished run's "Worked for" time: workMs when it ran a tool; a run with none (Ember
 * only thought) has no span of its own, so its turn's duration (`turnMs`: that of the
 * first turn end at or after the run's first item; turnEndAfter finds it).
 */
export function runMs(run: readonly ThreadItemView[], turnMs: number | null): number {
  if (run.some((it) => it.kind === "tool") || turnMs === null || turnMs <= 0) return workMs(run, null);
  return turnMs;
}

/** The duration of the first turn end at or after item `from` in the log's order; null for none. */
export function turnEndAfter(log: { byId: Readonly<Record<string, ThreadItemView>>; order: readonly string[] }, from: string): number | null {
  for (let i = log.order.indexOf(from); i >= 0 && i < log.order.length; i++) {
    const it = log.byId[log.order[i] ?? ""];
    if (it?.kind === "turnEnd") return it.durationMs;
  }
  return null;
}

/** "40s", "2m", "1h 05m"; "" under a second. */
export function shortDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return "";
  if (s < 60) return `${String(s)}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)}m`;
  return `${String(Math.floor(m / 60))}h ${String(m % 60).padStart(2, "0")}m`;
}

// ---------- the Board's Scheduled section ----------

/** A row of the Board's Scheduled section: one of Ember's timers. */
export interface TimerRow {
  /** The subscription id (the × cancels it with thread.unsubscribe). */
  id: string;
  /** "2:12 PM" today, "Thu 9:00 AM" this week, else "Oct 19, 9:00 AM"; "" when unknown. */
  when: string;
  /** "every 2m" for a repeating timer; "" for a one-shot. */
  every: string;
  /** Its note, or "Reminder" when it has none (then `noted` is false). */
  title: string;
  noted: boolean;
}

/** The Scheduled rows, soonest first (a timer without a time last). */
export function timerRows(timers: readonly EmberTimerView[], now: number): TimerRow[] {
  return [...timers]
    .sort((a, b) => (a.nextAtMs ?? Infinity) - (b.nextAtMs ?? Infinity) || a.id.localeCompare(b.id))
    .map((t) => ({
      id: t.id,
      when: t.nextAtMs === null ? "" : snoozeTimeShort(t.nextAtMs, now),
      every: t.every ? `every ${t.every}` : "",
      title: t.note || "Reminder",
      noted: t.note !== "",
    }));
}

// ---------- ember.worker_models ----------

/** The ids in a comma-separated list, in order. */
export function modelList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The list with `id` toggled: removed when in it (unless it is the last one), appended otherwise. */
export function toggleModel(list: readonly string[], id: string): string[] {
  if (!list.includes(id)) return [...list, id];
  return list.length > 1 ? list.filter((m) => m !== id) : [...list];
}

/** The node list type for callers that render a work row's members. */
export type { WorkNode };
