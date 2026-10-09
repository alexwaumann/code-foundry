import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { openUrl } from "@/stores/gh";
import { resolveLink } from "./model";

const components: Components = {
  a: ({ href, children, title }) => {
    const url = resolveLink(href);
    // A link whose target was stripped (javascript:, an anchor) is plain text: no href,
    // no pointer, nothing to click.
    if (!url) return <span title={title ?? undefined}>{children}</span>;
    return (
      <a
        href={url}
        title={title ?? url}
        onClick={(e) => {
          // Never navigate the app's own webview: links open in the browser.
          e.preventDefault();
          void openUrl(url);
        }}
      >
        {children}
      </a>
    );
  },
  img: ({ src, alt }) => (typeof src === "string" && /^https:\/\//.test(src) ? <img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" /> : null),
};

/**
 * What a body may contain after raw HTML is parsed: the elements markdown and GFM produce
 * (tables, task lists, footnotes), plus a few HTML tags GitHub bodies use (images,
 * collapsible details, line breaks, sub/superscript, keys). Everything else, script and
 * style included, is dropped. Attributes and URL schemes follow GitHub's own schema
 * (rehype-sanitize's defaultSchema), except that images load only over https.
 */
const markdownSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "input", "li", "ol", "p", "pre",
    "section", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
    "details", "summary", "sub", "sup", "kbd",
  ],
  protocols: { ...defaultSchema.protocols, src: ["https"] },
};

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeRaw, [rehypeSanitize, markdownSchema]] as NonNullable<Parameters<typeof ReactMarkdown>[0]["rehypePlugins"]>;

/**
 * GitHub-flavoured markdown (tables, task lists, strikethrough, autolinks) with the raw
 * HTML GitHub bodies use, sanitized by markdownSchema; react-markdown's URL transform also
 * strips unsafe schemes, so a body cannot inject markup or script. Links open through
 * openUrl (view.open.url).
 */
export const Markdown = memo(function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("cf-markdown", className)}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
