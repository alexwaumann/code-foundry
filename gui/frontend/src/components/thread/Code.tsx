import { memo, useMemo, type ReactNode } from "react";
import { ImageIcon } from "lucide-react";
import { Markdown, type MarkdownExtras } from "@/components/pr/Markdown";
import { grammarFor, highlightLines, type MarkedToken, type Token } from "@/lib/highlight";
import { useAttachmentUrl } from "@/stores/attachmentImages";

/** One line's tokens as spans (marked tokens wrapped in `mark`: ins or del). */
export function TokenSpans({ tokens, mark }: { tokens: readonly (Token | MarkedToken)[]; mark?: "ins" | "del" }): ReactNode {
  return tokens.map((t, i) => {
    const span = t.cls ? (
      <span key={i} className={t.cls}>
        {t.text}
      </span>
    ) : (
      t.text
    );
    if (mark && "marked" in t && t.marked) {
      const Tag = mark;
      return <Tag key={i}>{span}</Tag>;
    }
    return typeof span === "string" ? <span key={i}>{span}</span> : span;
  });
}

/** A fenced code block, highlighted with the terminal palette (lib/highlight). */
export const CodeBlock = memo(function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const lines = useMemo(() => highlightLines(code, grammarFor(lang)), [code, lang]);
  return (
    <pre data-lang={lang || undefined}>
      <code>
        {lines.map((l, i) => (
          <span key={i}>
            <TokenSpans tokens={l} />
            {i < lines.length - 1 ? "\n" : ""}
          </span>
        ))}
      </code>
    </pre>
  );
});

/**
 * An image in a rendered thread's markdown with a local path: a staged attachment loads
 * through ReadAttachment; anything else (a file in the worktree) shows as a chip with its path.
 */
function LocalImage({ src, alt }: { src: string; alt: string }) {
  const { url, loading } = useAttachmentUrl(src);
  if (url) return <img src={url} alt={alt} />;
  return (
    <span className="inline-flex items-center gap-1 rounded border px-1.5 text-xs text-muted-foreground" title={src}>
      <ImageIcon className="size-3" aria-hidden />
      {loading ? "Loading image…" : alt || src}
    </span>
  );
}

/** The thread's markdown renderers (stable: Markdown memoizes on it). */
const threadExtras: MarkdownExtras = {
  code: (lang, code) => <CodeBlock lang={lang} code={code} />,
  image: (src, alt) => <LocalImage src={src} alt={alt} />,
};

/** Markdown as the thread shows it: the PR surface's renderer with highlighted code and attachment images. */
export function ThreadMarkdown({ children, className }: { children: string; className?: string }) {
  return (
    <Markdown className={className} extras={threadExtras}>
      {children}
    </Markdown>
  );
}
