/**
 * Claude's markdown as the thread renders it, as plain text, without a DOM: the text the
 * in-thread find matches (docs/notes/search-2-thread-find.md). It must equal what the cite
 * layer's plainText (components/thread/cite/citeDom.ts) reads from the rendered answer, so
 * a match's offsets in the data are the same text in the DOM: the text nodes in order, a
 * newline where the next one is in another block, whitespace between blocks left out.
 *
 * It runs the parse the thread's renderer runs (the plugins of lib/markdownPlugins, which
 * components/pr/Markdown renders with: GFM, raw HTML as text but for the inline pairs of
 * lib/inlineHtml, the sanitizer, the prose path pass) and reads the tree as the thread's
 * components draw it (components/thread/Code threadExtras): a fenced block's code without
 * its last newline, an inline code span, relative link or prose token that is a path as
 * the path chip's text, images as nothing (a loaded image has no text; an unloaded one's
 * chip is skipped in the DOM, components/thread/find/findDom FIND_SKIP).
 *
 * A streaming answer renders block by block (components/thread/Code StreamingMarkdown,
 * lib/markdownBlocks): streamingMarkdownText reads it the same way, each finished block
 * parsed once.
 */
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import type { HastNode } from "./inlineHtml";
import { markdownBlocks } from "./markdownBlocks";
import { remarkPlugins, threadRehypePlugins } from "./markdownPlugins";
import { CHIP_PROP, linkPath, matchPath } from "./pathChips";

// react-markdown's own parse: remark-parse, the remark plugins, remark-rehype keeping raw HTML, the rehype plugins.
const processor = unified().use(remarkParse).use(remarkPlugins).use(remarkRehype, { allowDangerousHtml: true }).use(threadRehypePlugins);

/** Elements that start a new line in the plain text (citeDom BLOCKS, lower case). */
const BLOCKS = new Set(["p", "li", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "tr", "td", "th", "ul", "ol", "table", "div", "dd", "dt", "hr"]);
/** Containers whose whitespace-only text sits between blocks and does not render (citeDom CONTAINERS). */
const CONTAINERS = new Set(["ul", "ol", "table", "thead", "tbody", "tfoot", "tr", "blockquote", "div", "section"]);

/** The text of a node's subtree, as is. */
function textOf(n: HastNode): string {
  if (n.type === "text") return n.value ?? "";
  return (n.children ?? []).map(textOf).join("");
}

class Builder {
  text = "";
  private block: object | null = null;

  /** A text node under `block` whose parent is `parent` (null: the root). */
  add(value: string, block: object, parent: string | null): void {
    if (value === "") return;
    if (/^\s*$/.test(value) && (parent === null || CONTAINERS.has(parent))) return;
    if (this.block !== null && block !== this.block && this.text !== "" && !this.text.endsWith("\n")) this.text += "\n";
    this.block = block;
    this.text += value;
  }
}

function walk(n: HastNode, block: object, parent: string | null, b: Builder): void {
  if (n.type === "text") {
    b.add(n.value ?? "", block, parent);
    return;
  }
  if (n.type !== "element" && n.type !== "root") return;
  const tag = n.tagName ?? null;
  const own = tag !== null && BLOCKS.has(tag) ? n : block;
  switch (tag) {
    case "pre": {
      // CodeBlock: the code's lines, its last newline dropped.
      const code = n.children?.find((c) => c.type === "element" && c.tagName === "code");
      b.add(textOf(code ?? n).replace(/\n$/, ""), own, "code");
      return;
    }
    case "code": {
      // An inline code span: a path chip shows the trimmed token.
      const t = textOf(n);
      const m = !t.includes("\n") ? matchPath(t.trim(), "code") : null;
      b.add(m ? m.text : t, own, tag);
      return;
    }
    case "a": {
      // A relative link that reads as a path is a chip with the path, not the link's text.
      const href = n.properties?.href;
      const m = typeof href === "string" ? linkPath(href) : null;
      if (m) {
        b.add(m.text, own, tag);
        return;
      }
      break;
    }
    case "span": {
      // A path in prose (lib/pathChips rehypePathChips): the chip shows the matched path.
      const token = n.properties?.[CHIP_PROP];
      if (typeof token === "string") {
        b.add(matchPath(token, "prose")?.text ?? textOf(n), own, tag);
        return;
      }
      break;
    }
    case "img":
    case "input":
      return;
  }
  for (const c of n.children ?? []) walk(c, own, tag, b);
}

/** A thread answer's markdown as the text the thread shows (see the file comment). */
export function markdownText(markdown: string): string {
  if (markdown === "") return "";
  const tree = processor.runSync(processor.parse(markdown)) as unknown as HastNode;
  const b = new Builder();
  walk(tree, tree, null, b);
  return b.text;
}

/** Joins texts that render one after another in one element: a newline between two, unless the first ends in one (citeDom plainText). */
export function joinBlocks(texts: readonly string[]): string {
  let out = "";
  for (const t of texts) {
    if (t === "") continue;
    out += out === "" || out.endsWith("\n") ? t : `\n${t}`;
  }
  return out;
}

/** Each streaming block's text by its source, most recently used last (a finished block is parsed once; the growing last one each time). */
const blockTexts = new Map<string, string>();
const BLOCK_CACHE = 2000;

function blockText(block: string): string {
  const hit = blockTexts.get(block);
  if (hit !== undefined) {
    blockTexts.delete(block);
    blockTexts.set(block, hit);
    return hit;
  }
  const t = markdownText(block);
  blockTexts.set(block, t);
  if (blockTexts.size > BLOCK_CACHE) blockTexts.delete(blockTexts.keys().next().value ?? "");
  return t;
}

/**
 * A streaming answer's text as StreamingMarkdown renders it: each top-level block
 * (lib/markdownBlocks) parsed alone, so a link reference or footnote resolves only once
 * the answer ends and renders whole, as on screen.
 */
export function streamingMarkdownText(markdown: string): string {
  if (markdown === "") return "";
  return joinBlocks(markdownBlocks(markdown).map(blockText));
}
