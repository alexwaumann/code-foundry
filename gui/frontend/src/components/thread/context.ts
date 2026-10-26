import { createContext, useContext, type ReactNode } from "react";
import type { PathPlaceSource } from "@/lib/pathChips";

/** The thread a timeline row belongs to, and its worktree (paths inside it are shown relative). */
export interface ThreadCtx {
  threadId: string;
  cwd: string;
}

export const ThreadContext = createContext<ThreadCtx>({ threadId: "", cwd: "" });

export function useThreadCtx(): ThreadCtx {
  return useContext(ThreadContext);
}

/**
 * Keeps a timeline row where it is on screen across the next change of rows (Timeline):
 * a header calls it with its row key before it folds or unfolds its turn. A no-op outside
 * a Timeline.
 */
export const KeepRowContext = createContext<(rowKey: string) => void>(() => undefined);

/**
 * Holds an element's top where it is on screen while it resizes (lib/timelineHold.ts): a page
 * card calls it with itself just before it takes a new height its frame asked for while the
 * pointer or focus is in that frame, so the card does not slide under the pointer as the
 * timeline follows its bottom (docs/notes/page-library-fixes-b.md). A no-op outside a Timeline.
 */
export const HoldTopContext = createContext<(el: HTMLElement) => void>(() => undefined);

/**
 * Where path chips (PathChip) resolve relative paths, when not the enclosing thread's: the
 * File tab's rendered markdown provides its tab's project and base (the thread checkout the
 * tab was opened from); Ember's chat a function that resolves only absolute paths under a
 * project (a refused path stays plain code). Null: the thread's (ThreadContext's cwd and
 * its project).
 */
export const PathPlaceContext = createContext<PathPlaceSource | null>(null);

/**
 * What renders a finished text item's markdown in a text row (TextRow), when a chat has
 * its own: Ember's splits out its task links as pointer lines. Null: ThreadMarkdown.
 */
export const TextMarkdownContext = createContext<((text: string) => ReactNode) | null>(null);
