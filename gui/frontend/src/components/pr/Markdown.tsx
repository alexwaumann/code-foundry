import { memo, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { Tip } from "@/components/ui/tooltip";
import { INLINE_HTML_TAGS, rehypeInlineHtml } from "@/lib/inlineHtml";
import { CHIP_PROP, isRelativeHref, matchPath, rehypePathChips, type PathMatch } from "@/lib/pathChips";
import { cn } from "@/lib/utils";
import { openUrl } from "@/stores/gh";
import { resolveLink } from "./model";

/** A link: through openUrl (resolveLink: relative ones are github.com paths), or plain text when it goes nowhere. */
function Link({ href, children, title }: { href?: string | undefined; children?: ReactNode; title?: string | undefined }) {
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
}

const baseComponents: Components = {
  a: ({ href, children, title }) => <Link href={href} title={title}>{children}</Link>,
  img: ({ src, alt }) => (typeof src === "string" && /^https:\/\//.test(src) ? <img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" /> : null),
};

/**
 * What a body may contain after raw HTML is parsed: the elements markdown and GFM produce
 * (tables, task lists, footnotes), plus a few HTML tags GitHub bodies use (images,
 * collapsible details, line breaks, sub/superscript, keys, fine print, highlights, inserted
 * and struck text). Everything else, script and style included, is dropped. Attributes and URL schemes follow GitHub's own schema
 * (rehype-sanitize's defaultSchema), except that images load only over https.
 */
/** What markdown and GFM produce themselves. */
const markdownTags = [
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "input", "li", "ol", "p", "pre",
  "section", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
];

const markdownSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...markdownTags, "details", "summary", "sub", "sup", "kbd", "small", "mark", "ins", "s", "u"],
  protocols: { ...defaultSchema.protocols, src: ["https"] },
};

/** Without raw HTML (a thread): markdown's own elements and the inline tags lib/inlineHtml builds, nothing else. */
const inlineSchema: SanitizeSchema = { ...markdownSchema, tagNames: [...new Set([...markdownTags, ...INLINE_HTML_TAGS])] };

const remarkPlugins = [remarkGfm];
type RehypePlugins = NonNullable<Parameters<typeof ReactMarkdown>[0]["rehypePlugins"]>;
const rehypePlugins = [rehypeRaw, [rehypeSanitize, markdownSchema]] as RehypePlugins;
/**
 * Without raw HTML: HTML in the source shows as text, except matched pairs of a few inline
 * tags (small, mark, sub, sup, kbd, ins, s, del, u) and br, which render
 * (lib/inlineHtml). Never stripped silently. Still sanitized.
 */
const rehypePluginsNoHtml = [rehypeInlineHtml, [rehypeSanitize, inlineSchema]] as RehypePlugins;

/** Optional renderers a surface adds (a thread: highlighted code, attachment images). */
export interface MarkdownExtras {
  /** A fenced code block: its info string's language ("" without one) and its code (no trailing newline). */
  code?: (lang: string, code: string) => ReactNode;
  /** An image whose src is not https (https images always load); null renders nothing. */
  image?: (src: string, alt: string) => ReactNode;
  /** A table, given its rows (thead, tbody) to put in a <table>: lets a surface wrap it. */
  table?: (rows: ReactNode) => ReactNode;
  /**
   * false: HTML in the source is text, not markup (Claude's answers: "Result<T, E>" or
   * "<pasted_content>" must not vanish as an unknown tag), but for matched pairs of a few
   * inline tags such as `<small>` (lib/inlineHtml). Default true (GitHub bodies use HTML).
   */
  html?: boolean;
  /**
   * A file path (lib/pathChips): an inline code span that is one, and paths in prose (a
   * rehype pass over the text). Not in fenced code or links. Without it, paths stay text.
   */
  pathChip?: (m: PathMatch) => ReactNode;
  /**
   * A link with a relative href (lib/pathChips isRelativeHref): what renders instead. Without
   * it, relative links resolve against github.com (right for a GitHub body, not for a
   * thread's answer, where `[main.go](src/main.go)` means a file).
   */
  link?: (href: string, children: ReactNode) => ReactNode;
}

function withExtras(extras: MarkdownExtras): Components {
  const { code, image, table, pathChip, link } = extras;
  return {
    ...baseComponents,
    ...(link && {
      a: ({ href, children, title }) =>
        typeof href === "string" && isRelativeHref(href) ? (
          <>{link(href, children)}</>
        ) : (
          <Link href={href} title={title}>
            {children}
          </Link>
        ),
    }),
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
    ...(pathChip && {
      code: ({ className, children }) => {
        // Inline code only: a fenced block's text has a language class or ends in a newline
        // (and a surface with `code` never renders its <code> here at all).
        const m = typeof children === "string" && !className && !children.includes("\n") ? matchPath(children.trim(), "code") : null;
        return m ? <>{pathChip(m)}</> : <code className={className}>{children}</code>;
      },
      span: ({ node, children, ...props }) => {
        const token = node?.properties[CHIP_PROP];
        const m = typeof token === "string" ? matchPath(token, "prose") : null;
        return m ? <>{pathChip(m)}</> : <span {...props}>{children}</span>;
      },
    }),
  };
}

/** The rehype plugins for a set of extras: raw HTML or not, then the prose path pass. */
function rehypeFor(extras: MarkdownExtras | undefined): RehypePlugins {
  const base = extras?.html === false ? rehypePluginsNoHtml : rehypePlugins;
  return extras?.pathChip ? [...base, rehypePathChips] : base;
}

/**
 * GitHub-flavoured markdown (tables, task lists, strikethrough, autolinks) with the raw
 * HTML GitHub bodies use, sanitized by markdownSchema; react-markdown's URL transform also
 * strips unsafe schemes, so a body cannot inject markup or script. Links open through
 * openUrl (view.open.url). `extras` adds renderers and can turn raw HTML off (pass a
 * stable object).
 */
export const Markdown = memo(function Markdown({ children, className, extras }: { children: string; className?: string; extras?: MarkdownExtras }) {
  return (
    <div className={cn("cf-markdown", className)}>
      <MarkdownContent extras={extras}>{children}</MarkdownContent>
    </div>
  );
});

/**
 * Markdown's elements without the .cf-markdown wrapper: a streaming answer renders its
 * finished blocks as one of these each, inside one wrapper (components/thread/Code
 * StreamingMarkdown), so only the growing last block re-parses. Memoized on the source.
 */
export const MarkdownContent = memo(function MarkdownContent({ children, extras }: { children: string; extras?: MarkdownExtras | undefined }) {
  const components = useMemo(() => (extras ? withExtras(extras) : baseComponents), [extras]);
  const rehype = useMemo(() => rehypeFor(extras), [extras]);
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehype} components={components}>
      {children}
    </ReactMarkdown>
  );
});
