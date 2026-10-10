/**
 * Path completion in the palette's `path` prompts. The daemon lists directories
 * (FilesystemService.ListDirectories); these pure helpers turn a listing and a key into
 * the next input, keeping the user's own spelling ("~/" stays "~/").
 */

/** The directory part of a typed path: "~/src/co" -> "~/src/". Empty and "~" mean home. */
export function typedDir(query: string): string {
  if (query === "" || query === "~") return "~/";
  return query.slice(0, query.lastIndexOf("/") + 1);
}

/** The input that names entry `name` in the typed directory: what Enter on it submits. */
export function entryPath(query: string, name: string): string {
  return typedDir(query) + name;
}

/** The input that descends into entry `name` (Tab or "/" on a highlighted entry). */
export function descendInto(query: string, name: string): string {
  return `${entryPath(query, name)}/`;
}

/**
 * What Tab does: descend into the highlighted entry, else extend the input to the
 * listing's common completion. Null when there is nothing to complete.
 */
export function tabCompletion(query: string, completion: string | null, highlighted: string | null): string | null {
  if (highlighted !== null) return descendInto(query, highlighted);
  if (completion !== null && completion !== query) return completion;
  return null;
}
