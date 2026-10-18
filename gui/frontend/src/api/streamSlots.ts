/**
 * The one count of the GUI's open server streams (docs/notes/plugins-12-renderer-defects.md).
 * The daemon speaks HTTP/1.1, so WebKit holds at most 6 connections per origin: each
 * long-lived stream (EventService.Watch, ThreadService.WatchThread,
 * PluginService.WatchSurface, TerminalService.Attach, a clone) keeps one, and a unary call
 * waits for a free one. With 6 streams open every unary call hangs. Every runStream
 * attempt claims a slot here first and never more than MAX_OPEN_STREAMS are granted, so
 * one connection always stays free for calls.
 *
 * Two priorities: "core" (the event stream, the content pane's thread, a plugin tab's
 * surface, the bottom panel's shell) and "inline" (a plugin's thread or terminal node). A
 * core claim that finds no room takes the newest inline holder's slot (the holder is told
 * through its `preempt` and claims again); waiting claims are served core first, then in
 * the order they came. `useStreamSlotsStore` says what is open and what waits, so an
 * inline node can say it is waiting instead of hanging.
 */
import { create } from "zustand";

/** Streams held at once; the sixth connection stays free for unary calls. */
export const MAX_OPEN_STREAMS = 5;

export type StreamPriority = "core" | "inline";

export interface StreamSlotsState {
  /** Slots granted now. */
  open: number;
  /** The labels of the claims waiting for a slot, in the order they will be served. */
  waiting: readonly string[];
}

export const useStreamSlotsStore = create<StreamSlotsState>()(() => ({ open: 0, waiting: [] }));

interface Claim {
  id: number;
  label: string;
  priority: () => StreamPriority;
  granted: boolean;
  onGrant: () => void;
  /** Called (once) when a core claim takes this holder's slot; the claim is already gone. */
  preempt: (() => void) | undefined;
}

let nextId = 1;
let claims: Claim[] = [];

function publish(): void {
  const open = claims.filter((c) => c.granted).length;
  const waiting = order(claims.filter((c) => !c.granted)).map((c) => c.label);
  const s = useStreamSlotsStore.getState();
  if (s.open === open && s.waiting.length === waiting.length && s.waiting.every((l, i) => l === waiting[i])) return;
  useStreamSlotsStore.setState({ open, waiting });
}

/** Waiting claims in the order they are served: core first, then by arrival. */
function order(waiting: Claim[]): Claim[] {
  return [...waiting.filter((c) => c.priority() === "core"), ...waiting.filter((c) => c.priority() !== "core")];
}

/** Grants what fits; a core waiter preempts the newest inline holder. */
function settle(): void {
  for (;;) {
    const next = order(claims.filter((c) => !c.granted))[0];
    if (!next) break;
    const held = claims.filter((c) => c.granted);
    if (held.length < MAX_OPEN_STREAMS) {
      next.granted = true;
      next.onGrant();
      continue;
    }
    if (next.priority() !== "core") break;
    const victim = held.filter((c) => c.priority() === "inline" && c.preempt).at(-1);
    if (!victim) break;
    claims = claims.filter((c) => c !== victim);
    victim.preempt?.();
  }
  publish();
}

export interface SlotTicket {
  /** True once granted; until then `ready` resolves when it is (or false if cancelled). */
  readonly granted: () => boolean;
  readonly ready: Promise<boolean>;
  /** Gives the slot back, or stops waiting. Harmless twice. */
  readonly release: () => void;
}

/**
 * Claims a stream slot. Granted at once when there is room (`granted()` is then true
 * synchronously, so a stream opens without an extra tick). `priority` is read each time
 * the slots are settled (a shared thread watch is core while the content pane holds it).
 * `preempt` runs when a core claim takes this slot: the stream must close and claim again.
 */
export function claimStreamSlot(label: string, priority: StreamPriority | (() => StreamPriority), preempt?: () => void): SlotTicket {
  const prio = typeof priority === "function" ? priority : () => priority;
  let resolve: (ok: boolean) => void = () => undefined;
  const ready = new Promise<boolean>((r) => {
    resolve = r;
  });
  const claim: Claim = {
    id: nextId++,
    label,
    priority: prio,
    granted: false,
    onGrant: () => {
      resolve(true);
    },
    preempt,
  };
  claims.push(claim);
  settle();
  let done = false;
  return {
    granted: () => claim.granted && claims.includes(claim),
    ready,
    release: () => {
      if (done) return;
      done = true;
      const had = claims.includes(claim);
      claims = claims.filter((c) => c !== claim);
      resolve(false);
      if (had) settle();
    },
  };
}

/**
 * Re-reads every claim's priority: call when a shared stream's priority may have changed
 * (a core holder joined a waiting inline watch).
 */
export function resettleStreamSlots(): void {
  settle();
}

/** Forgets every claim (tests: runners a previous test left running). */
export function resetStreamSlots(): void {
  claims = [];
  useStreamSlotsStore.setState({ open: 0, waiting: [] });
}
