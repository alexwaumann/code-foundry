/**
 * The composers the "Previous prompts" picker can open in (a registry, like stores/cite.ts's
 * targets) and composer.history's presentation (docs/notes/prompt-history-2-picker.md).
 * Kept apart from stores/promptHistory.ts so stores/views.ts and keys/bindings.ts do not
 * pull the compose store in.
 */
import { useUiStore } from "./ui";

/** Where a composer's Project scope reads: its thread, or its project set (none: the threads without a project). */
export interface PromptSource {
  threadId?: string;
  projectIds?: readonly string[];
}

/** A mounted composer the picker can open in. */
export interface HistoryComposer {
  /** The composer's draft. */
  draftKey: string;
  /** Its root element: the command opens the picker in the composer that has the keyboard. */
  root: () => HTMLElement | null;
  /** Opens its picker. */
  open: () => void;
  /** Its Project scope's source (the palette lists the same). */
  source: () => PromptSource;
  /** Focuses its prompt, caret at the end. */
  focus: () => void;
}

const composers = new Set<HistoryComposer>();

/** A composer registers while mounted. Returns the unregister. */
export function registerHistoryComposer(c: HistoryComposer): () => void {
  composers.add(c);
  return () => {
    composers.delete(c);
  };
}

/** The mounted composer of a draft, if any. */
export function historyComposer(draftKey: string): HistoryComposer | undefined {
  for (const c of composers) if (c.draftKey === draftKey) return c;
  return undefined;
}

/**
 * composer.history in this window: the picker of the composer that has the keyboard, else
 * the palette's prompts page (deferred: picked in the palette, the palette closes after
 * the presenter runs).
 */
export function presentPromptHistory(): boolean {
  const active = document.activeElement;
  if (!useUiStore.getState().palette.open && active) {
    for (const c of composers) {
      if (c.root()?.contains(active)) {
        c.open();
        return true;
      }
    }
  }
  queueMicrotask(() => {
    useUiStore.getState().openPromptsPalette();
  });
  return true;
}
