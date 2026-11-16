/**
 * The Needs-you inbox's pure parts (docs/notes/shell-model.md, "Sidebar"; docs/notes/shell-17-needs-you.md):
 * what a hover card shows of an ask, the line of context under it, the next thread for
 * cmd+shift+a, and when a short pane draws the ask as one line above the composer.
 */
import type { ThreadItemView, ThreadPendingView, ThreadRequestView } from "@/api/thread";
import { nextAfter } from "@/lib/tree";
import { parseObject, relPath, str } from "@/lib/toolSummary";

/** What a permission asks to touch: a command, a file or page, or the tool's input as JSON. */
export type AskTarget = { kind: "command"; text: string } | { kind: "path"; text: string } | { kind: "input"; text: string } | null;

/** The permission's target, as today's card shows it (components/thread/PendingPrompt.tsx), whole. */
export function askTarget(r: Pick<ThreadRequestView, "inputJson">, cwd: string): AskTarget {
  const input = parseObject(r.inputJson);
  const command = str(input, "command");
  if (command) return { kind: "command", text: command };
  const path = str(input, "file_path") || str(input, "notebook_path");
  if (path) return { kind: "path", text: relPath(path, cwd) };
  const url = str(input, "url");
  if (url) return { kind: "path", text: url };
  return r.inputJson ? { kind: "input", text: JSON.stringify(input, null, 2) } : null;
}

