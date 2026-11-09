/**
 * A picker (pluginsdk/ui Select.Search): a dropdown select the plugin searches, modelled on
 * the reviewer picker (components/pr/reviewerSearch.ts) and Input.Live (form.ts liveSender).
 *
 * Before PICKER_MIN_CHARS characters it lists the select's options in their groups. From
 * then on, after PICKER_DEBOUNCE_MS without typing, the host sends the query (trimmed) as a
 * search act, one at a time with the newest last; the plugin answers with a view whose
 * search echoes that query. Until the view's query is the one in the box the picker shows
 * "Searching…": an answer to an older query is never shown.
 */
import type { SelectOption, SelectSearch } from "@/api/plugin";
import { liveSender, type LiveSender } from "./form";

/** The host searches from this many characters (trimmed) on (pluginsdk/ui SearchMinChars). */
export const PICKER_MIN_CHARS = 2;
/** Typing pause before the picker searches (the reviewer picker's). */
export const PICKER_DEBOUNCE_MS = 250;
/** How many values a multiple picker holds (pluginsdk/ui MaxPicked). */
export const PICKER_MAX_PICKED = 20;
/** How many chart colours an avatar's tone comes from (--cf-chart-1..6). */
export const AVATAR_TONES = 6;

/** The query the picker would send for its box: trimmed, or "" below the threshold. */
export function pickerTerm(input: string): string {
  const t = input.trim();
  // Code points, as the daemon counts them (a JavaScript length counts UTF-16 units).
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c < 0xdc00 || c > 0xdfff) n++; // a low surrogate ends a pair already counted
  }
  return n >= PICKER_MIN_CHARS ? t : "";
}

/** What the list shows for a term: the options (no term), the plugin's results for it, or "Searching…". */
export type PickerShows = { kind: "options" } | { kind: "results"; results: readonly SelectOption[] } | { kind: "searching" };

export function pickerShows(search: SelectSearch | undefined, term: string): PickerShows {
  if (term === "") return { kind: "options" };
  if (search?.query !== undefined && search.query.trim() === term) return { kind: "results", results: search.results ?? [] };
  return { kind: "searching" };
}

/** Options in their groups: in order of each group's first option; options without one under a heading of "". */
export function groupOptions(options: readonly SelectOption[]): { heading: string; options: SelectOption[] }[] {
  const out: { heading: string; options: SelectOption[] }[] = [];
  const at = new Map<string, number>();
  for (const o of options) {
    const g = o.group ?? "";
    let i = at.get(g);
    if (i === undefined) {
      i = out.length;
      at.set(g, i);
      out.push({ heading: g, options: [] });
    }
    out[i]?.options.push(o);
  }
  return out;
}

/** An avatar's chart colour (1..AVATAR_TONES) from the option's value: one person keeps one colour. */
export function avatarTone(value: string): number {
  let h = 0;
  for (const ch of value) h = (Math.imul(h, 31) + (ch.codePointAt(0) ?? 0)) | 0;
  return (Math.abs(h) % AVATAR_TONES) + 1;
}

/** The value after picking `value`: a multiple picker adds or drops it; a single one sets it, or clears it when it is chosen and may be empty. */
export function togglePick(current: readonly string[], value: string, multiple: boolean, required: boolean): string[] {
  if (multiple) return current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  if (current[0] === value) return required ? [value] : [];
  return [value];
}

/**
 * Labels for picked values: what the plugin lists now (results, then options) wins over
 * what this picker saw earlier (`seen`: a value picked from an older search's results);
 * a value nobody named shows as itself.
 */
export function pickedOptions(values: readonly string[], lists: readonly (readonly SelectOption[])[], seen: ReadonlyMap<string, SelectOption>): SelectOption[] {
  return values.map((v) => {
    for (const l of lists) {
      const o = l.find((x) => x.value === v);
      if (o) return o;
    }
    return seen.get(v) ?? { key: v, value: v, label: v };
  });
}

/** The trigger's summary of picked labels ("Me, Kim Park"), or "" for none. */
export function pickedSummary(picked: readonly SelectOption[]): string {
  return picked.map((o) => o.label).join(", ");
}

/**
 * A picker's search acts: the box's text goes through pickerTerm, then after
 * PICKER_DEBOUNCE_MS and one act at a time (liveSender), the newest last. Below the
 * threshold nothing is sent and what waits is dropped. The same term twice running goes once.
 */
export function searchSender(send: (term: string) => Promise<unknown>, delay = PICKER_DEBOUNCE_MS): LiveSender {
  const live = liveSender(send, delay);
  return {
    push: (input) => {
      const term = pickerTerm(input);
      if (term === "") live.cancel();
      else live.push(term);
    },
    flush: live.flush,
    cancel: live.cancel,
  };
}
