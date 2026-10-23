/**
 * Ember in the GUI (docs/notes/ember-3-gui.md): its board, from one shared
 * EmberService.WatchBoard stream while something on screen shows it (the pinned sidebar
 * row, the chat, the Board panel), the resident thread's id, ember.enabled, and the Board
 * panel's scroll target.
 */
import { useMemo } from "react";
import { create } from "zustand";
import type { EmberBoardView, EmberTaskView, EmberTimerView } from "@/api/ember";
import { watchEmberBoard } from "@/api/ember";
import { invalidateOnTransportError } from "@/api/endpoint";
import { runStream } from "@/api/stream";
import { resettleStreamSlots, type StreamPriority } from "@/api/streamSlots";
import {
  blockedTasks,
  boardSections,
  flameState,
  headerSummary,
  linkMeta,
  rowTitle,
  unclosedTasks,
  waitingThreads,
  waitingWords,
  workingThreads,
  type FlameState,
  type HeaderDot,
  type Words,
} from "@/lib/ember";
import { useSettingsStore } from "./settings";
import { useThreadStore } from "./thread";
import { isAttention, useThreadsStore, type ThreadsData } from "./threads";

/** The resident's name the daemon gives Ember's thread (Thread.resident_name). */
export const EMBER_RESIDENT = "ember";
/** The setting that turns Ember on. */
export const EMBER_ENABLED = "ember.enabled";
/** The setting the worker-models chips edit. */
export const EMBER_WORKER_MODELS = "ember.worker_models";

interface EmberState {
  /** The last board WatchBoard sent; null before the first (or with no stream ever opened). */
  board: EmberBoardView | null;
  /** Why the stream retries; null while it is fine. */
  error: string | null;
  /** The task the Board panel scrolls to (a task link's click), bumped by seq for a repeat click. */
  focus: { id: string; seq: number } | null;
}

export const useEmberStore = create<EmberState>()(() => ({ board: null, error: null, focus: null }));

const NO_TASKS: readonly EmberTaskView[] = [];
const NO_TIMERS: readonly EmberTimerView[] = [];

// ---------- the board stream ----------

let holders = 0;
let coreHolders = 0;
let stop: (() => void) | null = null;

/**
 * Holds the board stream for a view that shows it, opening it for the first holder and
 * closing it after the last: one WatchBoard however many views show Ember. `priority`:
 * the sidebar row holds it "inline" (a core stream may take its slot; api/streamSlots.ts),
 * the chat and the Board panel "core". Returns the release (harmless twice).
 */
export function holdEmberBoard(priority: StreamPriority): () => void {
  const core = priority === "core" ? 1 : 0;
  holders++;
  coreHolders += core;
  if (stop === null) {
    stop = runStream<EmberBoardView>({
      open: (signal) => watchEmberBoard(signal),
      slot: { label: "ember:board", priority: () => (coreHolders > 0 ? "core" : "inline") },
      resyncOnVisible: true,
      onEvent: (board) => {
        useEmberStore.setState({ board, error: null });
      },
      onStatus: (status, err) => {
        if (status === "retrying") useEmberStore.setState({ error: err ?? "the board's stream ended" });
      },
      onError: invalidateOnTransportError,
    });
  } else if (core) resettleStreamSlots();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders--;
    coreHolders -= core;
    if (holders > 0) return;
    stop?.();
    stop = null;
  };
}

/** Whether the board stream is open (tests). */
export function emberBoardHeld(): boolean {
  return stop !== null;
}

// ---------- selectors ----------

/** ember.enabled from the settings snapshot (off until a snapshot says "true"). */
export function useEmberEnabled(): boolean {
  return useSettingsStore((s) => s.snapshot?.values[EMBER_ENABLED] === "true");
}

/** Ember's thread id from the thread list (a resident, so among the owned threads); "" while it has none. */
export function emberThreadOf(s: ThreadsData): string {
  return (s.owned ?? []).find((id) => s.byId[id]?.resident === EMBER_RESIDENT) ?? "";
}

