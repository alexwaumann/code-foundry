/**
 * EmberService (docs/notes/ember-2-store.md): Ember's status and task board as view
 * models. The board is read-only here: Ember changes it through the `ember.*` commands.
 */
import { timestampMs, type Timestamp } from "@bufbuild/protobuf/wkt";
import { EmberService, EmberTaskState, type EmberBoard, type EmberStatus, type EmberTask, type EmberTaskThread } from "@/gen/codefoundry/v1/ember_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { reportStatusMap, stateMap, statusMap, type ThreadReportStatusView, type ThreadStateView, type ThreadStatusView } from "./threads";

export type EmberTaskStateView = "todo" | "doing" | "blocked" | "done" | "cancelled";

/** A task's worker thread as the board derives it (the daemon's snapshot of it). */
export interface EmberTaskThreadView {
  id: string;
  name: string;
  state: ThreadStateView;
  status: ThreadStatusView;
  statusReason: string;
  /** Its latest report (thread report), null when it has none. */
  reportStatus: ThreadReportStatusView | null;
  reportSummary: string;
  reportAtMs: number | null;
  createdAtMs: number | null;
  lastActivityAtMs: number | null;
  archived: boolean;
  /** The thread was removed: only the task remembers it. */
  removed: boolean;
}

export interface EmberTaskView {
  /** "t-" and 8 hex digits. */
  id: string;
  title: string;
  detail: string;
  state: EmberTaskStateView;
  /** The parent task (one level); "" for a top-level task. */
  parentId: string;
  /** The worker thread; "" when the task has none. */
  threadId: string;
  /** Why it is done, cancelled or blocked. */
  outcome: string;
  position: number;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  doneAtMs: number | null;
  thread: EmberTaskThreadView | null;
}

export interface EmberCountsView {
  todo: number;
  doing: number;
  blocked: number;
  done: number;
  cancelled: number;
}

export interface EmberStatusView {
  enabled: boolean;
  /** The resident thread; "" while Ember has none yet. */
  threadId: string;
  epoch: number;
  consolidating: boolean;
  counts: EmberCountsView;
}

/** The whole board: what WatchBoard sends first and again on every change. */
export interface EmberBoardView {
  status: EmberStatusView;
  /** In board order. */
  tasks: readonly EmberTaskView[];
}

const stateViews: Readonly<Partial<Record<number, EmberTaskStateView>>> = {
  [EmberTaskState.UNSPECIFIED]: "todo",
  [EmberTaskState.TODO]: "todo",
  [EmberTaskState.DOING]: "doing",
  [EmberTaskState.BLOCKED]: "blocked",
  [EmberTaskState.DONE]: "done",
  [EmberTaskState.CANCELLED]: "cancelled",
};

function ms(t: Timestamp | undefined): number | null {
  return t ? timestampMs(t) : null;
}

function toTaskThreadView(t: EmberTaskThread): EmberTaskThreadView {
  return {
    id: t.id,
    name: t.name,
    state: stateMap[t.state],
    status: statusMap[t.status],
    statusReason: t.statusReason,
    reportStatus: reportStatusMap[t.reportStatus] ?? null,
    reportSummary: t.reportSummary,
    reportAtMs: ms(t.reportAt),
    createdAtMs: ms(t.createdAt),
    lastActivityAtMs: ms(t.lastActivityAt),
    archived: t.archived,
    removed: t.removed,
  };
}

export function toEmberTaskView(t: EmberTask): EmberTaskView {
  return {
    id: t.id,
    title: t.title,
    detail: t.detail,
    // A state a newer daemon added reads as todo, as the daemon's own store does.
    state: stateViews[t.state] ?? "todo",
    parentId: t.parentId,
    threadId: t.threadId,
    outcome: t.outcome,
    position: t.position,
    createdAtMs: ms(t.createdAt),
    updatedAtMs: ms(t.updatedAt),
    doneAtMs: ms(t.doneAt),
    thread: t.thread ? toTaskThreadView(t.thread) : null,
  };
}

export function toEmberStatusView(s: EmberStatus | undefined): EmberStatusView {
  const c = s?.counts;
  return {
    enabled: s?.enabled ?? false,
    threadId: s?.threadId ?? "",
    epoch: s?.epoch ?? 0,
    consolidating: s?.consolidating ?? false,
    counts: { todo: c?.todo ?? 0, doing: c?.doing ?? 0, blocked: c?.blocked ?? 0, done: c?.done ?? 0, cancelled: c?.cancelled ?? 0 },
  };
}

export function toEmberBoardView(b: EmberBoard): EmberBoardView {
  return { status: toEmberStatusView(b.status), tasks: b.tasks.map(toEmberTaskView) };
}

/** EmberService.WatchBoard: the whole board, then again on every change. */
export async function* watchEmberBoard(signal: AbortSignal, conn: DaemonConnection = daemon): AsyncGenerator<EmberBoardView> {
  const c = await conn.client(EmberService);
  for await (const b of c.watchBoard({}, { signal })) yield toEmberBoardView(b);
}
