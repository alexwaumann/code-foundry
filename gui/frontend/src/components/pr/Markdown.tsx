import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { openUrl } from "@/stores/gh";
import { resolveLink } from "./model";

const components: Components = {
  a: ({ href, children, title }) => {
    const url = resolveLink(href);
    return (
      <a
        href={url ?? undefined}
        title={title ?? url ?? undefined}
        onClick={(e) => {
          // Never navigate the app's own webview: links open in the browser.
          e.preventDefault();
          if (url) void openUrl(url);
        }}
      >
        {children}
      </a>
    );
  },
  img: ({ src, alt }) => (typeof src === "string" && /^https:\/\//.test(src) ? <img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" /> : null),
};

const plugins = [remarkGfm];

/**
 * GitHub-flavoured markdown (tables, task lists, strikethrough, autolinks). Raw HTML is
 * dropped (skipHtml) and react-markdown's URL transform strips unsafe schemes, so a body
 * cannot inject markup or script. Links open through openUrl (view.open.url).
 */
export const Markdown = memo(function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("cf-markdown", className)}>
      <ReactMarkdown remarkPlugins={plugins} skipHtml components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
