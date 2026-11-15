/**
 * Include patterns (docs/notes/file-search-1-includes.md, file-search-2-includes-gui.md):
 * git-ignored files that file search lists anyway. Two lists: the files.include_ignored
 * setting (comma-separated, `none` for the empty list, since an empty value means unset and
 * brings the defaults back) and each project's own (ProjectView.includeIgnored, set whole
 * through project.files.include). Validation is the daemon's; the GUI only refuses what
 * would silently turn one pattern into several (a comma).
 */

export const INCLUDE_SETTING = "files.include_ignored";
/** The setting's word for no patterns (fsx.IncludeNone). */
export const INCLUDE_NONE = "none";

/** The setting's value read as a list: `none` is empty; split at commas, trimmed, blanks and repeats dropped (fsx.SplitIncludeSetting, without validation). */
export function parseIncludeSetting(value: string): string[] {
  if (value.trim().toLowerCase() === INCLUDE_NONE) return [];
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const p = raw.trim();
    if (p !== "" && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * A list as the setting's value or project.files.include's patterns arg: comma-separated,
 * `none` when empty (for the setting, an empty value would mean the defaults).
 */
export function formatPatterns(patterns: readonly string[]): string {
  return patterns.length === 0 ? INCLUDE_NONE : patterns.join(", ");
}

/** The defaults (the field's default value) that the list does not have, in the defaults' order. */
export function missingDefaults(patterns: readonly string[], defaults: readonly string[]): string[] {
  return defaults.filter((d) => !patterns.includes(d));
}

/** Restore defaults: the missing ones appended; the user's own patterns are kept, in place. */
export function restoreDefaults(patterns: readonly string[], defaults: readonly string[]): string[] {
  return [...patterns, ...missingDefaults(patterns, defaults)];
}

/** "Restore 1 default", "Restore 2 defaults". */
export function restoreLabel(n: number): string {
  return `Restore ${String(n)} ${n === 1 ? "default" : "defaults"}`;
}

export function withoutPattern(patterns: readonly string[], p: string): string[] {
  return patterns.filter((x) => x !== p);
}

/** The list with p added at the end; unchanged (the same array) when it is already there. */
export function withPattern(patterns: readonly string[], p: string): readonly string[] {
  return patterns.includes(p) ? patterns : [...patterns, p];
}

/**
 * The typed text as one pattern to add: trimmed; an error for what the GUI refuses before
 * the daemon sees it (empty, a comma: the lists are comma-separated, so it would add
 * several). The daemon's message for a comma, so both read the same.
 */
export function typedPattern(text: string): { pattern: string; error: string } {
  const pattern = text.trim();
  if (pattern === "") return { pattern, error: "" };
  if (pattern.includes(",")) return { pattern, error: `pattern ${JSON.stringify(pattern)} has a comma, which separates patterns` };
  return { pattern, error: "" };
}

/** Where an effective pattern comes from: the setting (every project) or the project's own list. */
export type IncludeScope = "all" | "project";

export interface EffectivePattern {
  pattern: string;
  scope: IncludeScope;
}

/** A project's effective list (fsx.MergeIncludes): the setting's first, then its own, a repeat listed once where it comes first. */
export function effectivePatterns(setting: readonly string[], own: readonly string[]): EffectivePattern[] {
  const out: EffectivePattern[] = setting.map((pattern) => ({ pattern, scope: "all" }));
  for (const pattern of own) if (!setting.includes(pattern)) out.push({ pattern, scope: "project" });
  return out;
}

/** What adding a suggestion writes: a folder's path with a trailing "/" (folders only), a file's path as is. */
export function suggestionPattern(s: { path: string; isDir: boolean }): string {
  return s.isDir ? `${s.path}/` : s.path;
}

/** "1 file", "212 files", "1,000+ files". */
export function fileCount(n: number, capped = false): string {
  return `${n.toLocaleString("en-US")}${capped ? "+" : ""} ${n === 1 && !capped ? "file" : "files"}`;
}

/** A pattern error from the daemon (InvalidArgument) as the user reads it: without "invalid argument: ". */
export function patternErrorText(message: string): string {
  return message.replace(/^invalid argument: /, "");
}
