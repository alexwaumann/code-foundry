/**
 * An agent search's answer as markdown (docs/notes/search-answer-pane.md). The text is the
 * model's and derives from old thread content, so it renders inert: rehypeInert leaves no
 * link, image or raw HTML. Its [n] references stay numbered markers: rehypeAnswerRefs makes
 * each a span that components/pr/Markdown hands to MarkdownExtras.citation.
 */
import type { HastNode } from "./inlineHtml";

/** A marker span's properties (hast): the hit's n, and whether punctuation sits against it. */
export const REF_PROP = "dataCfRef";
export const REF_TIGHT_PROP = "dataCfRefTight";

/** "[1]" or "[1, 2]". */
const REF_SOURCE = String.raw`\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]`;

/** A piece of the answer: plain text, or a reference to hit n ("[n]"). */
export type AnswerPiece = { kind: "text"; text: string } | { kind: "ref"; n: number };

/** The text as plain text and its [n] references ("[1]", "[1][2]", "[1, 2]"), for small numbered markers. */
export function answerPieces(answer: string): AnswerPiece[] {
  const out: AnswerPiece[] = [];
  const re = new RegExp(REF_SOURCE, "g");
  let at = 0;
  for (let m = re.exec(answer); m; m = re.exec(answer)) {
    if (m.index > at) out.push({ kind: "text", text: answer.slice(at, m.index) });
    for (const n of (m[1] ?? "").split(",")) out.push({ kind: "ref", n: Number(n.trim()) });
    at = m.index + m[0].length;
  }
  if (at < answer.length) out.push({ kind: "text", text: answer.slice(at) });
  return out;
}

/** The text without its references, and without the space before each ("the spot [1]." reads "the spot."). */
export function withoutRefs(text: string): string {
  return text.replace(new RegExp(String.raw`\s*${REF_SOURCE}`, "g"), "");
}

/** Whether a marker's next piece starts with punctuation, which then sits against it. */
function beforePunctuation(next: AnswerPiece | undefined): boolean {
  return next?.kind === "text" && /^[.,;:!?)\]}…]/.test(next.text);
}

const text = (value: string): HastNode => ({ type: "text", value });

/** What renders in place of a node that must not: its text, or nothing. */
function inertNodes(n: HastNode): HastNode[] | null {
  if (n.type === "raw") return [text(n.value ?? "")];
  if (n.type !== "element") return null;
  if (n.tagName === "a") return n.children ?? [];
  if (n.tagName === "img") {
    const alt = n.properties?.alt;
    return typeof alt === "string" && alt !== "" ? [text(alt)] : [];
  }
  return null;
}

/**
 * Nothing in the tree reaches out or acts: a link is its text, an image its alt text, and
 * raw HTML is the text it was typed as (a tag included: no element comes of it).
 */
export function rehypeInert() {
  const walk = (n: HastNode) => {
    const kids = n.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (!c) continue;
      const nodes = inertNodes(c);
      if (nodes) {
        kids.splice(i, 1, ...nodes);
        i--; // What took its place may be a link's own children: read them too.
        continue;
      }
      walk(c);
    }
  };
  return walk;
}

/** Code shows its text as typed: args[1] is no reference. */
const SKIP = new Set(["code", "pre"]);

/** A text's [n] references become marker spans (paragraphs, list items, headings, table cells). */
export function rehypeAnswerRefs() {
  const walk = (n: HastNode) => {
    const kids = n.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (!c) continue;
      if (c.type === "element") {
        if (!SKIP.has(c.tagName ?? "")) walk(c);
        continue;
      }
      if (c.type !== "text" || !c.value) continue;
      const pieces = answerPieces(c.value);
      if (!pieces.some((p) => p.kind === "ref")) continue;
      const nodes = pieces.map(
        (p, at): HastNode =>
          p.kind === "text" ? text(p.text) : { type: "element", tagName: "span", properties: { [REF_PROP]: p.n, [REF_TIGHT_PROP]: beforePunctuation(pieces[at + 1]) }, children: [] },
      );
      kids.splice(i, 1, ...nodes);
      i += nodes.length - 1;
    }
  };
  return walk;
}
