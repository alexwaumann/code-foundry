import { useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { dismissCard, groupSkills, nextCard, type CardMemo, type CardShow, type TriggerChar } from "@/lib/completion";
import type { PromptTag } from "@/lib/prompt";
import { useSkills } from "@/stores/skills";
import type { CompletionKey, EditorTrigger, PromptEditorHandle } from "./PromptEditor";

/** One row of the completion card. */
export interface CompletionItem {
  key: string;
  /** Bold: `/deploy`. */
  label: string;
  /** Muted, after the label (may be empty). */
  detail: string;
  /** What Enter puts into the prompt. */
  tag: PromptTag;
}

/** A group of rows under an optional heading: a project (dot + name) or "User". */
export interface CompletionGroup {
  key: string;
  heading: { kind: "project"; repoId: string } | { kind: "user" } | null;
  items: CompletionItem[];
}

/** A completion source: the rows for a trigger's query, and whether it has anything at all. */
export interface CompletionSource {
  char: TriggerChar;
  /** False while nothing is loaded, on an outdated daemon, or with nothing to offer: no card. */
  available: boolean;
  groups: CompletionGroup[];
  /** "No skills match". */
  emptyText: string;
}

/**
 * Skills after "/" (stores/skills.ts, loaded by the composer for `sourcesKey`): grouped
 * by project in member order with headings when the draft has more than one project,
 * then the user's under "User".
 */
export function useSkillSource(trigger: EditorTrigger | null, sourcesKey: string, members: readonly string[]): CompletionSource {
  const skills = useSkills(sourcesKey);
  const query = trigger?.char === "/" ? trigger.query : null;
  const groups = useMemo<CompletionGroup[]>(() => {
    if (query === null) return [];
    const multi = members.length > 1;
    return groupSkills(skills, query, members).map((g) => ({
      key: g.repoId || "~",
      heading: g.repoId === "" ? { kind: "user" } : multi ? { kind: "project", repoId: g.repoId } : null,
      items: g.skills.map((s) => ({
        key: `${g.repoId}/${s.name}`,
        label: `/${s.name}`,
        detail: s.description,
        tag: { tagKind: "skill", name: s.name, repoId: g.repoId },
      })),
    }));
  }, [skills, query, members]);
  return { char: "/", available: skills.length > 0, groups, emptyText: "No skills match" };
}

/** What the composer renders and wires: the card's model and the editor's hooks into it. */
export interface Completion {
  show: CardShow;
  groups: CompletionGroup[];
  emptyText: string;
  /** Index into the flattened rows. */
  selected: number;
  listId: string;
  optionId: (index: number) => string;
  /** For the editor's aria-controls / aria-activedescendant while open. */
  aria: { controls: string; active: string } | null;
  onTrigger: (t: EditorTrigger | null) => void;
  onKey: (k: CompletionKey) => boolean;
  select: (index: number) => void;
  insert: (index: number) => void;
}

interface CardState {
  /** The inputs the state was derived from (trigger position, query, row count). */
  key: string;
  memo: CardMemo | null;
  show: CardShow;
  selected: number;
}

const CLOSED: CardState = { key: "", memo: null, show: "none", selected: 0 };

/**
 * The completion card of a prompt editor: which trigger is at the caret (reported by the
 * editor), what the source offers for it, when the card shows (lib/completion nextCard:
 * the no-match keystroke, Escape), the selected row, and inserting a row as a tag.
 * `trigger` and `setTrigger` are held by the caller, which also builds the source from
 * the trigger.
 */
export function useCompletion(
  trigger: EditorTrigger | null,
  setTrigger: (t: EditorTrigger | null) => void,
  source: CompletionSource,
  editorRef: RefObject<PromptEditorHandle | null>,
): Completion {
  const listId = useId();
  const items = useMemo(() => source.groups.flatMap((g) => g.items), [source.groups]);
  const live = trigger !== null && trigger.char === source.char && source.available ? { at: trigger.from, query: trigger.query } : null;
  const key = live ? `${String(live.at)}\u0001${live.query}\u0001${String(items.length)}` : "";

  const [state, setState] = useState<CardState>(CLOSED);
  let cur = state;
  if (state.key !== key) {
    // Derived from the trigger and the rows: recomputed during render when they change.
    const r = nextCard(state.memo, live, items.length);
    cur = { key, memo: r.memo, show: r.show, selected: 0 };
    setState(cur);
  }

  // The editor calls onKey from its own handlers: it reads the latest render through this.
  const latest = useRef({ cur, items, trigger, live });
  useLayoutEffect(() => {
    latest.current = { cur, items, trigger, live };
  });

  const insert = (index: number) => {
    const { items: rows, trigger: t } = latest.current;
    const item = rows[index];
    if (!item || !t) return;
    editorRef.current?.insertTag({ from: t.from, to: t.to }, item.tag);
  };

  const select = (index: number) => {
    setState((s) => (s.selected === index ? s : { ...s, selected: index }));
  };

  const onKey = (k: CompletionKey): boolean => {
    const { cur: c, items: rows, live: l } = latest.current;
    if (c.show === "none" || !l) return false;
    if (k === "escape" || (c.show === "empty" && k === "enter")) {
      setState((s) => ({ ...s, memo: dismissCard(l), show: "none" }));
      return true;
    }
    if (c.show === "empty") return false;
    if (k === "up" || k === "down") {
      const n = rows.length;
      setState((s) => ({ ...s, selected: (s.selected + (k === "down" ? 1 : n - 1)) % n }));
      return true;
    }
    insert(c.selected);
    return true;
  };

  const optionId = (index: number) => `${listId}-${String(index)}`;
  const open = cur.show === "list";
  return {
    show: cur.show,
    groups: source.groups,
    emptyText: source.emptyText,
    selected: cur.selected,
    listId,
    optionId,
    aria: open ? { controls: listId, active: optionId(cur.selected) } : null,
    onTrigger: setTrigger,
    onKey,
    select,
    insert,
  };
}
