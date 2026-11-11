/**
 * Painting a File tab's find matches (docs/notes/file-find-in-file.md) with the CSS Custom
 * Highlight API: every match `cf-file-find`, the current one `cf-file-find-current`. Ranges
 * may sit in @pierre/diffs' shadow root (the code) or in the page (rendered markdown); the
 * registry is the document's either way, and each tree carries the `::highlight` rules
 * (components/code/codeCss.ts inside the shadow root, files.css in the page). Two File tabs
 * (a split panel) can search at once, so each tab's ranges are kept here and the two
 * highlights are the union.
 */

export const FILE_FIND_HIGHLIGHT = "cf-file-find";
export const FILE_FIND_CURRENT_HIGHLIGHT = "cf-file-find-current";

interface HighlightRegistryLike {
  set(name: string, h: unknown): void;
  delete(name: string): void;
}

function registry(): HighlightRegistryLike | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS;
  return css?.highlights && typeof (globalThis as { Highlight?: unknown }).Highlight === "function" ? css.highlights : null;
}

const painted = new Map<string, { all: readonly Range[]; current: readonly Range[] }>();

function apply(name: string, ranges: Range[]): void {
  const reg = registry();
  if (!reg) return;
  if (ranges.length === 0) {
    reg.delete(name);
    return;
  }
  const H = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
  reg.set(name, new H(...ranges));
}

/** Paints one tab's matches (no ranges clears that tab's). */
export function paintFileFind(tab: string, all: readonly Range[], current: readonly Range[]): void {
  if (all.length === 0 && current.length === 0) {
    if (!painted.delete(tab)) return;
  } else painted.set(tab, { all, current });
  const every: Range[] = [];
  const now: Range[] = [];
  for (const p of painted.values()) {
    every.push(...p.all);
    now.push(...p.current);
  }
  apply(FILE_FIND_HIGHLIGHT, every);
  apply(FILE_FIND_CURRENT_HIGHLIGHT, now);
}

/** The ranges a tab has painted, for tests. */
export function paintedFileFind(tab: string): { all: readonly Range[]; current: readonly Range[] } | undefined {
  return painted.get(tab);
}
