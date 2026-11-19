/**
 * What a page's document says it loaded (internal/preview/frame.js, docs/notes/
 * page-frame-states.md): its answer to the frame's `cf:ping`, `{ type: "cf:here", seq, files,
 * theme }`, and `{ type: "cf:files", files, theme }` when it fetches more after its load.
 * `files` are the paths it loaded from its own origin (itself first), `theme` whether it uses
 * the app's theme (`/cf/theme.css` or the bridge). Pure.
 */

/** The most paths a report is taken with (frame.js sends at most 64). */
const MAX_FILES = 64;

/** What a document loaded, and whether it uses the app's theme. */
export interface FrameReport {
  files: readonly string[];
  theme: boolean;
}

/** A `cf:here` or `cf:files` message's report; null for any other message, or one without a list (an older script's `cf:here`). */
export function frameReport(data: unknown): FrameReport | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as { type?: unknown; files?: unknown; theme?: unknown };
  if ((m.type !== "cf:here" && m.type !== "cf:files") || !Array.isArray(m.files)) return null;
  const files = m.files.filter((f): f is string => typeof f === "string" && f.startsWith("/")).slice(0, MAX_FILES);
  return { files, theme: m.theme === true };
}

/** The grant's part of a preview URL's path (`/preview/<grant>/`); null when it has none. */
function grantPrefix(pathname: string): string | null {
  return /^\/preview\/[^/]+\//.exec(pathname)?.[0] ?? null;
}

/**
 * The files on disk behind the paths a page's document loaded, for a frame at `pageUrl` (its
 * grant's URL) whose grant serves the directory `scope`: each path under the page's own grant,
 * as a file under scope (a folder's path is its index.html), never the page's own file (its
 * host reloads it already). Other grants, the app's `/cf/` routes and a path that does not
 * decode are left out. Sorted, without repeats.
 */
export function grantFiles(pageUrl: string, scope: string, paths: readonly string[]): string[] {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return [];
  }
  const prefix = grantPrefix(page.pathname);
  if (!prefix || !scope) return [];
  const root = scope.endsWith("/") ? scope.slice(0, -1) : scope;
  const fileOf = (path: string): string | null => {
    if (!path.startsWith(prefix)) return null;
    const rest = path.slice(prefix.length);
    const segs: string[] = [];
    try {
      for (const s of (rest === "" || rest.endsWith("/") ? `${rest}index.html` : rest).split("/")) {
        const d = decodeURIComponent(s);
        if (d === "" || d === "." || d === ".." || d.includes("/")) return null;
        segs.push(d);
      }
    } catch {
      return null;
    }
    return `${root}/${segs.join("/")}`;
  };
  const own = fileOf(page.pathname);
  const out = new Set<string>();
  for (const p of paths) {
    const f = fileOf(p);
    if (f !== null && f !== own) out.add(f);
  }
  return [...out].sort();
}
