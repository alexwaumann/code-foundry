/**
 * The citation flow's shared state (docs/notes/citations.md): which composer chip's
 * comment is being edited, and the hand-offs between the pieces that do not share a
 * React tree: the thread's cite layer inserts a new citation into the composer
 * (registerCiteTarget), a composer chip or a sent chip asks the cite layer to go to the
 * quote's source (requestEdit, requestFlash), and the cite layer asks the timeline to
 * bring the quoted item's row into view (registerTimeline).
 */
import { create } from "zustand";
import type { CitationBody } from "@/lib/citation";

export interface CiteState {
  /** The composer chip whose comment the cite layer edits (the chip gets a ring). */
  editing: { draftKey: string; citationId: string } | null;
  /** A sent chip's "Go to source": the cite layer scrolls to the quote and flashes it. */
  flash: { threadId: string; cite: CitationBody; seq: number } | null;
}

export const useCiteStore = create<CiteState>()(() => ({ editing: null, flash: null }));

/** A composer chip was clicked: edit its comment, at its source when that is on screen. */
export function requestEdit(draftKey: string, citationId: string): void {
  useCiteStore.setState({ editing: { draftKey, citationId } });
}

export function endEdit(): void {
  useCiteStore.setState((s) => (s.editing ? { editing: null } : s));
}

/** Whether a composer chip is the one being edited. */
export function useEditingCitation(draftKey: string, citationId: string): boolean {
  return useCiteStore((s) => s.editing?.draftKey === draftKey && s.editing.citationId === citationId);
}

let flashSeq = 0;

/** Go to source: the visible thread's cite layer scrolls to the quote and flashes it. */
export function requestFlash(threadId: string, cite: CitationBody): void {
  useCiteStore.setState({ flash: { threadId, cite, seq: ++flashSeq } });
}

/** The cite layer acts on a Go to source request: forget it, so it is not replayed when a layer mounts again. */
export function takeFlash(seq: number): void {
  useCiteStore.setState((s) => (s.flash?.seq === seq ? { flash: null } : s));
}

/** What a composer offers the cite layer. */
export interface CiteTarget {
  /** Inserts a citation tag at the caret and focuses the prompt after it. */
  insert(citationId: string): void;
  /** Focuses the prompt with a collapsed caret (a clicked chip is no longer selected, so typing does not replace it). */
  focus(): void;
}

const targets = new Map<string, CiteTarget>();

/** A composer offers to take citations (the thread composer, by its draft key). Returns the unregister. */
export function registerCiteTarget(draftKey: string, target: CiteTarget): () => void {
  targets.set(draftKey, target);
  return () => {
    if (targets.get(draftKey) === target) targets.delete(draftKey);
  };
}

/** Inserts a citation tag into a draft's composer; false when no composer of that draft is mounted. */
export function insertCite(draftKey: string, citationId: string): boolean {
  const t = targets.get(draftKey);
  t?.insert(citationId);
  return t !== undefined;
}

/** Back to the draft's prompt after a chip's comment was edited. */
export function focusCiteTarget(draftKey: string): void {
  targets.get(draftKey)?.focus();
}

/** What a thread's timeline offers the cite layer. */
export interface TimelineHandle {
  /** The scrolling list. */
  scroller: HTMLElement;
  /**
   * Brings the row with this key into view (scrolling only when it is not mounted and in
   * view already); false when no row has that key (its turn is folded).
   */
  showRow(key: string): boolean;
  /** Stops following the bottom, before a scroll of the cite layer's own. */
  unpin(): void;
}

const timelines = new Map<string, TimelineHandle>();

/** The thread's timeline registers itself while mounted. Returns the unregister. */
export function registerTimeline(threadId: string, handle: TimelineHandle): () => void {
  timelines.set(threadId, handle);
  return () => {
    if (timelines.get(threadId) === handle) timelines.delete(threadId);
  };
}

export function getTimeline(threadId: string): TimelineHandle | undefined {
  return timelines.get(threadId);
}
