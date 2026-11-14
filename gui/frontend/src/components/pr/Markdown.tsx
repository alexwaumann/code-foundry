import { memo, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Tip } from "@/components/ui/tooltip";
import { REF_PROP, REF_TIGHT_PROP } from "@/lib/answerMarkdown";
import { rehypePluginsFor, rehypePluginsInertFor, remarkPlugins, remarkTaskPlugins } from "@/lib/markdownPlugins";
import { CHIP_PROP, isRelativeHref, matchPath, type PathMatch } from "@/lib/pathChips";
import { fitScrollbar } from "@/lib/scrollbarFit";
import { taskItemOf, type TaskItem } from "@/lib/taskItems";
import { cn } from "@/lib/utils";
import { openUrl } from "@/stores/gh";
import { resolveLink } from "./model";

/**
 * A link: through openUrl (resolveLink: relative ones are github.com paths), or plain text
 * when it goes nowhere. With `open` (MarkdownExtras.openLink), a plain click asks it first
 * and opens the browser only when it declines; a cmd, ctrl or middle click always opens the
 * browser.
 */
function Link({ href, children, tip, open }: { href?: string | undefined; children?: ReactNode; tip?: string | undefined; open?: ((url: string) => boolean) | undefined }) {
  const url = resolveLink(href);
  // A link whose target was stripped (javascript:, an anchor) is plain text: no href,
  // no pointer, nothing to click.
  // The tooltip is the link's markdown title, else where it goes (the window has no status
  // bar), unless the link's text already says that (a bare URL).
  if (!url)
    return (
      <Tip label={tip}>
        <span>{children}</span>
      </Tip>
    );
  return (
    <Tip label={tip ?? (showsTarget(children, href, url) ? undefined : url)}>
      <a
        href={url}
        onClick={(e) => {
          // Never navigate the app's own webview: links open in the browser.
          e.preventDefault();
          if (open && isPlainClick(e) && open(url)) return;
          void openUrl(url);
        }}
        onAuxClick={
          open &&
          ((e) => {
            // A middle click is "somewhere else": the browser, as cmd+click.
            if (e.button !== 1) return;
            e.preventDefault();
            void openUrl(url);
          })
        }
      >
        {children}
      </a>
    </Tip>
  );
}

/** Whether a link's text is its own target (a bare URL), so a tooltip would only repeat it. */
function showsTarget(children: ReactNode, href: string | undefined, url: string): boolean {
  const text = Array.isArray(children) && children.length === 1 ? (children[0] as ReactNode) : children;
  return typeof text === "string" && (text === href || text === url);
}

/** A click with the main button and no cmd or ctrl (which mean "in the browser"). */
function isPlainClick(e: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey">): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey;
}

const baseComponents: Components = {
  a: ({ href, children, title }) => <Link href={href} tip={title}>{children}</Link>,
  img: ({ src, alt }) => (typeof src === "string" && /^https:\/\//.test(src) ? <img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" /> : null),
  pre: ({ node: _node, ...props }) => <pre {...props} ref={fitScrollbar} />,
  table: ({ node: _node, ...props }) => <table {...props} ref={fitScrollbar} />,
};

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
  /**
   * A plain click on a link that goes somewhere (its resolved URL): true when the surface
   * opened it itself (a GitHub pull request in a tab: components/pr/prLinks.ts),
   * false to open the browser. Cmd, ctrl and middle clicks always open the browser. Without
   * it, every link opens the browser.
   */
  openLink?: (url: string) => boolean;
  /**
   * A task-list box (lib/taskItems) to draw in place of the disabled <input>, for a body
   * people can edit (a pull request's description). A box in raw HTML is not one and stays
   * as it is. Needs raw HTML on (GitHub bodies). Without it, every box is read-only.
   */
  task?: (item: TaskItem) => ReactNode;
  /**
   * Text that must do nothing (an agent search's answer, which derives from old thread
   * content): a link is its text, an image its alt text, raw HTML shows as typed. Nothing
   * loads or navigates, whatever else `extras` says.
   */
  inert?: boolean;
  /**
   * With `inert`, an [n] reference in the text outside code (lib/answerMarkdown): what
   * renders in its place. `tight`: punctuation follows it, so it sits against that.
   */
  citation?: (n: number, tight: boolean) => ReactNode;
}

function withExtras(extras: MarkdownExtras): Components {
  const { code, image, table, pathChip, link, openLink, task, citation } = extras;
  return {
    ...baseComponents,
    ...((link || openLink) && {
      a: ({ href, children, title }) =>
        link && typeof href === "string" && isRelativeHref(href) ? (
          <>{link(href, children)}</>
        ) : (
          <Link href={href} tip={title} open={openLink}>
            {children}
          </Link>
        ),
    }),
    ...(code && {
      pre: ({ node, children }) => {
        // The hast <pre>'s <code>: its language class and its text.
        const el = node?.children.find((c) => c.type === "element" && c.tagName === "code");
        if (el?.type !== "element") return <pre ref={fitScrollbar}>{children}</pre>;
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
    ...(task && {
      input: ({ node, ...props }) => {
        const item = taskItemOf(node);
        return item ? <>{task(item)}</> : <input {...props} />;
      },
    }),
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
    ...(citation && {
      span: ({ node, children, ...props }) => {
        const n = node?.properties[REF_PROP];
        return typeof n === "number" ? <>{citation(n, node?.properties[REF_TIGHT_PROP] === true)}</> : <span {...props}>{children}</span>;
      },
    }),
  };
}

/** The rehype plugins for a set of extras (lib/markdownPlugins): inert, else raw HTML or not, then the prose path pass. */
function rehypeFor(extras: MarkdownExtras | undefined) {
  if (extras?.inert) return rehypePluginsInertFor({ citations: extras.citation !== undefined });
  return rehypePluginsFor({ html: extras?.html !== false, pathChips: extras?.pathChip !== undefined, tasks: extras?.task !== undefined });
}

/**
 * GitHub-flavoured markdown (tables, task lists, strikethrough, autolinks) with the raw
 * HTML GitHub bodies use, sanitized by markdownSchema; react-markdown's URL transform also
 * strips unsafe schemes, so a body cannot inject markup or script. Links open through
 * openUrl (view.open.url), unless extras.openLink takes a plain click. `extras` adds renderers and can turn raw HTML off (pass a
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
    <ReactMarkdown remarkPlugins={extras?.task ? remarkTaskPlugins : remarkPlugins} rehypePlugins={rehype} components={components}>
      {children}
    </ReactMarkdown>
  );
});
