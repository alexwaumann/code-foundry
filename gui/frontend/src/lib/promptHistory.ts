/**
 * The "Previous prompts" picker's pure parts (docs/notes/prompt-history-2-picker.md): the
 * scopes and their cycle, the keys the open card takes, the header's count, a row's
 * relative age and the filter's hit ranges.
 */
import type { PromptScopeView } from "@/api/thread";

/** How many prompts the picker lists. It asks for one more to know whether there are more. */
export const PROMPT_LIMIT = 50;

/** The scopes in the toggle's order. */
export const PROMPT_SCOPES: readonly PromptScopeView[] = ["thread", "project", "all"];

export const SCOPE_LABELS: Readonly<Record<PromptScopeView, string>> = { thread: "This thread", project: "Project", all: "All" };

/** The editor's placeholder while the picker is open: the prompt is now its filter. */
export const FILTER_PLACEHOLDER = "Type to filter previous prompts";

/** The scope after `s` in the toggle's order, wrapping; "thread" is skipped without a thread. */
export function nextScope(s: PromptScopeView, threadScope: boolean): PromptScopeView {
  const scopes = threadScope ? PROMPT_SCOPES : PROMPT_SCOPES.filter((x) => x !== "thread");
  const i = scopes.indexOf(s);
  return scopes[(i + 1) % scopes.length] ?? "all";
}

/** A key event's parts the picker reads (a KeyboardEvent fits). */
export interface PickerKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** What a key does to the open picker. */
export type PickerAction = { kind: "move"; by: 1 | -1 } | { kind: "use" } | { kind: "show" } | { kind: "copy" } | { kind: "scope" } | { kind: "close" };

/**
 * The open picker's keys: Up and Down move, Enter uses, cmd+Enter shows the prompt in its
 * thread, cmd+C copies (only with nothing selected in the editor: a selection copies as
 * usual), cmd+S cycles the scope, Escape closes. Anything else is the editor's (typing
 * filters). Null: not the picker's.
 */
export function pickerAction(e: PickerKeyEvent, selectionEmpty: boolean): PickerAction | null {
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  const cmd = e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  if (plain) {
    switch (e.key) {
      case "ArrowUp":
        return { kind: "move", by: -1 };
      case "ArrowDown":
        return { kind: "move", by: 1 };
      case "Enter":
        return { kind: "use" };
      case "Escape":
        return { kind: "close" };
      default:
        return null;
    }
  }
  if (!cmd) return null;
  if (e.key === "Enter") return { kind: "show" };
  const k = e.key.toLowerCase();
  if (k === "s") return { kind: "scope" };
  if (k === "c" && selectionEmpty) return { kind: "copy" };
  return null;
}

/** Whether a key opens the picker: a plain Up while the composer may open it (empty, nothing else open). */
export function opensPicker(e: PickerKeyEvent, canOpen: boolean): boolean {
  return canOpen && e.key === "ArrowUp" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

/** The selection after moving `by` among `count` rows, wrapping. */
export function moveSelection(selected: number, by: 1 | -1, count: number): number {
  if (count <= 0) return 0;
  return (((selected + by) % count) + count) % count;
}

/**
 * The header: "Previous prompts", with " · N matches" while filtering and " · latest N"
 * when more prompts than the list shows exist (ListPrompts has no total: the picker asks
 * for one more than it shows).
 */
export function pickerHeading(state: { count: number; more: boolean; filtering: boolean; loaded: boolean }): string {
  const base = "Previous prompts";
  if (!state.loaded) return base;
  if (state.filtering) return `${base} · ${state.more ? `${String(state.count)}+` : String(state.count)} ${state.count === 1 && !state.more ? "match" : "matches"}`;
  return state.more ? `${base} · latest ${String(state.count)}` : base;
}

const DAY = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * A prompt's age beside its thread name: "now", "5m", "2h" within a day, then
 * "yesterday", "3d" within a week (by calendar days), then the date ("Oct 3"; the year too
 * when it is not this year's).
 */
export function relativeAge(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${String(Math.floor(diff / 60_000))}m`;
  if (diff < DAY) return `${String(Math.floor(diff / 3_600_000))}h`;
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY);
  if (days <= 1) return "yesterday";
  if (days < 7) return `${String(days)}d`;
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString([], sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** The ranges of `text` the filter matches (case-insensitive, not overlapping), for highlighting. */
export function hitRanges(text: string, query: string): [number, number][] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const lower = text.toLowerCase();
  const out: [number, number][] = [];
  for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) out.push([at, at + q.length]);
  return out;
}

/** A prompt on one line: whitespace runs (newlines included) as one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
