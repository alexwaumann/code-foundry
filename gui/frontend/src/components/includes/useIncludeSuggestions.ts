import { useEffect, useState } from "react";
import { suggestIncludeIgnored, type IncludeSuggestionsView } from "@/api/filesystem";
import { errorMessage, isAbort } from "@/api/stream";

/** A burst of keystrokes asks once. */
export const SUGGEST_DEBOUNCE_MS = 100;
/** Suggestions asked for: about eight show, the rest scroll. */
export const SUGGEST_LIMIT = 20;

/** SuggestIncludeIgnored, replaceable in tests. */
export type SuggestFn = typeof suggestIncludeIgnored;

export interface SuggestState {
  /** The text `view` answers; null before the first answer. */
  answered: string | null;
  view: IncludeSuggestionsView | null;
  /** The last ask failed (its message). */
  error: string | null;
}

const NOTHING: SuggestState = { answered: null, view: null, error: null };

/**
 * The include field's suggestions for a project while `open`: asked again on each change of
 * the text (debounced; a newer text or a closed field aborts the ask out), and on `rev`
 * (the patterns changed, so `included` did). The last answer stays until the next lands.
 */
export function useIncludeSuggestions(projectId: string, text: string, open: boolean, rev: string, suggest: SuggestFn = suggestIncludeIgnored): SuggestState {
  const [state, setState] = useState<SuggestState>(NOTHING);
  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      suggest({ projectId, text, limit: SUGGEST_LIMIT }, undefined, ctl.signal).then(
        (view) => {
          if (!ctl.signal.aborted) setState({ answered: text, view, error: null });
        },
        (err: unknown) => {
          if (ctl.signal.aborted || isAbort(err)) return;
          setState({ answered: text, view: null, error: errorMessage(err) });
        },
      );
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [projectId, text, open, rev, suggest]);
  return state;
}
