/**
 * Ember in the GUI (docs/notes/ember-3-gui.md), pure: the flame's state, the board's
 * sections and cards, the words the pinned row, the chat header and a task link say, the
 * task links in Ember's text, and the chat's rows, where every run of work between two
 * visible messages folds into one "Worked for" row.
 */
import type { EmberTaskStateView, EmberTaskThreadView, EmberTaskView } from "@/api/ember";
import type { ThreadItemView } from "@/api/thread";
import type { ThreadStateView, ThreadStatusView } from "@/api/threads";
import { statusLine, type StatusTone } from "./statusLine";
import { threadBadge } from "./thread";
import { AGENT_TOOLS, EXPLORE_TOOLS, workNodes, type TimelineItem, type TimelineRow, type WorkNode } from "./threadTimeline";

// ---------- the flame ----------

/** idle: slow wobble, dim; thinking: Ember is on a turn; working: its workers are; attention: it has something for the user. */
export type FlameState = "idle" | "thinking" | "working" | "attention";

/**
 * The flame's state for Ember's thread and the number of doing tasks: needs attention (a
 * prompt, or a reply the user has not seen: the daemon's finished-turn attention, cleared
 * when the chat is open) wins, then busy (thinking), then a doing task (working).
 */
export function flameState(t: { state: ThreadStateView; status: ThreadStatusView } | undefined, doing: number): FlameState {
  if (t?.status === "attention") return "attention";
  if (t && threadBadge(t) === "busy") return "thinking";
  return doing > 0 ? "working" : "idle";
}

// ---------- worker threads ----------

/** A task's worker is working: on a turn, not archived or removed. */
export function workerBusy(th: EmberTaskThreadView | null): boolean {
  return th !== null && !th.archived && !th.removed && th.status !== "attention" && threadBadge(th) === "busy";
}

export interface Words {
  text: string;
  tone: StatusTone;
}

