/**
 * The thread's prompt rail (components/thread/PromptRail.tsx, docs/notes/thread-prompt-rail.md):
 * one tick per user prompt in the timeline's left gutter. What it lays out and says, pure.
 */
import { CITE_LABEL } from "./citation";
import { tagLabel } from "./prompt";
import type { MessagePiece } from "./userMessage";

/** A tick's bar height in px (h-0.5). */
export const TICK_PX = 2;
/** The gaps between ticks to try, widest first: a long thread packs them closer. */
export const RAIL_GAPS: readonly number[] = [6, 3, 2];
/** Fewer prompts than this: no rail (one prompt is nothing to cycle through). */
export const RAIL_MIN_PROMPTS = 2;

/**
 * The gap between ticks for `count` prompts in `available` px: the widest of RAIL_GAPS
 * whose ticks fit, each tick taking its bar and one gap (the gap is the tick button's
 * hit area, split above and below its bar). null: no rail (too few prompts, or they do not
 * fit even at the closest gap; the rail hides rather than overflow).
 */
export function railGap(count: number, available: number): number | null {
  if (count < RAIL_MIN_PROMPTS) return null;
  for (const gap of RAIL_GAPS) if (count * (TICK_PX + gap) <= available) return gap;
  return null;
}

/**
 * The index of the prompt in view: the last whose row top (`starts`, the rows' offsets in
 * the list, in order; undefined for a row not laid out yet) is at or above `middle` (the
 * viewport's middle as an offset in the list). -1 when none is. `atEnd`: the list is
 * scrolled to its end, where the last turn is what shows even when it is too short to
 * reach the middle: the last prompt.
 */
export function promptInView(starts: readonly (number | undefined)[], middle: number, atEnd = false): number {
  if (atEnd) return starts.length - 1;
  let at = -1;
  starts.forEach((s, i) => {
    if (s !== undefined && s <= middle) at = i;
  });
  return at;
}

/**
 * A prompt as one line of text for its tick's tooltip: its text with each tag as its label
 * (/skill, file name, thread name, #PR, a citation's "Assistant quote") and whitespace runs
 * collapsed; images and PDFs left out.
 */
export function promptPreview(pieces: readonly MessagePiece[]): string {
  const parts = pieces.map((p) => {
    switch (p.kind) {
      case "text":
        return p.text;
      case "skill":
        return tagLabel({ tagKind: "skill", name: p.name, projectId: "" });
      case "file":
        return tagLabel({ tagKind: "file", projectId: p.projectId, path: p.path });
      case "thread":
        return tagLabel({ tagKind: "thread", id: p.id, name: p.name });
      case "pr":
        return tagLabel({ tagKind: "pr", slug: p.slug, number: p.number });
      case "cite":
        return CITE_LABEL;
      case "image":
      case "pdf":
        return "";
    }
  });
  return parts.join("").replace(/\s+/g, " ").trim();
}

/** A tick's accessible name: "Prompt 2 of 5: <the preview's first 60 characters>". */
export function tickLabel(n: number, total: number, preview: string): string {
  const head = `Prompt ${String(n)} of ${String(total)}`;
  if (!preview) return head;
  const cut = preview.length > 60 ? `${preview.slice(0, 60).trimEnd()}…` : preview;
  return `${head}: ${cut}`;
}
