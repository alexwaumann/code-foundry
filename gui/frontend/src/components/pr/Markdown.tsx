import { memo, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { openUrl } from "@/stores/gh";
import { resolveLink } from "./model";

const baseComponents: Components = {
  a: ({ href, children, title }) => {
    const url = resolveLink(href);
    // A link whose target was stripped (javascript:, an anchor) is plain text: no href,
    // no pointer, nothing to click.
    // The tooltip is the link's markdown title, else where it goes (the window has no status bar).
    if (!url)
      return (
        <Tip label={title}>
          <span>{children}</span>
        </Tip>
      );
    return (
      <Tip label={title ?? url}>
        <a
          href={url}
          onClick={(e) => {
            // Never navigate the app's own webview: links open in the browser.
            e.preventDefault();
            void openUrl(url);
          }}
        >
          {children}
        </a>
      </Tip>
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
type RehypePlugins = NonNullable<Parameters<typeof ReactMarkdown>[0]["rehypePlugins"]>;
const rehypePlugins = [rehypeRaw, [rehypeSanitize, markdownSchema]] as RehypePlugins;
interface HastLike {
  type: string;
  value?: string;
  children?: HastLike[];
}

/** Turns raw HTML nodes into text (sanitize would drop them, and their words with them). */
function rehypeRawAsText() {
  const walk = (n: HastLike) => {
    for (const c of n.children ?? []) {
      if (c.type === "raw") c.type = "text";
      else walk(c);
    }
  };
  return walk;
}

/** Without raw HTML: any HTML in the source shows as text. Still sanitized. */
const rehypePluginsNoHtml = [rehypeRawAsText, [rehypeSanitize, markdownSchema]] as RehypePlugins;

/** Optional renderers a surface adds (a thread: highlighted code, attachment images). */
export interface MarkdownExtras {
  /** A fenced code block: its info string's language ("" without one) and its code (no trailing newline). */
  code?: (lang: string, code: string) => ReactNode;
  /** An image whose src is not https (https images always load); null renders nothing. */
  image?: (src: string, alt: string) => ReactNode;
  /** A table, given its rows (thead, tbody) to put in a <table>: lets a surface wrap it. */
  table?: (rows: ReactNode) => ReactNode;
  /**
   * false: HTML in the source is text, not markup (Claude's answers: "Result<T, E>" must
   * not vanish as an unknown tag). Default true (GitHub bodies use HTML).
   */
  html?: boolean;
}

function withExtras(extras: MarkdownExtras): Components {
  const { code, image, table } = extras;
  return {
    ...baseComponents,
    ...(code && {
      pre: ({ node, children }) => {
        // The hast <pre>'s <code>: its language class and its text.
        const el = node?.children.find((c) => c.type === "element" && c.tagName === "code");
        if (el?.type !== "element") return <pre>{children}</pre>;
        const classes = Array.isArray(el.properties.className) ? el.properties.className.map(String) : [];
        const lang = classes.find((c) => c.startsWith("language-"))?.slice("language-".length) ?? "";
        const text = el.children.map((c) => (c.type === "text" ? c.value : "")).join("");
        return <>{code(lang, text.replace(/\n$/, ""))}</>;
      },
    }),
    ...(image && {
      img: ({ src, alt }) => (typeof src !== "string" ? null : /^https:\/\//.test(src) ? <img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" /> : image(src, alt ?? "")),
    }),
    ...(table && { table: ({ children }) => <>{table(children)}</> }),
  };
}

/**
 * GitHub-flavoured markdown (tables, task lists, strikethrough, autolinks) with the raw
 * HTML GitHub bodies use, sanitized by markdownSchema; react-markdown's URL transform also
 * strips unsafe schemes, so a body cannot inject markup or script. Links open through
 * openUrl (view.open.url). `extras` adds renderers and can turn raw HTML off (pass a
 * stable object).
 */
export const Markdown = memo(function Markdown({ children, className, extras }: { children: string; className?: string; extras?: MarkdownExtras }) {
  const components = useMemo(() => (extras ? withExtras(extras) : baseComponents), [extras]);
  return (
    <div className={cn("cf-markdown", className)}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={extras?.html === false ? rehypePluginsNoHtml : rehypePlugins} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
