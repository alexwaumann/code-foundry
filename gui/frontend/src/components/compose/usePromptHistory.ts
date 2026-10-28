import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { errorMessage } from "@/api/stream";
import { listPrompts, type ListPromptsOptions, type PromptScopeView, type SentPromptView } from "@/api/thread";
import { FILTER_PLACEHOLDER, moveSelection, nextScope, opensPicker, pickerAction, pickerHeading, PROMPT_LIMIT } from "@/lib/promptHistory";
import { proseOf } from "@/lib/prompt";
import { registerHistoryComposer, type PromptSource } from "@/stores/historyComposers";
import { copyPrompt, insertPrompt, revealPrompt } from "@/stores/promptHistory";
import { useDraft } from "@/stores/compose";
import type { PromptEditorHandle } from "./PromptEditor";

/** The prompts for a scope and filter, as the card and the palette show them. */
export interface PromptList {
  /** "loading" until the first answer for this scope (a new filter keeps the last answer meanwhile). */
  status: "loading" | "ready" | "error";
  prompts: readonly SentPromptView[];
  /** More prompts than the list shows exist. */
  more: boolean;
  error: string;
}

const LOADING: PromptList = { status: "loading", prompts: [], more: false, error: "" };

/** The body's text while there are no rows: loading, an error, nothing yet, nothing matching; null with rows. */
export function listStatusText(list: PromptList, query: string): string | null {
  if (list.status === "loading") return "Loading previous prompts…";
  if (list.status === "error") return `Cannot list prompts: ${list.error}`;
  if (list.prompts.length === 0) return query ? "No matches" : "No prompts yet";
  return null;
}

/** How long typing settles before the filter asks the daemon again. */
const FILTER_DEBOUNCE_MS = 150;

/** ListPrompts' request for a scope: the composer's thread, its Project source, or every thread. */
export function promptRequest(scope: PromptScopeView, threadId: string, source: PromptSource, query: string): ListPromptsOptions {
  const base = { query, limit: PROMPT_LIMIT + 1 };
  if (scope === "thread") return { ...base, scope, threadId };
  if (scope === "project") return source.threadId ? { ...base, scope, threadId: source.threadId } : { ...base, scope, projectIds: source.projectIds ?? [] };
  return { ...base, scope };
}

function sourceKey(scope: PromptScopeView, threadId: string, source: PromptSource): string {
  if (scope === "thread") return `t:${threadId}`;
  if (scope === "project") return source.threadId ? `pt:${source.threadId}` : `p:${(source.projectIds ?? []).join(",")}`;
  return "a";
}

/**
 * ThreadService.ListPrompts for the open picker or palette page (newest first, one more
 * than PROMPT_LIMIT to know about more). A new scope (or a new opening: `openSeq`) asks at
 * once and shows "loading"; a new filter asks after FILTER_DEBOUNCE_MS and keeps the last
 * answer until it lands. Answers for an older request are dropped.
 */