export function useEmberThreadId(): string {
  return useThreadsStore(emberThreadOf);
}

/** Ember's thread when Ember is on and has one: the pinned row shows then; "" otherwise. */
export function useShownEmberThreadId(): string {
  const enabled = useEmberEnabled();
  const id = useEmberThreadId();
  return enabled ? id : "";
}

/** Whether a thread is Ember's (its chat replaces the thread pane). */
export function useIsEmberThread(threadId: string): boolean {
  return useThreadsStore((s) => s.byId[threadId]?.resident === EMBER_RESIDENT);
}

export function useEmberTasks(): readonly EmberTaskView[] {
  return useEmberStore((s) => s.board?.tasks ?? NO_TASKS);
}

/** How many tasks are doing, whatever their workers do (the pinned row's "Worker idle"). */
export function useDoingCount(): number {
  return useEmberStore((s) => s.board?.tasks.filter((t) => t.state === "doing").length ?? 0);
}

/** How many timers Ember has pending (the board's Scheduled section). */
export function pendingTimers(board: EmberBoardView | null): number {
  return board?.timers.length ?? 0;
}

/** The chat header's "1 needs you · 2 threads working · 1 blocked · 1 queued". */
export function useHeaderSummary(): string {
  return useEmberStore((s) => headerSummary(s.board?.tasks ?? NO_TASKS, pendingTimers(s.board)).text);
}

/** The chat header's dot: amber while something waits on the user, sky while workers run. */
export function useHeaderDot(): HeaderDot {
  return useEmberStore((s) => headerSummary(s.board?.tasks ?? NO_TASKS, pendingTimers(s.board)).dot);
}

/** The pinned row's middle part: the waiting worker's task, else the first doing task, else the first blocked one. */
export function useRowTitle(): string {
  return useEmberStore((s) => rowTitle(s.board?.tasks ?? NO_TASKS));
}

/** Blocked tasks no worker of which waits on the user (the row's Blocked, the header's "N blocked"). */
export function useBlockedCount(): number {
  return useEmberStore((s) => blockedTasks(s.board?.tasks ?? NO_TASKS));
}

/** The pending timers' count (the row's "N scheduled"). */
export function usePendingTimers(): number {
  return useEmberStore((s) => pendingTimers(s.board));
}

/** The first waiting worker's words ("Needs input", "Stopped at budget · $0.21"), as text and tone; null when none waits. */
export function useWaitingWords(): Words | null {
  const text = useEmberStore((s) => waitingWords(s.board?.tasks ?? NO_TASKS)?.text ?? "");
  const tone = useEmberStore((s) => waitingWords(s.board?.tasks ?? NO_TASKS)?.tone ?? "muted");
  return useMemo(() => (text ? { text, tone } : null), [text, tone]);
}

/** Worker threads working now (leads' teams included): the flame's working state, the row's Working and "N threads". */
export function useWorkingThreads(): number {
  return useEmberStore((s) => workingThreads(s.board?.tasks ?? NO_TASKS));
}

/** Tasks waiting on Ember alone: a worker reported and is idle, or a parent's pieces all closed (the row's To check). */
export function useToCheckCount(): number {
  return useEmberStore((s) => unclosedTasks(s.board?.tasks ?? NO_TASKS));
}

/** Worker threads (leads' teams included) waiting on the user's answer: the row's Needs input, the bell's Ember. */
export function useWaitingThreads(): number {
  return useEmberStore((s) => waitingThreads(s.board?.tasks ?? NO_TASKS));
}

/** A task link's words after its title, joined ("in progress · 3 pieces · 2 working"); "" for a task not on the board. */
export function useLinkMeta(taskId: string): string {
  return useEmberStore((s) => linkMeta(s.board?.tasks ?? NO_TASKS, taskId).parts.join(" · "));
}

/** Whether one of a linked task's workers waits on the user (its words read "needs you", amber). */
export function useLinkWaiting(taskId: string): boolean {
  return useEmberStore((s) => linkMeta(s.board?.tasks ?? NO_TASKS, taskId).waiting);
}

