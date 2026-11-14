import { create } from "zustand";
import { deepActiveElement } from "@/lib/keyTarget";
import type { FindResults } from "@/terminal/renderer";
import { NO_RESULTS } from "@/terminal/results";
import { useTerminalsStore } from "./terminals";
import { useUiStore } from "./ui";

/**
 * The terminal's find (docs/notes/terminal-find.md), one session per terminal with its bar
 * open: a tab's query is its own, and comes back with the tab or the panel. Only what is
 * asked for is here; the matches are the renderer's (terminal/find.ts), which reports what
 * they come to.
 */
interface FindSession {
  query: string;
  /** Raised to ask the bar's field to take the keyboard and select its query. */
  focusSeq: number;
  /** The last request the bar took: a bar that comes back with its tab does not take the keyboard. */
  focusedSeq: number;
  results: FindResults;
}

interface TerminalFindState {
  byTerminal: Readonly<Record<string, FindSession>>;
}

export const useTerminalFindStore = create<TerminalFindState>(() => ({ byTerminal: {} }));

function update(id: string, change: (s: FindSession | undefined) => FindSession | undefined): void {
  useTerminalFindStore.setState((st) => {
    const prev = st.byTerminal[id];
    const next = change(prev);
    if (next === prev) return st;
    if (next) return { byTerminal: { ...st.byTerminal, [id]: next } };
    const { [id]: _gone, ...rest } = st.byTerminal;
    return { byTerminal: rest };
  });
}

/** Opens the terminal's bar, or asks an open one to take the keyboard and select its query. */
export function openTerminalFind(id: string): void {
  update(id, (s) => {
    const base = s ?? { query: "", focusSeq: 0, focusedSeq: 0, results: NO_RESULTS };
    return { ...base, focusSeq: base.focusSeq + 1 };
  });
}

export function closeTerminalFind(id: string): void {
  update(id, () => undefined);
}

export function setTerminalFindQuery(id: string, query: string): void {
  update(id, (s) => (s ? { ...s, query } : s));
}

export function setTerminalFindResults(id: string, results: FindResults): void {
  update(id, (s) => {
    if (!s) return s;
    const r = s.results;
    return r.index === results.index && r.total === results.total && r.capped === results.capped ? s : { ...s, results };
  });
}

/** The bar acted on focus requests up to `seq`. */
export function terminalFindFocused(id: string, seq: number): void {
  update(id, (s) => (s ? { ...s, focusedSeq: seq } : s));
}

/** What a terminal on screen does for the store: the matches are in its renderer. */
export interface TerminalFindHost {
  step: (dir: 1 | -1) => void;
}

/** The terminals on screen, by id. Two hosts never show one terminal (a plugin node yields to a terminal tab). */
const hosts = new Map<string, TerminalFindHost>();
let lastKeyboard: string | null = null;

/** The terminal is on screen in `host` until the returned release runs. */
export function registerTerminalFindHost(id: string, host: TerminalFindHost): () => void {
  hosts.set(id, host);
  return () => {
    if (hosts.get(id) === host) hosts.delete(id);
  };
}

/** The keyboard went into this terminal or its bar: where a find started from the palette goes. */
export function noteTerminalKeyboard(id: string): void {
  lastKeyboard = id;
}

/** Goes to the next (1) or previous (-1) match, wrapping. With the bar closed it opens instead. */
export function stepTerminalFind(id: string, dir: 1 | -1): void {
  if (useTerminalFindStore.getState().byTerminal[id]) hosts.get(id)?.step(dir);
  else openTerminalFind(id);
}

/** The terminal whose xterm or find bar has the keyboard. */
function keyboardTerminal(): string | null {
  return deepActiveElement()?.closest("[data-terminal-box]")?.getAttribute("data-terminal-box") ?? null;
}

/**
 * thread.find's sibling, for terminal.find, terminal.find.next and terminal.find.previous
 * in this window (keys/bindings.ts, stores/views.ts): on the terminal with the keyboard, else
 * (the palette has it, or the CLI asked) the last one that had it, else one on screen. True
 * when a terminal was there to act on.
 */
export function presentTerminalFind(action: "open" | "next" | "previous"): boolean {
  const last = lastKeyboard !== null && hosts.has(lastKeyboard) ? lastKeyboard : null;
  const id = keyboardTerminal() ?? last ?? hosts.keys().next().value;
  if (id === undefined) return false;
  afterPalette(() => {
    if (action === "open") openTerminalFind(id);
    else stepTerminalFind(id, action === "next" ? 1 : -1);
  });
  return true;
}

/** Picked in the palette, which then hands the keyboard back to the terminal (ui closePalette): the bar takes it after that. */
function afterPalette(run: () => void): void {
  if (!useUiStore.getState().palette.open) {
    run();
    return;
  }
  const stop = useUiStore.subscribe((s) => {
    if (s.palette.open) return;
    stop();
    setTimeout(run, 0);
  });
}

// A terminal that goes takes its session with it (a closed tab; an exited one stays until then).
useTerminalsStore.subscribe((st, prev) => {
  if (st.byId === prev.byId) return;
  for (const id of Object.keys(useTerminalFindStore.getState().byTerminal)) {
    if (id in prev.byId && !(id in st.byId)) closeTerminalFind(id);
  }
});

/** The terminal's query, "" until one is typed; null while its bar is closed (or for no terminal). */
export function useTerminalFindQuery(id: string | null): string | null {
  return useTerminalFindStore((s) => (id === null ? null : (s.byTerminal[id]?.query ?? null)));
}

export function useTerminalFindFocusSeq(id: string): number {
  return useTerminalFindStore((s) => s.byTerminal[id]?.focusSeq ?? 0);
}

export function useTerminalFindResults(id: string): FindResults {
  return useTerminalFindStore((s) => s.byTerminal[id]?.results ?? NO_RESULTS);
}
