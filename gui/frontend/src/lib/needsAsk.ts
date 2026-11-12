/**
 * The Needs-you inbox's pure parts (docs/notes/shell-model.md, "Sidebar"; docs/notes/shell-17-needs-you.md):
 * what a hover card shows of an ask, the line of context under it, the next thread for
 * cmd+shift+a, and when a short pane draws the ask as one line above the composer.
 */
import type { ThreadItemView, ThreadRequestView } from "@/api/thread";
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
