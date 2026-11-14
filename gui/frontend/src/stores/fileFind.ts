import { create } from "zustand";
import type { FileMatchKey } from "@/lib/fileFind";
import { subscribeTabs } from "@/shell/host";
import { useUiStore } from "./ui";

/**
 * The find in a File tab (docs/notes/file-find-in-file.md): one session per tab per panel
 * (the File tab's edit key, `panelKey + tab id`) while its bar is open. A session belongs to
 * the tab, not to its mode: turning the pencil on or off keeps the bar, its query and its
 * current match. The matches are the tab body's (components/files/FileFind.tsx), which
 * reports what they come to; only what is asked for, and the current match, are here.
 */
interface FindSession {
  query: string;
  /** Raised to ask the bar's field to take the keyboard and select its query. */
  focusSeq: number;
  /** The last request the bar took: a bar that comes back with its tab does not take the keyboard. */
  focusedSeq: number;
  /** The current match; null before one is (no query, no match). */
  current: FileMatchKey | null;
  /** Raised when the current match should be brought into view (a step, a new query). */
  revealSeq: number;
  /** "n of m" as the body last counted. */
  index: number;
  total: number;
  capped: boolean;
  /** The editor's document while it edits, as it changes (the tab passes its seed otherwise). */
  draft: string | null;
}

interface FileFindState {
  byTab: Readonly<Record<string, FindSession>>;
}

export const useFileFindStore = create<FileFindState>(() => ({ byTab: {} }));

const EMPTY: FindSession = { query: "", focusSeq: 0, focusedSeq: 0, current: null, revealSeq: 0, index: -1, total: 0, capped: false, draft: null };

function update(key: string, change: (s: FindSession | undefined) => FindSession | undefined): void {
  useFileFindStore.setState((st) => {
    const prev = st.byTab[key];
    const next = change(prev);
    if (next === prev) return st;
    if (next) return { byTab: { ...st.byTab, [key]: next } };
    const { [key]: _gone, ...rest } = st.byTab;
    return { byTab: rest };
  });
}

export function fileFindOf(key: string): FindSession | undefined {
  return useFileFindStore.getState().byTab[key];
}

/** Opens the tab's bar, or asks an open one to take the keyboard and select its query. */
export function openFileFind(key: string): void {
  update(key, (s) => {
    const base = s ?? EMPTY;
    return { ...base, focusSeq: base.focusSeq + 1 };
  });
  hosts.get(key)?.opened();
}

/** Closes the bar: the highlights go; the body puts the keyboard back (FileFindBar). */
export function closeFileFind(key: string): void {
  update(key, () => undefined);
}

export function setFileFindQuery(key: string, query: string): void {
  update(key, (s) => (s && s.query !== query ? { ...s, query } : s));
}

/** The body's count. */
export function setFileFindCount(key: string, index: number, total: number, capped: boolean): void {
  update(key, (s) => (s && (s.index !== index || s.total !== total || s.capped !== capped) ? { ...s, index, total, capped } : s));
}

/** Makes a match current; `reveal` brings it into view. */
export function setFileFindCurrent(key: string, current: FileMatchKey | null, reveal: boolean): void {
  update(key, (s) => {
    if (!s) return s;
    const same = s.current?.line === current?.line && s.current?.nth === current?.nth;
    if (same && !reveal) return s;
    return { ...s, current, revealSeq: reveal ? s.revealSeq + 1 : s.revealSeq };
  });
}

/** The editor's document changed: only kept while the tab's bar is open. */
export function setFileFindDraft(key: string, draft: string | null): void {
  update(key, (s) => (s && s.draft !== draft ? { ...s, draft } : s));
}

/** The bar acted on focus requests up to `seq`. */
export function fileFindFocused(key: string, seq: number): void {
  update(key, (s) => (s ? { ...s, focusedSeq: seq } : s));
}

/** What a File tab on screen with something to search does for the store. */
export interface FileFindHost {
  /** The tab's root: the keyboard in it means this tab. */
  root: HTMLElement;
  /** Goes to the next (1) or previous (-1) match. */
  step: (dir: 1 | -1) => void;
  /** The bar opened or was asked for again (the editor's own find panel closes). */
  opened: () => void;
  /** The bar is closing: the keyboard goes back to the code, the current match selected. */
  finish: () => void;
  /** The editor's own find panel is opening (cmd+alt+F, replace): it takes the query. */
  handOff: (query: string) => void;
}