export function usePromptList(opts: { open: boolean; openSeq: number; scope: PromptScopeView; threadId: string; source: PromptSource; query: string }): PromptList {
  const { open, openSeq, scope, threadId, source, query } = opts;
  const key = `${String(openSeq)}\u0001${sourceKey(scope, threadId, source)}`;
  const [answer, setAnswer] = useState<{ key: string; list: PromptList }>({ key: "", list: LOADING });
  const answeredKey = useRef("");
  // The request the effect sends, from this render (a layout effect runs before it).
  const req = useRef<ListPromptsOptions | null>(null);
  useLayoutEffect(() => {
    req.current = promptRequest(scope, threadId, source, query);
  });
  useEffect(() => {
    if (!open) return;
    let live = true;
    const fresh = answeredKey.current !== key;
    const ask = req.current;
    if (!ask) return;
    const timer = setTimeout(
      () => {
        listPrompts(ask)
          .then((res) => {
            if (!live) return;
            answeredKey.current = key;
            setAnswer({ key, list: { status: "ready", prompts: res.slice(0, PROMPT_LIMIT), more: res.length > PROMPT_LIMIT, error: "" } });
          })
          .catch((err: unknown) => {
            if (!live) return;
            answeredKey.current = key;
            setAnswer({ key, list: { status: "error", prompts: [], more: false, error: errorMessage(err) } });
          });
      },
      fresh ? 0 : FILTER_DEBOUNCE_MS,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, key, query]);
  return answer.key === key ? answer.list : LOADING;
}

/** What the picker card renders (components/compose/PromptHistoryCard.tsx). */
export interface PromptPickerModel {
  open: boolean;
  heading: string;
  scope: PromptScopeView;
  /** "This thread" can be picked (a thread's composer). */
  threadScope: boolean;
  setScope: (s: PromptScopeView) => void;
  list: PromptList;
  /** The filter (the composer's text). */
  query: string;
  selected: number;
  listId: string;
  optionId: (index: number) => string;
  select: (index: number) => void;
  pick: (index: number) => void;
  show: (index: number) => void;
}

export interface PromptPicker {
  card: PromptPickerModel;
  /** The editor's keys first (PromptEditor onKeyDown): Up opens, then the card's keys. */
  onKeyDown: (e: KeyboardEvent, selectionEmpty: boolean) => boolean;
  /** The editor's placeholder while open; undefined otherwise. */
  placeholder: string | undefined;
  /** For the editor's aria-controls / aria-activedescendant while open. */
  aria: { controls: string; active: string } | null;
  /** Focus left the composer (its root's onBlur): the picker closes. */
  onBlur: (e: React.FocusEvent) => void;
}

/**
 * The "Previous prompts" picker of a composer (docs/notes/prompt-history-2-picker.md):
 * Up in the empty prompt (`canOpen`: no text, attachments, open menus or docked
 * prompts) or composer.history opens it, in `defaultScope`. While open the composer's
 * text is the filter; the card's keys are lib/promptHistory pickerAction's. Enter puts
 * the selected prompt in the draft, cmd+Enter shows it in its thread, cmd+C copies it,
 * cmd+S cycles the scope, Escape closes and leaves the typed text as the draft. The
 * composer registers here for composer.history (stores/promptHistory.ts).
 */
export function usePromptPicker(opts: {
  draftKey: string;
  editorRef: RefObject<PromptEditorHandle | null>;
  rootRef: RefObject<HTMLElement | null>;
  /** The composer's thread ("" for the new-thread composer: no This thread scope). */
  threadId: string;
  /** Where Project reads. */
  source: PromptSource;
  canOpen: boolean;
  /** The composer cannot take the picker now (a send in flight, prompts docked): it closes. */
  blocked: boolean;
}): PromptPicker {
  const { draftKey, editorRef, rootRef, threadId, source, canOpen, blocked } = opts;
  const threadScope = threadId !== "";
  const defaultScope: PromptScopeView = threadScope ? "thread" : "project";
  const [state, setState] = useState<{ open: boolean; seq: number; scope: PromptScopeView; selected: number }>({ open: false, seq: 0, scope: defaultScope, selected: 0 });
  const text = useDraft(draftKey, "text");
  const query = state.open ? proseOf(text).trim() : "";
  const list = usePromptList({ open: state.open, openSeq: state.seq, scope: state.scope, threadId, source, query });
  const listId = useId();
  const optionId = (i: number) => `${listId}-${String(i)}`;
  const count = list.prompts.length;
  const selected = Math.min(state.selected, Math.max(0, count - 1));

  // A new filter or scope starts at the newest row again.
  const filterKey = `${state.scope}\u0001${query}`;
  const [seenFilter, setSeenFilter] = useState(filterKey);
  if (seenFilter !== filterKey) {
    setSeenFilter(filterKey);
    setState((s) => (s.selected === 0 ? s : { ...s, selected: 0 }));
  }

  const latest = useRef({ state, list, selected, canOpen: canOpen && !blocked, blocked, threadScope, defaultScope, source });
  useLayoutEffect(() => {
    latest.current = { state, list, selected, canOpen: canOpen && !blocked, blocked, threadScope, defaultScope, source };
  });

  const openPicker = () => {
    setState((s) => ({ open: true, seq: s.seq + 1, scope: latest.current.defaultScope, selected: 0 }));
  };
  const close = () => {
    setState((s) => (s.open ? { ...s, open: false } : s));
  };
  // Another draft (the composer now shows another thread): closed.
  useEffect(
    () => () => {
      setState((s) => (s.open ? { ...s, open: false } : s));
    },
    [draftKey],
  );
  if (blocked && state.open) setState((s) => ({ ...s, open: false }));

  const prompt =(i: number) => latest.current.list.prompts[i];
  const pick = (i: number) => {
    const p = prompt(i);
    close();
    if (!p) return;
    insertPrompt(draftKey, p);
    // After the editor has rebuilt from the new text.
    requestAnimationFrame(() => editorRef.current?.focusCollapsed());
  };
  const show = (i: number) => {
    const p = prompt(i);
    if (!p) return;
    close();
    revealPrompt(p);
  };
  const select = (i: number) => {
    setState((s) => (s.selected === i ? s : { ...s, selected: i }));
  };
  const setScope = (scope: PromptScopeView) => {
    if (scope === "thread" && !latest.current.threadScope) return;
    setState((s) => (s.scope === scope ? s : { ...s, scope, selected: 0 }));
  };

  useEffect(
    () =>
      registerHistoryComposer({
        draftKey,
        root: () => rootRef.current,
        open: () => {
          if (latest.current.blocked) return;
          openPicker();
          editorRef.current?.focus();
        },
        source: () => latest.current.source,
        focus: () => editorRef.current?.focusCollapsed(),
      }),
    [draftKey, rootRef, editorRef],
  );

  const onKeyDown = (e: KeyboardEvent, selectionEmpty: boolean): boolean => {
    const { state: s, list: l, selected: sel, canOpen: may, threadScope: ts } = latest.current;
    if (!s.open) {
      if (!opensPicker(e, may)) return false;
      openPicker();
      return true;
    }
    const a = pickerAction(e, selectionEmpty);
    if (!a) return false;
    switch (a.kind) {
      case "move":
        select(moveSelection(sel, a.by, l.prompts.length));
        return true;
      case "use":
        pick(sel);
        return true;
      case "show":
        show(sel);
        return true;
      case "copy": {
        const p = l.prompts[sel];
        if (!p) return false;
        void copyPrompt(p);
        return true;
      }
      case "scope":
        setScope(nextScope(s.scope, ts));
        return true;
      case "close":
        close();
        return true;
    }
  };

  const onBlur = (e: React.FocusEvent) => {
    if (!latest.current.state.open) return;
    // Another app took the window's focus: the picker is still there on return.
    if (!document.hasFocus()) return;
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    close();
  };

  const loaded = list.status === "ready";
  return {
    card: {
      open: state.open,
      heading: pickerHeading({ count, more: list.more, filtering: query !== "", loaded }),
      scope: state.scope,
      threadScope,
      setScope,
      list,
      query,
      selected,
      listId,
      optionId,
      select,
      pick,
      show,
    },
    onKeyDown,
    placeholder: state.open ? FILTER_PLACEHOLDER : undefined,
    aria: state.open && count > 0 ? { controls: listId, active: optionId(selected) } : null,
    onBlur,
  };
}
