/**
 * The File surface's tabs (docs/notes/file-viewer-3-tabs.md). One tab per file: a tab's id
 * comes from the params that name the file, not from the rest (the line to show), so opening
 * the same file again finds its tab and openTab (shell/host.ts) hands it the new params.
 * Pure.
 */
import { tabId, type Tab } from "@/shell/host";
import { fileName, resolvePath } from "@/lib/filePath";

export const FILE_KIND = "files";

/** A file to show: absolute, "~/…", or relative to `base`. */
export interface FileTarget {
  /** The project it belongs to; "" for a thread without one. */
  project: string;
  /** Absolute directory a relative path is read against: the thread's checkout, or home. */
  base: string;
  path: string;
  /** 1-based line to scroll to and mark; absent for none. */
  line?: number;
  /**
   * An HTML page its thread opened as its own (view.open.page): its bridge acts as
   * that thread though no card in the conversation shows it (usePageThread). Absent for any
   * other file.
   */
  page?: { title: string };
  /** The tab opens with its editor on, when the file is one it can edit. */
  edit?: boolean;
  /** A thread asked the user to edit this file (view.open.file --edit); gone once saved or dismissed. With `edit`. */
  ask?: FileAsk;
  /**
   * The thread whose panel this tab opened in while it had no checkout of its own, so the
   * file is the project's: read-only until it moves to the thread's worktree
   * (components/files/useFileHold).
   */
  heldFor?: string;
}

/** The param heldFor lives in. */
export const HELD_PARAM = "heldFor";

/** Who asked for a file to be edited, and what they said. The note is model text: plain text only. */
export interface FileAsk {
  /** This request, from every other: one for the same note is still a new one. */
  id: string;
  thread: string;
  note: string;
  /**
   * The version (versionStamp, api/files.ts) a write of ours left on disk since this request.
   * The thread can be told it was saved only while that is still the version on disk.
   */
  saved?: string;
}

/**
 * The params a File tab's request lives in: dropping them finishes it, for good. The daemon
 * writes all but askSaved (view.open.file --edit, internal/command fileAskParams); focus=1 is
 * the user's ask to be taken there (stores/fileRequestArrivals.ts).
 */
export const ASK_PARAMS = ["edit", "askId", "asker", "note", "askSaved", "focus"] as const;

/** A tab's params without `names` (for setTabParams). */
export function withoutParams(names: readonly string[]): (params: Tab["params"]) => Tab["params"] {
  return (params) => Object.fromEntries(Object.entries(params).filter(([k]) => !names.includes(k)));
}

/**
 * A File tab: params { project, base, path, line?, page?, title?, edit?, heldFor?, askId?, asker?, note?, askSaved? } with the path made
 * absolute against base when it can be, keyed by that path alone, titled with the page's
 * title or the file's name.
 */
export function fileTab(t: FileTarget): Tab {
  const path = resolvePath(t.base, t.path);
  const params: Record<string, string> = { project: t.project, base: t.base, path };
  if (t.line !== undefined && t.line > 0) params.line = String(Math.floor(t.line));
  if (t.page) {
    params.page = "1";
    if (t.page.title) params.title = t.page.title;
  }
  if (t.edit) params.edit = "1";
  if (t.heldFor) params[HELD_PARAM] = t.heldFor;
  if (t.ask) {
    params.askId = t.ask.id;
    params.asker = t.ask.thread;
    if (t.ask.note) params.note = t.ask.note;
    if (t.ask.saved) params.askSaved = t.ask.saved;
  }
  return { id: tabId(FILE_KIND, { path }), kind: FILE_KIND, title: t.page?.title || fileName(path) || path, params };
}

/** The file a File tab names; null when its params are not one. */
export function fileOfTab(tab: Pick<Tab, "params">): FileTarget | null {
  const path = tab.params.path ?? "";
  if (!path) return null;
  const line = Number(tab.params.line ?? "");
  return {
    project: tab.params.project ?? "",
    base: tab.params.base ?? "",
    path,
    ...(Number.isInteger(line) && line > 0 ? { line } : {}),
    ...(tab.params.page === "1" ? { page: { title: tab.params.title ?? "" } } : {}),
    ...(tab.params.edit === "1" ? { edit: true } : {}),
    ...(tab.params[HELD_PARAM] ? { heldFor: tab.params[HELD_PARAM] } : {}),
    ...(tab.params.asker ? { ask: { id: tab.params.askId ?? "", thread: tab.params.asker, note: tab.params.note ?? "", ...(tab.params.askSaved ? { saved: tab.params.askSaved } : {}) } } : {}),
  };
}