/** A linked task's title on the board now (Ember may have renamed it since); "" for a task not on the board. */
export function useLinkTitle(taskId: string): string {
  return useEmberStore((s) => s.board?.tasks.find((t) => t.id === taskId)?.title ?? "");
}

/** A linked done task's branch (ember task done --branch); "" otherwise. */
export function useLinkBranch(taskId: string): string {
  return useEmberStore((s) => {
    const t = s.board?.tasks.find((x) => x.id === taskId);
    return t?.state === "done" ? t.branch : "";
  });
}

/** The Board panel's header counts: cards in progress and up next, and Ember's pending timers. */
export function useBoardCounts(now: number): { inProgress: number; upNext: number; scheduled: number } {
  const inProgress = useEmberStore((s) => boardSections(s.board?.tasks ?? NO_TASKS, now).inProgress.length);
  const upNext = useEmberStore((s) => boardSections(s.board?.tasks ?? NO_TASKS, now).upNext.length);
  const scheduled = useEmberStore((s) => s.board?.timers.length ?? 0);
  return { inProgress, upNext, scheduled };
}

/** Ember's pending timers, soonest first (the Board's Scheduled section). */
export function useEmberTimers(): readonly EmberTimerView[] {
  return useEmberStore((s) => s.board?.timers ?? NO_TIMERS);
}

// ---------- the Board panel's target ----------

/** Asks the Board panel to scroll to a task (and mark it). */
export function focusEmberTask(id: string): void {
  useEmberStore.setState((s) => ({ focus: { id, seq: (s.focus?.seq ?? 0) + 1 } }));
}

// ---------- Show work ----------

/**
 * Drops the user's choices on a chat's work rows (keys `w:…`, stores/thread.ts expanded),
 * so "Show work" decides every one of them again.
 */
export function clearWorkRowChoices(threadId: string): void {
  useThreadStore.setState((s) => {
    const cur = s.expanded[threadId];
    if (!cur) return s;
    const kept = Object.fromEntries(Object.entries(cur).filter(([k]) => !k.startsWith("w:")));
    return { expanded: { ...s.expanded, [threadId]: kept } };
  });
}

// ---------- the flame ----------

/**
 * The flame's state for Ember's thread (lib/ember flameState): working only while a
 * worker thread works, not while a task is doing with its worker idle. A primitive, so a
 * view re-renders only when it changes.
 */
export function useFlameState(threadId: string): FlameState {
  const working = useWorkingThreads();
  const waiting = useWaitingThreads();
  const state = useThreadsStore((s) => s.byId[threadId]?.state ?? "unknown");
  const status = useThreadsStore((s) => s.byId[threadId]?.status ?? "unknown");
  return flameState(threadId ? { state, status } : undefined, working, waiting);
}

// ---------- attention ----------

/**
 * Ember's thread when it needs the user (a prompt, a reply not seen yet, or a worker of
 * its board waiting on an answer: `workersWaiting`) and Ember is on; "" otherwise. The
 * bell counts it once and cmd+shift+a reaches it first (its row is the sidebar's first);
 * the Dock badge and the start page leave it out, as every resident. A worker's prompt
 * stays until it is answered: opening Ember's chat does not clear it.
 */
export function emberAttentionId(threads: ThreadsData, enabled: boolean, workersWaiting = 0): string {
  const id = enabled ? emberThreadOf(threads) : "";
  const t = id ? threads.byId[id] : undefined;
  return t && (isAttention(t) || workersWaiting > 0) ? id : "";
}

export function getEmberAttentionId(): string {
  const waiting = waitingThreads(useEmberStore.getState().board?.tasks ?? NO_TASKS);
  return emberAttentionId(useThreadsStore.getState(), useSettingsStore.getState().snapshot?.values[EMBER_ENABLED] === "true", waiting);
}

export function useEmberAttention(): boolean {
  const enabled = useEmberEnabled();
  const waiting = useWaitingThreads();
  return useThreadsStore((s) => emberAttentionId(s, enabled, waiting) !== "");
}
