import { CodeBlock } from "@/components/thread/Code";
import { Tip } from "@/components/ui/tooltip";
import { messageSummary } from "./diagramInfo";
import { DiagramSvg } from "./DiagramSvg";
import { useMermaid } from "./useMermaid";

/**
 * A ```mermaid fence in rendered markdown (a README in the File tab): the diagram in a frame,
 * fitted to the column and scrolling sideways when it is wider than 60% shrinking allows.
 * Until it is drawn, and when it cannot be, the fence stays the code block it is, the latter
 * with a note saying why (the parser's whole message on hover).
 */
export function MermaidFence({ code }: { code: string }) {
  const { result, pending } = useMermaid(code);
  // A drawn diagram stays while the text changes under it (a file read again), until the new one is drawn.
  if (result?.ok) {
    return (
      <div className="cf-mermaid-fence my-3 overflow-x-auto rounded-lg border border-cf-border px-4 py-5" data-testid="md-mermaid" data-pending={pending || undefined}>
        <DiagramSvg diagram={result} testId="md-mermaid-diagram" />
      </div>
    );
  }
  const block = <CodeBlock lang="mermaid" code={code} />;
  if (!result || pending) return block;
  const summary = messageSummary(result.message);
  return (
    <div data-testid="md-mermaid-failed">
      {block}
      {/* The whole message when the note shows only its first line, or when the line is cut. */}
      <Tip label={<span className="whitespace-pre-wrap">{result.message}</span>} whenTruncated={summary === result.message}>
        <p className="-mt-1 mb-3 truncate text-caption" data-find-skip data-testid="md-mermaid-note">
          Diagram not drawn: {summary}
        </p>
      </Tip>
    </div>
  );
}
