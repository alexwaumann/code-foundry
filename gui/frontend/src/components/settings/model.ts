/**
 * Pure helpers behind the settings page (SettingsPage): a page's sections with their
 * fields and rows, the search across every page, and the keybindings page's buckets.
 */
import type { SettingFieldView, SettingPageView, SettingSectionView, SettingsSchemaView } from "@/api/settings";
import { formatChord } from "@/keys/chord";
import { enumOptionLabel } from "@/lib/models";

/** An enum value's name: the schema's label (the model registry's "Opus 4.8"), else the value; "" is "no preference". */
export function enumLabel(f: SettingFieldView, v: string): string {
  return v === "" ? "Default" : enumOptionLabel(f, v);
}

/** A value as the reset tooltip and the saved toast name it. */
export function displayValue(f: SettingFieldView, v: string): string {
  if (f.type === "keybinding") return v === "none" ? "unbound" : v ? formatChord(v) : "unbound";
  if (f.type === "enum") return enumLabel(f, v);
  return v === "" ? "default" : v;
}

/** A card's rows after the first are separated by a hairline. */
export function rowBorder(i: number): string | undefined {
  return i > 0 ? "border-t border-border" : undefined;
}

/** The search box's words, lower-cased; none for an empty or blank query. */
export function queryWords(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Whether a field matches every word, in its title, description or key. No words match everything. */
export function matchField(f: SettingFieldView, words: readonly string[]): boolean {
  if (words.length === 0) return true;
  const hay = `${f.title} ${f.description} ${f.key}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Text cut into runs, `hit` where one of the words occurs (case-insensitive); overlapping words merge. */
export function highlightParts(text: string, words: readonly string[]): { text: string; hit: boolean }[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const marked = new Array<boolean>(text.length).fill(false);
  for (const w of words) {
    if (!w) continue;
    for (let i = lower.indexOf(w); i !== -1; i = lower.indexOf(w, i + 1)) marked.fill(true, i, i + w.length);
  }
  const out: { text: string; hit: boolean }[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || marked[i] !== marked[start]) {
      out.push({ text: text.slice(start, i), hit: marked[start] ?? false });
      start = i;
    }
  }
  return out;
}

export interface SectionFields {
  section: SettingSectionView;
  fields: SettingFieldView[];
}

/** A page's sections in order, each with its fields in display order; empty sections are left out. */
export function pageSections(schema: SettingsSchemaView, page: SettingPageView): SectionFields[] {
  return page.sections
    .map((section) => ({ section, fields: schema.fields.filter((f) => f.page === page.id && f.section === section.id) }))
    .filter((s) => s.fields.length > 0);
}

/**
 * A section's fields as the rows they render in: a field alone, or the run of fields
 * sharing a non-empty `row` (model and effort side by side).
 */
export function fieldRows(fields: readonly SettingFieldView[]): SettingFieldView[][] {
  const rows: SettingFieldView[][] = [];
  for (const f of fields) {
    const last = rows.at(-1);
    if (f.row && last?.[0]?.row === f.row) last.push(f);
    else rows.push([f]);
  }
  return rows;
}

export interface SearchHit {
  field: SettingFieldView;
  page: SettingPageView;
  section: SettingSectionView | undefined;
}

export interface SearchResult {
  /** Every match, in page then section order. */
  hits: SearchHit[];
  /** Matches per page id (every page has an entry). */
  counts: Readonly<Record<string, number>>;
}

/** The search across every page: the matching fields in display order and the count per page. */
export function searchSettings(schema: SettingsSchemaView, words: readonly string[]): SearchResult {
  const hits: SearchHit[] = [];
  const counts: Record<string, number> = {};
  for (const page of schema.pages) {
    const sections = new Map(page.sections.map((s) => [s.id, s]));
    const fields = schema.fields.filter((f) => f.page === page.id && matchField(f, words));
    // Section order first (fields keep their order within one).
    const order = new Map(page.sections.map((s, i) => [s.id, i]));
    fields.sort((a, b) => (order.get(a.section) ?? Infinity) - (order.get(b.section) ?? Infinity));
    for (const field of fields) hits.push({ field, page, section: sections.get(field.section) });
    counts[page.id] = fields.length;
  }
  return { hits, counts };
}

/** A keybinding value that binds a chord: not "" (no default) and not "none" (unbound on purpose). */
export function isBound(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "none";
}

export interface KeybindingCategory {
  section: SettingSectionView;
  /** Shown as rows: the bound commands with Bound only on, else all of them. */
  shown: SettingFieldView[];
  /** Behind the category's "N more unbound" row (empty with Bound only off). */
  unbound: SettingFieldView[];
}

export interface KeybindingBuckets {
  /** Categories that get a card of their own. */
  categories: KeybindingCategory[];
  /** With Bound only on, the categories with nothing bound, folded into one "No shortcuts yet" card. */
  empty: { section: SettingSectionView; fields: SettingFieldView[] }[];
  bound: number;
  total: number;
}

/**
 * The keybindings page's cards from its sections (command categories), the keybinding
 * fields and the effective values. With `boundOnly`, a category shows its bound commands
 * and keeps the rest behind an expander; a category with none bound goes to `empty`.
 */
export function bucketKeybindings(
  sections: readonly SettingSectionView[],
  fields: readonly SettingFieldView[],
  values: Readonly<Record<string, string>>,
  boundOnly: boolean,
): KeybindingBuckets {
  const categories: KeybindingCategory[] = [];
  const empty: KeybindingBuckets["empty"] = [];
  let bound = 0;
  let total = 0;
  for (const section of sections) {
    const all = fields.filter((f) => f.type === "keybinding" && f.section === section.id);
    if (all.length === 0) continue;
    const on = all.filter((f) => isBound(values[f.key] ?? f.defaultValue));
    bound += on.length;
    total += all.length;
    if (!boundOnly) categories.push({ section, shown: all, unbound: [] });
    else if (on.length === 0) empty.push({ section, fields: all });
    else categories.push({ section, shown: on, unbound: all.filter((f) => !on.includes(f)) });
  }
  return { categories, empty, bound, total };
}