/** The File tabs on screen that can search, by key. */
const hosts = new Map<string, FileFindHost>();
let lastKeyboard: string | null = null;

/** The tab can search until the returned release runs. */
export function registerFileFindHost(key: string, host: FileFindHost): () => void {
  hosts.set(key, host);
  return () => {
    if (hosts.get(key) === host) hosts.delete(key);
  };
}

/** Escape or × in the bar: the keyboard goes back to the code, then the session ends. */
export function finishFileFind(key: string): void {
  hosts.get(key)?.finish();
  closeFileFind(key);
}

/** The searchable File tab an element is in (the keymap's target: the shadow host for the code); null for none. */
export function fileFindTabAt(el: Element | null): string | null {
  if (!el) return null;
  for (const [key, h] of hosts) if (h.root.contains(el)) return key;
  return null;
}

/**
 * The editor's own find and replace panel is opening in this tab (cmd+alt+F, which stays
 * the library's): one find at a time, so the bar closes and its query goes there.
 */
export function handOffFileFind(key: string): void {
  const s = fileFindOf(key);
  if (!s) return;
  closeFileFind(key);
  if (s.query !== "") hosts.get(key)?.handOff(s.query);
}

/** Whether some File tab on screen can search: the palette lists the verbs only then. */
export function canSearchFile(): boolean {
  return hosts.size > 0;
}

/** The keyboard went into this tab: where a find from the palette or the CLI goes. */
export function noteFileKeyboard(key: string): void {
  lastKeyboard = key;
}

/** Goes to the next (1) or previous (-1) match, wrapping. With the bar closed it opens instead. */
export function stepFileFind(key: string, dir: 1 | -1): void {
  if (fileFindOf(key)) hosts.get(key)?.step(dir);
  else openFileFind(key);
}

/** The File tab with the keyboard (its code, editor, bar or header): the shadow host is what `activeElement` shows of an editor. */
function keyboardTab(): string | null {
  return fileFindTabAt(document.activeElement);
}

/**
 * file.search, file.search.next and file.search.previous in this window (keys/bindings.ts,
 * stores/views.ts): on the File tab with the keyboard, else (the palette has it, or the CLI
 * asked) the last one that had it, else one on screen. True when a tab was there to act on.
 */
export function presentFileFind(action: "open" | "next" | "previous"): boolean {
  const last = lastKeyboard !== null && hosts.has(lastKeyboard) ? lastKeyboard : null;
  const key = keyboardTab() ?? last ?? hosts.keys().next().value;
  if (key === undefined) return false;
  afterPalette(() => {
    if (action === "open") openFileFind(key);
    else stepFileFind(key, action === "next" ? 1 : -1);
  });
  return true;
}

/** Picked in the palette, which hands the keyboard back as it closes: the bar takes it after that. */
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

// A tab that closes takes its session with it (the key is fileEditKey's: panel key, NUL, tab id).
subscribeTabs((places) => {
  for (const key of Object.keys(useFileFindStore.getState().byTab)) {
    const [panelKey = "", tabId = ""] = key.split("\u0000");
    if (!places[panelKey]?.tabs.some((t) => t.id === tabId)) closeFileFind(key);
  }
});

/** The tab's query, "" until one is typed; null while its bar is closed. */
export function useFileFindQuery(key: string): string | null {
  return useFileFindStore((s) => s.byTab[key]?.query ?? null);
}

export function useFileFindOpen(key: string): boolean {
  return useFileFindStore((s) => s.byTab[key] !== undefined);
}

export function useFileFindFocusSeq(key: string): number {
  return useFileFindStore((s) => s.byTab[key]?.focusSeq ?? 0);
}

export function useFileFindCurrent(key: string): FileMatchKey | null {
  return useFileFindStore((s) => s.byTab[key]?.current ?? null);
}

export function useFileFindRevealSeq(key: string): number {
  return useFileFindStore((s) => s.byTab[key]?.revealSeq ?? 0);
}

export function useFileFindDraft(key: string): string | null {
  return useFileFindStore((s) => s.byTab[key]?.draft ?? null);
}

/** The count the bar shows. */
export function useFileFindCount(key: string): { index: number; total: number; capped: boolean } {
  const index = useFileFindStore((s) => s.byTab[key]?.index ?? -1);
  const total = useFileFindStore((s) => s.byTab[key]?.total ?? 0);
  const capped = useFileFindStore((s) => s.byTab[key]?.capped ?? false);
  return { index, total, capped };
}
