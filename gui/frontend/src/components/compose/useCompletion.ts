import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { SkillSourceView } from "@/api/filesystem";
import type { SlashCommandView } from "@/api/slashCommands";
import {
  commandItems,
  dismissCard,
  fileItems,
  fileSourcesKey,
  groupSkills,
  nextCard,
  type CardMemo,
  type CardShow,
  type CompletionGroup,
  type TriggerChar,
} from "@/lib/completion";
import { cancelFiles, requestFiles, useFilesEntry } from "@/stores/files";
import { useSkills } from "@/stores/skills";
import type { CompletionKey, EditorTrigger, PromptEditorHandle } from "./PromptEditor";

export type { CompletionGroup, CompletionItem } from "@/lib/completion";

/** A completion source: the rows for a trigger's query, and whether it has anything at all. */
export interface CompletionSource {
  char: TriggerChar;
  /** The listbox's accessible name: "Skills", "Files". */
  label: string;
  /** False while nothing is loaded, on an outdated daemon, or with nothing to offer: no card. */
  available: boolean;
  groups: CompletionGroup[];
  /**
   * The query `groups` answer: the trigger's for a source that answers at once, an earlier
   * one while an asynchronous source is still looking (null: nothing answered yet).
   */
  query: string | null;
  /** The answer for the trigger's query is taking long: the card says `searchingText`. */
  searching: boolean;
  /** "No skills match". */
  emptyText: string;
  /**
   * Nothing matching shows no card instead of `emptyText` (the `#` card: a number that is
   * not a pull request stays text, and Enter sends).
   */
  quietEmpty?: boolean;
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
      key: g.projectId || "~",
      heading: g.projectId === "" ? { kind: "user" } : multi ? { kind: "project", projectId: g.projectId } : null,
      items: g.skills.map((s) => ({
        key: `${g.projectId}/${s.name}`,
        label: `/${s.name}`,
        detail: s.description,
        tag: { tagKind: "skill", name: s.name, projectId: g.projectId },
      })),
    }));
  }, [skills, query, members]);
  return { char: "/", label: "Skills", available: skills.length > 0, groups, query, searching: false, emptyText: "No skills match" };
}

/**
 * A running thread's slash commands after "/" (stores/thread.ts useSlashCommands, what
 * "/name" will run), grouped by lib/completion commandItems: the skills the disk scan
 * (`sourcesKey`, loaded by the composer) knows keep their project and "User" groups and
 * their tags, other skills go under "Skills", Claude Code's own under "Claude Code" as
 * plain text. The composer uses it while the list is not empty, useSkillSource otherwise.
 */
export function useCommandSource(trigger: EditorTrigger | null, commands: readonly SlashCommandView[], sourcesKey: string, members: readonly string[]): CompletionSource {
  const skills = useSkills(sourcesKey);
  const query = trigger?.char === "/" ? trigger.query : null;
  const groups = useMemo<CompletionGroup[]>(() => (query === null ? [] : commandItems(commands, skills, query, members)), [commands, skills, query, members]);
  return { char: "/", label: "Slash commands", available: commands.length > 0, groups, query, searching: false, emptyText: "No commands match" };
}

/**
 * Files after "@" (stores/files.ts): asks for the trigger's query whenever it changes
 * (debounced there; nothing while the card is only navigated), and offers the latest
 * answer grouped by project, the primary first, with headings when the draft has more than
 * one project. On an outdated daemon nothing is offered.
 */
export function useFileSource(trigger: EditorTrigger | null, sources: readonly SkillSourceView[], members: readonly string[], primary: string): CompletionSource {
  const entry = useFilesEntry(fileSourcesKey(sources));
  const query = trigger?.char === "@" ? trigger.query : null;
  useEffect(() => {
    if (query === null) return;
    requestFiles(sources, query);
    return () => {
      cancelFiles(sources);
    };
  }, [sources, query]);
  const answered = entry?.answered ?? null;
  const results = entry?.results;
  const groups = useMemo<CompletionGroup[]>(
    () => (query === null || answered === null || !results ? [] : fileItems(results, answered, members, primary)),
    [query, answered, results, members, primary],
  );
  return {
    char: "@",
    label: "Files",
    available: entry?.outdated !== true,
    groups,
    query: query === null ? null : answered,
    searching: query !== null && answered !== query && entry?.searching === true,
    emptyText: "No files match",
  };
}

