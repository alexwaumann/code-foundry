import { memo, useMemo, type ReactNode } from "react";
import { ImageIcon } from "lucide-react";
import { Markdown, MarkdownContent, type MarkdownExtras } from "@/components/pr/Markdown";
import { Tip } from "@/components/ui/tooltip";
import { grammarFor, highlightLines, type Token } from "@/lib/highlight";
import { markdownBlocks } from "@/lib/markdownBlocks";
import { linkPath } from "@/lib/pathChips";
import { cn } from "@/lib/utils";
import { useAttachmentUrl } from "@/stores/attachments";
import { CodeActions } from "./CodeActions";
import { CodeRunContext, type CodeRunCtx } from "./codeContext";
import { PathChip } from "./PathChip";

/** One line's tokens as spans. */
export function TokenSpans({ tokens }: { tokens: readonly Token[] }): ReactNode {
  return tokens.map((t, i) => (
    <span key={i} className={t.cls || undefined}>
      {t.text}
    </span>
  ));
}

/**
 * A fenced code block, highlighted with the terminal palette (lib/highlight), with Copy
 * (and Run in terminal for a shell block in Claude's reply) at its top right.
 */
export const CodeBlock = memo(function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const lines = useMemo(() => highlightLines(code, grammarFor(lang)), [code, lang]);
  return (
    <div className="cf-code">
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
      <CodeActions lang={lang} code={code} />
    </div>
  );
});

/**
 * An image in a thread's markdown with a local path: a staged attachment loads
 * through ReadAttachment; anything else (a file in the worktree) shows as a chip with its path.
 */
function LocalImage({ src, alt }: { src: string; alt: string }) {
  const { url, loading } = useAttachmentUrl(src);
  if (url) return <img src={url} alt={alt} />;
  return (
    // The path, when the chip shows the alt text or "Loading image…" instead.
    <Tip label={loading || alt ? src : null}>
      <span className="inline-flex items-center gap-1 rounded-sm border px-1.5 text-caption">
        <ImageIcon className="size-3" aria-hidden />
        {loading ? "Loading image…" : alt || src}
      </span>
    </Tip>
  );
}

/** The thread's markdown renderers (stable: Markdown memoizes on it). HTML is shown as text, like Claude Code's own UI, but for matched pairs of a few inline tags such as <small> (lib/inlineHtml). */
const threadExtras: MarkdownExtras = {
  html: false,
  code: (lang, code) => <CodeBlock lang={lang} code={code} />,
  // File paths open the File tab, relative ones against the thread's checkout (PathChip).
  pathChip: (m) => <PathChip match={m} />,
  // A relative link (`[main.go](src/main.go)`) is a file too: a chip when its target reads
  // as a path, else its text (it is no github.com page).
  link: (href, children) => {
    const m = linkPath(href);
    return m ? <PathChip match={m} /> : <span data-testid="link-plain">{children}</span>;
  },
  image: (src, alt) => <LocalImage src={src} alt={alt} />,
  // The frame (rounded, scrolling sideways when too wide) is the wrapper's: thread.css.
  table: (rows) => (
    <div className="cf-table">
      <table>{rows}</table>
    </div>
  ),
};

/** Markdown as the thread shows it: the PR surface's renderer with highlighted code, attachment images and path chips. */
export function ThreadMarkdown({ children, className }: { children: string; className?: string }) {
  return (
    <Markdown className={className} extras={threadExtras}>
      {children}
    </Markdown>
  );
}

/**
 * Claude's reply while it streams: cut into top-level blocks (lib/markdownBlocks), each
 * rendered once and memoized, inside one .cf-markdown wrapper (the blocks' elements are its
 * children, as in a whole render), so a delta re-parses only the growing last block instead
 * of the whole answer. The finished blocks' code is complete, so their Run in terminal
 * needs no text (a stable context); only the last block's context changes per delta. When
 * the stream ends the reply renders whole (ThreadMarkdown) once.
 */
export function StreamingMarkdown({ text, threadId, className }: { text: string; threadId: string; className?: string }) {
  const blocks = useMemo(() => markdownBlocks(text), [text]);
  const last = blocks.length - 1;
  const tail = blocks[last] ?? "";
  const done = useMemo<CodeRunCtx>(() => ({ threadId, text: "", streaming: false }), [threadId]);
  const live = useMemo<CodeRunCtx>(() => ({ threadId, text: tail, streaming: true }), [threadId, tail]);
  return (
    <div className={cn("cf-markdown cf-streaming", className)}>
      {blocks.map((b, i) => (
        <CodeRunContext.Provider key={i} value={i === last ? live : done}>
          <MarkdownContent extras={threadExtras}>{b}</MarkdownContent>
        </CodeRunContext.Provider>
      ))}
    </div>
  );
}
