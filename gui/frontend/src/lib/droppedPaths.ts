/**
 * Paths the Wails host hands over for files dropped on a composer or picked in the native
 * open panel (docs/notes/attach-drop.md). The five kinds the daemon stages are attached;
 * anything else (other files, folders) goes into the prompt as its path.
 */

/** png, jpg/jpeg, gif, webp, pdf after at least one character of name, any case. */
const ATTACHABLE = /[^/]\.(png|jpe?g|gif|webp|pdf)$/i;

/** Splits paths into the ones to attach (by extension) and the ones to insert as text, each in order. */
export function splitDroppedPaths(paths: readonly string[]): { attach: string[]; insert: string[] } {
  const attach: string[] = [];
  const insert: string[] = [];
  for (const p of paths) (ATTACHABLE.test(p) ? attach : insert).push(p);
  return { attach, insert };
}

/** Characters a path may have and still go in unquoted (shlex.quote's safe set). */
const SAFE = /^[\w@%+=:,./-]+$/;

/**
 * One path as prompt text: as it is when it has only safe characters, else in double
 * quotes with `"`, `\`, `$` and `` ` `` escaped by a backslash (what stays literal inside
 * double quotes in a shell).
 */
export function pathAsText(path: string): string {
  if (SAFE.test(path)) return path;
  return `"${path.replace(/["\\$`]/g, "\\$&")}"`;
}

/** Paths as prompt text: each pathAsText, one space between. */
export function pathsAsText(paths: readonly string[]): string {
  return paths.map(pathAsText).join(" ");
}

/**
 * Text to insert at a caret with `before` and `after` around it (the paragraph's text on
 * either side): a space in front when the character before is not whitespace, and one
 * after when the character after is not whitespace. At the start or end of the line no
 * space is added on that side.
 */
export function spacedAtCaret(text: string, before: string, after: string): string {
  const lead = before !== "" && !/\s$/.test(before) ? " " : "";
  const trail = after !== "" && !/^\s/.test(after) ? " " : "";
  return `${lead}${text}${trail}`;
}