/** A Markdown text's last line with words: list markers, headings and emphasis stripped. "" for none. */
export function lastLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !/^(```|---|\|)/.test(l));
  const line = lines.at(-1) ?? "";
  return line
    .replace(/^(#+|[-*+]|\d+[.)]|>)\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
}

/**
 * The last line Claude wrote before the ask: the last of its own text items (not a subagent's)
 * before `askOrdinal` (every item when it is unknown). "" when it wrote none.
 */
export function contextLine(items: readonly ThreadItemView[], askOrdinal: number | null): string {
  let best: { ordinal: number; text: string } | null = null;
  for (const it of items) {
    if (it.kind !== "text" || it.parentToolUseId !== "" || it.apiError) continue;
    if (askOrdinal !== null && it.ordinal >= askOrdinal) continue;
    if (!best || it.ordinal > best.ordinal) best = { ordinal: it.ordinal, text: it.text };
  }
  return best ? lastLine(best.text) : "";
}

/**
 * Where cmd+shift+a goes: the Needs you list's next after `from` (the popup's thread, else the
 * focused one), wrapping; the first when `from` is not in the list. `ember` is Ember's thread
 * while it waits on the user ("" otherwise, stores/ember.ts emberAttentionId): its row sits above
 * the list in the sidebar, so it comes first in the round. null when nothing waits.
 */
export function nextNeedsThread(needs: readonly string[], from: string | null, ember = ""): string | null {
  const round = ember ? [ember, ...needs.filter((id) => id !== ember)] : needs;
  return nextAfter(round, from !== null && round.includes(from) ? from : null, () => true);
}

/** The least of a pane's body the conversation keeps beside the full ask and the composer. */
export const ASK_MIN_ROOM = 120;
/** How much more room the strip waits for before the full card comes back, so it does not flap. */
export const ASK_HYSTERESIS = 24;

export interface AskRoom {
  /** The thread body's height (under the header). */
  body: number;
  /** The dock's height as drawn (strips and composer, with the card or the strip in it). */
  dock: number;
  /** The full card's height when last drawn (the pending prompts' stack). */
  card: number;
  /** The one-line strip's height when drawn, else 0. */
  strip: number;
  /** Whether the strip is what is drawn now. */
  showingStrip: boolean;
}

/**
 * Whether a shell pane draws its ask as the one-line strip: the conversation would keep less
 * than ASK_MIN_ROOM of the body beside the full card and the composer. Drawn as the strip, the
 * card comes back once it would leave ASK_MIN_ROOM + ASK_HYSTERESIS.
 */
export function askAsStrip({ body, dock, card, strip, showingStrip }: AskRoom): boolean {
  if (body <= 0) return showingStrip;
  const withCard = showingStrip ? dock - strip + card : dock;
  const room = body - withCard;
  return room < ASK_MIN_ROOM + (showingStrip ? ASK_HYSTERESIS : 0);
}

/** What one open request asks for, as a Needs you line shows it (docs/notes/needs-you-line-items.md). */
export type RequestKind = "permission" | "question" | "plan";

/** One line under a Needs you row: an open request's kind and its one-line summary. */
export interface RequestLine {
  requestId: string;
  kind: RequestKind;
  /** "Permission: git push --force-with-lease", "Question: which base branch?", "Plan: ready for review". */
  text: string;
}

const KIND_WORD: Readonly<Record<RequestKind, string>> = { permission: "Permission", question: "Question", plan: "Plan" };

/** A request's kind: a question, a plan to approve (ExitPlanMode), else a permission. */
export function requestKind(p: Pick<ThreadPendingView, "question" | "toolName">): RequestKind {
  if (p.question) return "question";
  return p.toolName === "ExitPlanMode" ? "plan" : "permission";
}

/**
 * A request's line: its kind's word and the thread source's one-line summary, on one line. A
 * command's summary starts with the tool ("Bash git push"), which the line leaves out: the
 * command says what it is. A plan's summary is the tool's name, so its line says what it waits for.
 */
export function requestLine(p: ThreadPendingView): RequestLine {
  const kind = requestKind(p);
  let what = p.summary.replace(/\s+/g, " ").trim();
  if (kind === "plan") what = "ready for review";
  else if (kind === "permission" && p.toolName === "Bash" && what.startsWith("Bash ")) what = what.slice(5);
  return { requestId: p.requestId, kind, text: `${KIND_WORD[kind]}: ${what || p.toolName}` };
}

/** The most lines a Needs you row shows under its title; past it the last line is "+N more". */
export const MAX_REQUEST_LINES = 4;

export interface RequestLines {
  /** One per open request shown, oldest first; [] for a thread with fewer than two. */
  lines: RequestLine[];
  /** The requests past the cap: how many, and the first of them (its line opens the popup there); null when all show. */
  more: { count: number; requestId: string } | null;
}

/**
 * A Needs you row's lines (oldest first, as the thread source lists them): none for one open
 * request (the row looks as it did), one per request for two to MAX_REQUEST_LINES, else the
 * first MAX_REQUEST_LINES - 1 and "+N more", so a row never takes more than MAX_REQUEST_LINES lines.
 */
export function requestLines(open: readonly ThreadPendingView[]): RequestLines {
  if (open.length < 2) return { lines: [], more: null };
  if (open.length <= MAX_REQUEST_LINES) return { lines: open.map(requestLine), more: null };
  const shown = MAX_REQUEST_LINES - 1;
  const first = open[shown];
  return { lines: open.slice(0, shown).map(requestLine), more: first ? { count: open.length - shown, requestId: first.requestId } : null };
}

/**
 * The popup's request after the open ones changed (`prev` to `next`, oldest first): the same one
 * while it is open; once it is answered (in the popup or anywhere), the next one after it that is
 * still open, else the first still open (wrapping); null when none is. A request asked for that
 * is not open (answered as the popup opened) gives the oldest.
 */
export function reconcileStep(prev: readonly string[], next: readonly string[], current: string | null): string | null {
  if (current !== null && next.includes(current)) return current;
  const at = current === null ? -1 : prev.indexOf(current);
  if (at >= 0) {
    const after = prev.slice(at + 1).find((id) => next.includes(id));
    if (after !== undefined) return after;
  }
  return next[0] ?? null;
}

/** The request one step before (-1) or after (1) `current`, without wrapping; `current` at an end. */
export function stepBy(ids: readonly string[], current: string | null, dir: -1 | 1): string | null {
  const at = current === null ? -1 : ids.indexOf(current);
  if (at < 0) return ids[0] ?? null;
  return ids[Math.min(ids.length - 1, Math.max(0, at + dir))] ?? null;
}

/**
 * Which way a key steps the popup's requests: plain ArrowLeft (-1) and ArrowRight (1), never
 * with a modifier, and not while the keyboard is in text (`inText`: a field, or the composer
 * with something typed), where the arrows move the caret. 0 for any other key.
 */
export function stepKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, inText: boolean): -1 | 0 | 1 {
  if (inText || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return 0;
  if (e.key === "ArrowLeft") return -1;
  if (e.key === "ArrowRight") return 1;
  return 0;
}