/** A worker thread's status in the sidebar's words and colours (lib/lineage's set), or archived / removed. */
export function workerWords(th: EmberTaskThreadView): Words {
  if (th.removed) return { text: "Removed", tone: "muted" };
  if (th.archived) return { text: "Archived", tone: "muted" };
  switch (statusLine({ ...th, statusChangedAtMs: null }).kind) {
    case "working":
      return { text: "Working", tone: "sky" };
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
    case "flagError":
      return { text: "Error", tone: "red" };
    case "place":
    case "waiting":
      return { text: "Idle", tone: "muted" };
  }
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

/** A card's right side: "x of y" for a parent, else its worker's status words, else its state. */
export function cardMeta(c: BoardCard): Words {
  const p = cardProgress(c);
  if (p) return { text: `${String(p.done)} of ${String(p.total)}`, tone: "muted" };
  const t = c.task;
  if (t.state === "done" || t.state === "cancelled" || t.state === "todo") return { text: stateWords[t.state], tone: "muted" };
  if (t.thread) return workerWords(t.thread);
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
  subtask: boolean;
}

function workerMeta(th: EmberTaskThreadView): Words {
  const words = workerWords(th);
  // A report says more than "Idle" or "Finished"; a prompt or an error says more than an old report.
  if (th.reportSummary && (words.tone === "muted" || words.tone === "emerald" || words.tone === "sky")) return { text: th.reportSummary, tone: words.tone === "sky" ? "muted" : words.tone };
  return words;
}

export function workerRows(c: BoardCard): WorkerRow[] {
  const rows: WorkerRow[] = [];
  const own = c.task.thread;
  if (own) {
    rows.push({
      key: `w:${c.task.id}`,
      threadId: own.removed ? "" : own.id,
      title: own.name || own.id,
      dot: workerBusy(own) ? "doing" : taskDot(c.task.state),
      meta: workerMeta(own),
      atMs: own.lastActivityAtMs,
      subtask: false,
    });
  }
  for (const s of c.subtasks) {
    const th = s.thread;
    rows.push({
      key: `s:${s.id}`,
      threadId: th && !th.removed ? th.id : "",
      title: s.title,
      dot: taskDot(s.state),
      meta: s.state === "blocked" && s.outcome ? { text: s.outcome, tone: "amber" } : th && (s.state === "doing" || s.state === "blocked") ? workerMeta(th) : { text: stateWords[s.state], tone: "muted" },
      atMs: th?.lastActivityAtMs ?? s.updatedAtMs,
      subtask: true,
    });
  }
  return rows;
}

/** Distinct worker threads that are working, over the given tasks. */
export function workingThreads(tasks: readonly EmberTaskView[]): number {
  return new Set(tasks.filter((t) => workerBusy(t.thread)).map((t) => t.threadId)).size;
}

/** The chat header's summary: "2 threads working · 1 queued"; "" when nothing is going on. */
export function headerSummary(tasks: readonly EmberTaskView[]): string {
  const working = workingThreads(tasks);
  const queued = tasks.filter((t) => t.state === "todo").length;
  const parts: string[] = [];
  if (working > 0) parts.push(`${String(working)} ${working === 1 ? "thread" : "threads"} working`);
  if (queued > 0) parts.push(`${String(queued)} queued`);
  return parts.join(" · ");
}

/** The first doing task's title (a top-level one first): the pinned row's line 2. */
export function firstDoingTitle(tasks: readonly EmberTaskView[]): string {
  return (tasks.find((t) => t.state === "doing" && t.parentId === "") ?? tasks.find((t) => t.state === "doing"))?.title ?? "";
}

/** The pinned row's status: what Ember's own thread is doing, else Working while a task is doing, else Idle. */
export function emberStatusWords(t: { state: ThreadStateView; status: ThreadStatusView; statusReason: string; statusChangedAtMs: number | null } | undefined, doing: number): Words {
  if (t && (t.status === "attention" || t.status === "error" || threadBadge(t) === "busy")) {
    const w = workerWords({ ...t, id: "", name: "", reportStatus: null, reportSummary: "", reportAtMs: null, createdAtMs: null, lastActivityAtMs: null, archived: false, removed: false });
    if (w.text !== "Idle") return w;
  }
  return doing > 0 ? { text: "Working", tone: "sky" } : { text: "Idle", tone: "muted" };
}

/** A task link's words after its title: "in progress · 3 pieces · 2 working"; [] for a task the board does not have. */
export function linkMeta(tasks: readonly EmberTaskView[], id: string): string[] {
  const t = tasks.find((x) => x.id === id);
  if (!t) return [];
  const subs = tasks.filter((x) => x.parentId === id);
  const parts = [linkWords[t.state]];
  if (subs.length > 0) parts.push(`${String(subs.length)} ${subs.length === 1 ? "piece" : "pieces"}`);
  const working = workingThreads([t, ...subs]);
  if (working > 0) parts.push(`${String(working)} working`);
  return parts;
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

/** Ember's own text (task links as pointer lines). */
export interface EmberTextRow {
  type: "etext";
  key: string;
  id: string;
}

export type EmberRow = TimelineRow | WorkRow | EmberTextRow;

export interface EmberRowOptions {
  /** Whether a user message is a wake (the daemon's, not the user's). */
  wake: (id: string) => boolean;
  /** The user's choice for a work row, by key; undefined: showWork. */
  expanded: (key: string) => boolean | undefined;
  /** "Show work": every work row open by default. */
  showWork: boolean;
  /** Ember is on a turn: the last run is live (and a live row stands alone after the last message). */
  working: boolean;
}

/**
 * The chat's rows: the user's messages, Ember's text, system notes, errors and the prompts
 * waiting on the user (a pending permission's tool row, a pending question) show; every
 * run of anything else between them (tool calls, subagents, thinking, answered prompts,
 * wakes, compactions) is one work row, followed by its ordinary rows while expanded.
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

  const visible = (it: TimelineItem): boolean => {
    switch (it.kind) {
      case "user":
        return !opts.wake(it.id);
      case "text":
      case "note":
      case "error":
        return true;
      case "question":
        return it.requestState === "pending";
      case "permission":
        return it.requestState === "pending" && permissions.get(it.toolUseId)?.id !== it.id;
      case "tool":
        return permissions.get(it.toolUseId)?.requestState === "pending";
      default:
        return false;
    }
  };

  const rows: EmberRow[] = [];
  let run: TimelineItem[] = [];
  /** Pushes the run (its work row, then its rows while expanded); false when it had no work. */
  const flush = (live: boolean): boolean => {
    const first = run[0];
    // Only turn ends (a reply's own): nothing worked.
    if (!first || run.every((it) => it.kind === "turnEnd")) {
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
    if (!visible(it)) {
      run.push(it);
      continue;
    }
    flush(false);
    if (it.kind === "user") rows.push({ type: "user", key: it.id, id: it.id });
    else if (it.kind === "text") rows.push({ type: "etext", key: it.id, id: it.id });
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

/**
 * What a run did, in a few words ("read 5 files, created 2 threads, updated the board"),
 * from its top-level items: wakes, reads and searches, then the CLI calls Ember makes
 * (threads created, read and messaged, board updates and reads, notes), then whatever
 * else ran.
 */
export function workSummary(items: readonly ThreadItemView[]): string {
  const n = { wakes: 0, files: 0, searches: 0, created: 0, readThreads: 0, sent: 0, boardUpdates: 0, boardReads: 0, notes: 0, git: 0, commands: 0, agents: 0, skills: 0, tools: 0 };
  for (const it of items) {
    if (it.kind === "user" && it.wake) n.wakes++;
    if (it.kind !== "tool" || it.parentToolUseId !== "") continue;
    if (it.name === "Read" || it.name === "NotebookRead") n.files++;
    else if (EXPLORE_TOOLS.has(it.name)) n.searches++;
    else if (AGENT_TOOLS.has(it.name)) n.agents++;
    else if (it.name === "Skill") n.skills++;
    else if (it.name === "AskUserQuestion" || it.name === "TodoWrite") continue;
    else if (it.name === "Bash") {
      const c = bashCommand(it);
      if (/\bthread new\b/.test(c)) n.created++;
      else if (/\bember task (?:add|update|done|cancel)\b/.test(c)) n.boardUpdates++;
      else if (/\bember (?:board|status|task (?:list|show))\b/.test(c)) n.boardReads++;
      else if (/\bember remember\b/.test(c)) n.notes++;
      else if (/\bthread (?:read|get|items|events|show|list)\b/.test(c)) n.readThreads++;
      else if (/\bthread send\b/.test(c)) n.sent++;
      else if (/^\s*(?:cd [^&;]+(?:&&|;)\s*)?git\b/.test(c)) n.git++;
      else n.commands++;
    } else n.tools++;
  }
  const parts: string[] = [];
  if (n.wakes) parts.push(count(n.wakes, "wake", "wakes"));
  if (n.files) parts.push(`read ${count(n.files, "file", "files")}`);
  if (n.searches) parts.push(`searched ${n.searches === 1 ? "once" : `${String(n.searches)} times`}`);
  if (n.readThreads) parts.push(`read ${count(n.readThreads, "thread", "threads")}`);
  if (n.created) parts.push(`created ${count(n.created, "thread", "threads")}`);
  if (n.sent) parts.push(`messaged ${count(n.sent, "thread", "threads")}`);
  if (n.boardUpdates) parts.push("updated the board");
  else if (n.boardReads) parts.push("checked the board");
  if (n.notes) parts.push(`noted ${count(n.notes, "fact", "facts")}`);
  if (n.git) parts.push("checked git");
  if (n.commands) parts.push(`ran ${count(n.commands, "command", "commands")}`);
  if (n.agents) parts.push(count(n.agents, "subagent", "subagents"));
  if (n.skills) parts.push(`used ${count(n.skills, "skill", "skills")}`);
  if (n.tools) parts.push(`used ${count(n.tools, "tool", "tools")}`);
  return parts.join(", ");
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

/** "40s", "2m", "1h 05m"; "" under a second. */
export function shortDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return "";
  if (s < 60) return `${String(s)}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)}m`;
  return `${String(Math.floor(m / 60))}h ${String(m % 60).padStart(2, "0")}m`;
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
