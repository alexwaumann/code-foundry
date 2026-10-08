import { create } from "zustand";
import type { TerminalEventView, TerminalView } from "@/api/terminal";

export interface TerminalsData {
  byId: Readonly<Record<string, TerminalView>>;
  /** Display order: the daemon's list order, new terminals appended. */
  order: readonly string[];
}

interface TerminalsState extends TerminalsData {
  loaded: boolean;
}

export const emptyTerminals: TerminalsData = { byId: {}, order: [] };

function sameRecord(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/** Structural equality, so unchanged terminals keep their identity and rows don't re-render. */
export function sameTerminal(a: TerminalView, b: TerminalView): boolean {
  return (
    a.id === b.id &&
    a.cwd === b.cwd &&
    a.cols === b.cols &&
    a.rows === b.rows &&
    a.title === b.title &&
    a.state === b.state &&
    a.exitCode === b.exitCode &&
    a.startedAtMs === b.startedAtMs &&
    a.exitedAtMs === b.exitedAtMs &&
    a.altScreen === b.altScreen &&
    a.argv.length === b.argv.length &&
    a.argv.every((v, i) => v === b.argv[i]) &&
    sameRecord(a.labels, b.labels)
  );
}

/** Replaces the whole set (List result), keeping identity for unchanged terminals. */
export function replaceTerminals(prev: TerminalsData, list: readonly TerminalView[]): TerminalsData {
  const byId: Record<string, TerminalView> = {};
  for (const t of list) {
    const old = prev.byId[t.id];
    byId[t.id] = old && sameTerminal(old, t) ? old : t;
  }
  const order = list.map((t) => t.id);
  const unchanged =
    order.length === prev.order.length && order.every((id, i) => id === prev.order[i] && byId[id] === prev.byId[id]);
  return unchanged ? prev : { byId, order };
}

export function applyTerminalEvent(prev: TerminalsData, ev: TerminalEventView): TerminalsData {
  if (ev.kind === "updated") {
    const t = ev.terminal;
    const old = prev.byId[t.id];
    if (old && sameTerminal(old, t)) return prev;
    return { byId: { ...prev.byId, [t.id]: t }, order: old ? prev.order : [...prev.order, t.id] };
  }
  if (!(ev.id in prev.byId)) return prev;
  const { [ev.id]: _removed, ...byId } = prev.byId;
  return { byId, order: prev.order.filter((id) => id !== ev.id) };
}

/** Fed by the shared events stream (stores/events.ts). */
export const useTerminalsStore = create<TerminalsState>()(() => ({
  ...emptyTerminals,
  loaded: false,
}));
