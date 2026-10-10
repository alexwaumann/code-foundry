import { tildify } from "@/lib/path";

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

/** The prefix every Local folder path starts with: the input shows it permanently. */
export const HOME_PREFIX = "~/";

/**
 * The full path for what was typed, pasted or picked into the Local folder input, whose
 * "~/" is fixed: "src/x" -> "~/src/x"; a pasted "~/src/x" or "~" is not doubled; an
 * absolute path under a macOS home becomes "~/..." (tildify); any other absolute path is
 * taken relative to home, since the input cannot name anything outside it.
 */
export function homeRelative(input: string): string {
  let rest = input;
  if (rest.startsWith("~")) rest = rest.slice(1);
  else if (rest.startsWith("/")) {
    const t = tildify(rest);
    rest = t.startsWith("~") ? t.slice(1) : rest;
  }
  return HOME_PREFIX + rest.replace(/^\/+/, "");
}

/** What the Local folder input shows for a full path: everything after "~/". */
export function homeDisplay(path: string): string {
  return path.startsWith(HOME_PREFIX) ? path.slice(HOME_PREFIX.length) : path === "~" ? "" : path;
}
