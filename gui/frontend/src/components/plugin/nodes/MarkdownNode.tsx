import { CodeBlock } from "@/components/thread/Code";
import { Markdown, type MarkdownExtras } from "@/components/pr/Markdown";
import type { NodeProps } from "../registry";

/** The thread's markdown, minus path chips and attachments: HTML as text, code blocks with Copy, links through the host. */
const extras: MarkdownExtras = {
  html: false,
  code: (lang, code) => <CodeBlock lang={lang} code={code} />,
  table: (rows) => (
    <div className="cf-table">
      <table>{rows}</table>
    </div>
  ),
};

export function MarkdownNode({ data }: NodeProps<"markdown">) {
  return (
    <div className="min-w-0 text-body-sm select-text" data-testid="plugin-markdown">
      <Markdown extras={extras}>{data.source}</Markdown>
    </div>
  );
}
