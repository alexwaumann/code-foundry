import { zoomFactor } from "@/lib/zoom";

/**
 * The DOM side of citations (docs/notes/citations.md): an assistant answer's rendered
 * plain text, offsets into it from DOM points and back, and the painted ranges. Nothing
 * here changes the markdown's DOM: ranges are read, and painted with the CSS Custom
 * Highlight API (`::highlight(cf-cite-…)`, cite.css), or, where it is missing, with
 * fixed boxes in an overlay outside React's tree.
 */

/** The attribute a citable answer's element carries: its item id (TextRow). */
export const CITE_ITEM_ATTR = "data-cite-item";

export function citeItemSelector(itemId: string): string {
  return `[${CITE_ITEM_ATTR}="${CSS.escape(itemId)}"]`;
}

/** Elements that start a new line in the plain text. */
const BLOCKS = new Set(["P", "LI", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "TR", "TD", "TH", "UL", "OL", "TABLE", "DIV", "DD", "DT", "HR"]);
/** Containers whose whitespace-only text nodes sit between blocks and do not render. */
const CONTAINERS = new Set(["UL", "OL", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "BLOCKQUOTE", "DIV", "SECTION"]);

/** An item's rendered text: its text nodes in order, a newline between blocks. */
export interface PlainText {
  text: string;
  /** Each text node and where its text starts in `text`. */
  segments: readonly { node: Text; at: number }[];
}

/** Text the user cannot select as part of the answer: buttons (Copy, Run), hidden helpers. */
function skipped(node: Text, root: Element): boolean {
  for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
    if (el.tagName === "BUTTON" || el.hasAttribute("data-cite-skip") || el.getAttribute("aria-hidden") === "true") return true;
  }
  return false;
}

function blockOf(node: Text, root: Element): Element {
  for (let el = node.parentElement; el && el !== root; el = el.parentElement) if (BLOCKS.has(el.tagName)) return el;
  return root;
}

/** The rendered plain text of an answer's element. */
export function plainText(root: Element): PlainText {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = "";
  const segments: { node: Text; at: number }[] = [];
  let block: Element | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (t.data === "" || skipped(t, root)) continue;
    const parent = t.parentElement;
    if (/^\s*$/.test(t.data) && (parent === root || (parent !== null && CONTAINERS.has(parent.tagName)))) continue;
    const b = blockOf(t, root);
    if (block !== null && b !== block && text !== "" && !text.endsWith("\n")) text += "\n";
    block = b;
    segments.push({ node: t, at: text.length });
    text += t.data;
  }
  return { text, segments };
}

/** A DOM boundary point (a selection's end) as an offset into the plain text. */
export function offsetOf(pt: PlainText, container: Node, offset: number): number {
  for (const s of pt.segments) if (s.node === container) return s.at + Math.min(offset, s.node.data.length);
  const probe = document.createRange();
  try {
    probe.setStart(container, offset);
  } catch {
    return pt.text.length;
  }
  // The first text node at or after the point starts there.
  for (const s of pt.segments) {
    try {
      if (probe.comparePoint(s.node, 0) >= 0) return s.at;
    } catch {
      // A node outside the probe's tree: not this one.
    }
  }
  return pt.text.length;
}

/** The text nodes and in-node offsets a plain-text span covers. */
function pieces(pt: PlainText, start: number, end: number): { node: Text; from: number; to: number }[] {
  const out: { node: Text; from: number; to: number }[] = [];
  for (const s of pt.segments) {
    const len = s.node.data.length;
    const from = Math.max(start, s.at);
    const to = Math.min(end, s.at + len);
    if (from < to) out.push({ node: s.node, from: from - s.at, to: to - s.at });
  }
  return out;
}

/** The DOM range of a plain-text span, or null when it covers no text. */
export function rangeOf(pt: PlainText, start: number, end: number): Range | null {
  const ps = pieces(pt, start, end);
  const first = ps[0];
  const last = ps[ps.length - 1];
  if (!first || !last) return null;
  const r = document.createRange();
  r.setStart(first.node, first.from);
  r.setEnd(last.node, last.to);
  return r;
}

/** The line boxes of a plain-text span (text only: a selected block's own box is not a line), in order. */
export function lineRects(pt: PlainText, start: number, end: number): DOMRect[] {
  const out: DOMRect[] = [];
  for (const p of pieces(pt, start, end)) {
    const r = document.createRange();
    r.setStart(p.node, p.from);
    r.setEnd(p.node, p.to);
    for (const rect of Array.from(r.getClientRects())) if (rect.width > 0 && rect.height > 0) out.push(rect);
  }
  return out;
}

/** The painted ranges: the selection kept while the comment field has the keyboard, and a cited quote. */
export type CitePaint = "cf-cite-held" | "cf-cite-mark";

interface HighlightRegistryLike {
  set(name: string, h: unknown): void;
  delete(name: string): void;
}

function registry(): HighlightRegistryLike | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS;
  return css?.highlights && typeof (globalThis as { Highlight?: unknown }).Highlight === "function" ? css.highlights : null;
}

/** Whether ranges paint with the Custom Highlight API (else the overlay). */
export function highlightsSupported(): boolean {
  return registry() !== null;
}

/** The overlay fallback's boxes for one paint, fixed over the page, outside React's tree. */
function overlay(name: CitePaint, rects: readonly DOMRect[]): void {
  document.querySelector(`[data-cite-overlay="${name}"]`)?.remove();
  if (rects.length === 0) return;
  const z = zoomFactor();
  const host = document.createElement("div");
  host.dataset.citeOverlay = name;
  host.className = "cite-overlay";
  for (const r of rects) {
    const box = document.createElement("div");
    box.style.cssText = `left:${String(r.left / z)}px;top:${String(r.top / z)}px;width:${String(r.width / z)}px;height:${String(r.height / z)}px`;
    host.appendChild(box);
  }
  document.body.appendChild(host);
}

/** Paints a range in one of the cite tints (null clears it). `rects`: its line boxes, for the overlay. */
export function paint(name: CitePaint, range: Range | null, rects: readonly DOMRect[] = []): void {
  const reg = registry();
  if (reg) {
    if (range) {
      const H = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
      reg.set(name, new H(range));
    } else reg.delete(name);
    return;
  }
  overlay(name, range ? rects : []);
}
