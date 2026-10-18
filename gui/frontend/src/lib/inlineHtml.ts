/**
 * Inline HTML in Claude's answers (docs/notes/panel-polish.md). A thread shows HTML as
 * text, like Claude Code's own UI: "<pasted_content>", "<file>" and "Result<T, E>" must
 * stay visible. Only a fixed set of inline formatting tags renders, and only as a bare,
 * matched pair inside one paragraph (or heading, cell, list item...): `<small>fine
 * print</small>`, `<br>`. Anything else (another tag, a tag with attributes, an HTML
 * block, an opening tag without its closing one) stays literal text.
 *
 * A rehype plugin over the raw nodes remark-rehype leaves for inline HTML. Code spans and
 * fenced blocks hold text, not raw nodes, so a tag inside them stays literal for free.
 * It builds the elements itself rather than handing the raw tags to rehype-raw: the HTML
 * parser re-opens unclosed formatting elements (small, s, u...) in every following
 * paragraph, so one stray `<small>` would shrink the rest of the message.
 */

/** The tags that render in a thread's answer; br is the only void one. */
export const INLINE_HTML_TAGS: readonly string[] = ["small", "mark", "sub", "sup", "kbd", "ins", "s", "del", "u", "br"];

const PAIRED = new Set(INLINE_HTML_TAGS.filter((t) => t !== "br"));

/** A hast node as this plugin reads and writes it. */
export interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

type Tag = { kind: "br" } | { kind: "open" | "close"; name: string };

/** A raw node that is exactly one allowlisted tag without attributes: `<small>`, `</small>`, `<br>`, `<br/>`. */
export function inlineTag(raw: string): Tag | null {
  const m = /^<(\/?)([a-zA-Z]+)\s*(\/?)>$/.exec(raw);
  if (!m) return null;
  const [, close, rawName, self] = m;
  const name = (rawName ?? "").toLowerCase();
  if (name === "br") return close ? null : { kind: "br" };
  if (!PAIRED.has(name) || self) return null;
  return { kind: close ? "close" : "open", name };
}

const text = (value: string): HastNode => ({ type: "text", value });
const element = (tagName: string, children: HastNode[]): HastNode => ({ type: "element", tagName, properties: {}, children });

interface Frame {
  name: string;
  open: string;
  out: HastNode[];
}

/** One parent's children with matched allowlisted pairs made elements and every other raw node made text. */
export function buildInline(children: readonly HastNode[]): HastNode[] {
  const root: HastNode[] = [];
  const stack: Frame[] = [];
  const out = () => stack.at(-1)?.out ?? root;
  // An opening tag that never closed: its text, then what it would have wrapped.
  const unwind = (f: Frame) => {
    out().push(text(f.open), ...f.out);
  };
  for (const c of children) {
    if (c.type !== "raw") {
      out().push(c);
      continue;
    }
    const value = c.value ?? "";
    const tag = inlineTag(value);
    if (!tag) {
      out().push(text(value));
    } else if (tag.kind === "br") {
      out().push(element("br", []));
    } else if (tag.kind === "open") {
      stack.push({ name: tag.name, open: value, out: [] });
    } else {
      let i = stack.length - 1;
      while (i >= 0 && stack[i]?.name !== tag.name) i--;
      if (i < 0) {
        out().push(text(value));
        continue;
      }
      while (stack.length - 1 > i) unwind(stack.pop() as Frame);
      const f = stack.pop() as Frame;
      out().push(element(f.name, f.out));
    }
  }
  while (stack.length > 0) unwind(stack.pop() as Frame);
  return root;
}

/** The rehype plugin: every parent's children through buildInline, depth first. */
export function rehypeInlineHtml() {
  const walk = (n: HastNode) => {
    if (!n.children) return;
    n.children = buildInline(n.children);
    for (const c of n.children) walk(c);
  };
  return walk;
}
