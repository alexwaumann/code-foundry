/**
 * The markdown renderer's parse (components/pr/Markdown): its remark and rehype plugins,
 * in one place so the in-thread find's text (lib/markdownText) runs exactly the parse the
 * thread renders and the two cannot drift.
 */
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import { INLINE_HTML_TAGS, rehypeInlineHtml } from "./inlineHtml";
import { rehypePathChips } from "./pathChips";

/** What markdown and GFM produce themselves. */
const markdownTags = [
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "input", "li", "ol", "p", "pre",
  "section", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
];

/**
 * What a body may contain after raw HTML is parsed: the elements markdown and GFM produce
 * (tables, task lists, footnotes), plus a few HTML tags GitHub bodies use (images,
 * collapsible details, line breaks, sub/superscript, keys, fine print, highlights, inserted
 * and struck text). Everything else, script and style included, is dropped. Attributes and URL schemes follow GitHub's own schema
 * (rehype-sanitize's defaultSchema), except that images load only over https.
 */
const markdownSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...markdownTags, "details", "summary", "sub", "sup", "kbd", "small", "mark", "ins", "s", "u"],
  protocols: { ...defaultSchema.protocols, src: ["https"] },
};

/** Without raw HTML (a thread): markdown's own elements and the inline tags lib/inlineHtml builds, nothing else. */
const inlineSchema: SanitizeSchema = { ...markdownSchema, tagNames: [...new Set([...markdownTags, ...INLINE_HTML_TAGS])] };

export const remarkPlugins: PluggableList = [remarkGfm];
const rehypePlugins: PluggableList = [rehypeRaw, [rehypeSanitize, markdownSchema]];
/**
 * Without raw HTML: HTML in the source shows as text, except matched pairs of a few inline
 * tags (small, mark, sub, sup, kbd, ins, s, del, u) and br, which render
 * (lib/inlineHtml). Never stripped silently. Still sanitized.
 */
const rehypePluginsNoHtml: PluggableList = [rehypeInlineHtml, [rehypeSanitize, inlineSchema]];

/** The rehype plugins for a surface: raw HTML or not, then the prose path pass when it draws path chips. */
export function rehypePluginsFor(opts: { html: boolean; pathChips: boolean }): PluggableList {
  const base = opts.html ? rehypePlugins : rehypePluginsNoHtml;
  return opts.pathChips ? [...base, rehypePathChips] : base;
}

/** A thread's answer (components/thread/Code threadExtras): no raw HTML, path chips. */
export const threadRehypePlugins = rehypePluginsFor({ html: false, pathChips: true });
