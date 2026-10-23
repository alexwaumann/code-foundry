/**
 * The File tab's one retry for a path not found at its base (lib/pathFallback,
 * docs/notes/model-paths.md): the checkout's file search for the path's name, then the one
 * file whose path ends with the typed one.
 */
import { searchFiles, type FileSearchRequest, type FileSearchView } from "@/api/filesystem";
import { isAbort } from "@/api/stream";
import { relativeTo } from "@/lib/filePath";
import { fallbackQuery, uniqueSuffixMatch } from "@/lib/pathFallback";

export type SearchFn = (req: FileSearchRequest, signal: AbortSignal) => Promise<FileSearchView>;

const search: SearchFn = (req, signal) => searchFiles(req, undefined, signal);

/**
 * The absolute path `abs` (missing, under the checkout `base` of `project`) most likely
 * meant; null when it is outside base, no file or several match, or the search fails (an
 * older daemon, a project gone). An abort is rethrown.
 */
export async function findMissing(project: string, base: string, abs: string, signal: AbortSignal, find: SearchFn = search): Promise<string | null> {
  const rel = project ? relativeTo(abs, base) : null;
  const query = rel === null ? null : fallbackQuery(rel);
  if (rel === null || query === null) return null;
  try {
    const res = await find({ projectId: project, path: base, query, limit: 200 }, signal);
    const hit = uniqueSuffixMatch(rel, res.matches, res.truncated);
    return hit === null ? null : `${base.replace(/\/+$/, "")}/${hit}`;
  } catch (err) {
    if (signal.aborted || isAbort(err)) throw err;
    return null;
  }
}
