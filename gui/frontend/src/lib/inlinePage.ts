/**
 * A page the model showed inline in a thread (code-foundry view.inline; docs/notes/
 * inline-html.md): where it is and how tall its card's frame is.
 */
import { dirPart, fileName, resolvePath } from "./filePath";
import { tildify } from "./path";

/** The card's frame height when the page asks for none. */
export const DEFAULT_HEIGHT = 420;
/** The share of the pane's height a page may ask for. */
export const PANE_SHARE = 0.6;
/** The smallest frame height. */
const MIN_HEIGHT = 48;

/** The card's frame height: the page's ask (`cf:resize`; null: DEFAULT_HEIGHT), within [MIN_HEIGHT, PANE_SHARE of the pane]. */
export function frameHeight(asked: number | null, pane: number): number {
  const cap = Math.max(MIN_HEIGHT, Math.floor(pane * PANE_SHARE));
  return Math.min(cap, Math.max(MIN_HEIGHT, Math.ceil(asked ?? DEFAULT_HEIGHT)));
}

/** An inline page's place. */
export interface InlinePage {
  /** The absolute path. */
  abs: string;
  name: string;
  /** Its directory as shown: relative to the thread's cwd as stored, `~/…` when absolute; "" in the cwd itself. */
  dir: string;
  /** The item's own path and the base it resolves against (FilesystemService takes both). */
  baseDir: string;
  path: string;
  title: string;
}

export function inlinePage(it: { path: string; baseDir: string; title: string }): InlinePage {
  const dir = dirPart(it.path).replace(/\/$/, "");
  return {
    abs: resolvePath(it.baseDir, it.path),
    name: fileName(it.path),
    dir: dir.startsWith("/") ? tildify(dir) : dir,
    baseDir: it.baseDir,
    path: it.path,
    title: it.title,
  };
}