/** What the card shows: CardShow, or "searching" while a slow answer is awaited. */
export type CompletionShow = CardShow | "searching";

/** What the composer renders and wires: the card's model and the editor's hooks into it. */
export interface Completion {
  show: CompletionShow;
  label: string;
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
  /** The inputs the state was derived from (trigger position, answered query, row count). */
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
 *
 * An asynchronous source may answer an earlier query than the trigger's: while this
 * trigger has been answered before, the card goes on with the latest answer (as if that
 * query were typed); a trigger nothing has answered yet waits with the card closed and
 * Enter does nothing (it would send the half-typed reference) until Escape dismisses the
 * trigger. A slow answer shows
 * "Searching…".
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

  const [state, setState] = useState<CardState>(CLOSED);
  const answered =
    live && source.query !== null && (source.query === live.query || state.memo?.at === live.at) ? { at: live.at, query: source.query } : null;
  const key = answered ? `${String(answered.at)}\u0001${answered.query}\u0001${String(items.length)}` : live ? `${String(live.at)}\u0001wait` : "";
  let cur = state;
  if (state.key !== key) {
    // Derived from the trigger and the rows: recomputed during render when they change.
    const r = answered ? nextCard(state.memo, answered, items.length) : { show: "none" as const, memo: null };
    cur = { key, memo: r.memo, show: r.show, selected: 0 };
    setState(cur);
  }
  const dismissed = live !== null && cur.memo?.at === live.at && cur.memo.dismissed;
  const show: CompletionShow = live && source.searching && !dismissed ? "searching" : source.quietEmpty && cur.show === "empty" ? "none" : cur.show;
  // Nothing has answered this trigger yet: Enter must not send what is about to be completed.
  const waiting = live !== null && answered === null && !dismissed;

  // The editor calls onKey from its own handlers: it reads the latest render through this.
  const latest = useRef({ show, waiting, cur, items, trigger, live });
  useLayoutEffect(() => {
    latest.current = { show, waiting, cur, items, trigger, live };
  });

  const insert = (index: number) => {
    const { items: rows, trigger: t } = latest.current;
    const item = rows[index];
    if (!item || !t) return;
    const range = { from: t.from, to: t.to };
    if (typeof item.tag === "string") editorRef.current?.insertText(range, item.tag);
    else editorRef.current?.insertTag(range, item.tag);
  };

  const select = (index: number) => {
    setState((s) => (s.selected === index ? s : { ...s, selected: index }));
  };

  const onKey = (k: CompletionKey): boolean => {
    const { show: sh, waiting: w, cur: c, items: rows, live: l } = latest.current;
    if (sh === "none" && w && k === "enter") return true;
    // Escape before the first answer dismisses the trigger too (the card must not open
    // when the answer lands, and Enter sends again).
    if (!l || (sh === "none" && !(w && k === "escape"))) return false;
    if (k === "escape" || (sh !== "list" && k === "enter")) {
      setState((s) => ({ ...s, memo: dismissCard(l), show: "none" }));
      return true;
    }
    if (sh !== "list") return false;
    if (k === "up" || k === "down") {
      const n = rows.length;
      setState((s) => ({ ...s, selected: (s.selected + (k === "down" ? 1 : n - 1)) % n }));
      return true;
    }
    insert(c.selected);
    return true;
  };

  const optionId = (index: number) => `${listId}-${String(index)}`;
  const open = show === "list";
  return {
    show,
    label: source.label,
    groups: source.groups,
    emptyText: show === "searching" ? "Searching…" : source.emptyText,
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
