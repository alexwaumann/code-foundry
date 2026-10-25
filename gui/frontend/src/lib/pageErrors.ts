/**
 * The errors a page's bridge answered (docs/notes/bridge-fix-c-gui.md): what the strip's
 * badge counts and its popover lists, and the message "Ask Claude" puts in the thread's
 * composer. A page's mistakes (a misspelt arg, a verb or source not there) otherwise reach
 * no one but the user, and Claude, who wrote the page, never sees them. Pure.
 */
import type { BridgeErrorCode } from "./bridge";

/** The codes a page's strip reports: the page's own mistakes and the app's failures. Not `declined` (the user said no) nor `gesture` (page-side). */
export const REPORTED_CODES: ReadonlySet<BridgeErrorCode> = new Set(["invalid", "unavailable", "failed", "timeout"]);

/** How many distinct errors a frame keeps (the latest). */
export const PAGE_ERRORS_MAX = 5;

export interface PageError {
  /** What the page called: a verb, or `cf.on("<source>")`. */
  call: string;
  code: BridgeErrorCode;
  message: string;
  /** When it last happened, epoch ms. */
  atMs: number;
  /** How many times it happened since the frame loaded. */
  count: number;
}

/** list with one more error: a repeat of one listed (same call, code and message) moves to the end with its count up; the oldest go past PAGE_ERRORS_MAX. */
export function addPageError(list: readonly PageError[], e: Omit<PageError, "count">): PageError[] {
  const same = list.find((x) => x.call === e.call && x.code === e.code && x.message === e.message);
  const rest = same ? list.filter((x) => x !== same) : list;
  return [...rest, { ...e, count: (same?.count ?? 0) + 1 }].slice(-PAGE_ERRORS_MAX);
}

/** Every error's occurrences. */
export function pageErrorCount(list: readonly PageError[]): number {
  return list.reduce((n, e) => n + e.count, 0);
}

/** The composer text "Ask Claude" puts in the thread: the page, then each error on a line. */
export function askAboutPageErrors(page: string, list: readonly PageError[]): string {
  const lines = list.map((e) => `- ${e.call}: ${e.code}: ${e.message}${e.count > 1 ? ` (${String(e.count)} times)` : ""}`);
  return [`The page ${page} got ${list.length === 1 ? "this error" : "these errors"} from Code Foundry. Please fix the page:`, ...lines].join("\n");
}
