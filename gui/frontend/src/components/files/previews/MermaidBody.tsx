import { useEffect } from "react";
import { Code, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { diagramMeta, diagramTypeOf } from "@/components/mermaid/diagramInfo";
import { DiagramSvg } from "@/components/mermaid/DiagramSvg";
import { useMermaid } from "@/components/mermaid/useMermaid";
import { formatSize } from "../fileKind";
import { SOURCE, type PreviewBodyProps } from "./types";

/**
 * A Mermaid file's Diagram mode: the diagram fitted to the pane and centred, scrolling when
 * it is taller or wider than the pane can show; the parser's message and a way to Source
 * when it cannot be drawn. Row two gains the node count once a flowchart is drawn.
 */
export function MermaidBody({ file, onMeta, onMode }: PreviewBodyProps) {
  const source = file.text ?? "";
  const { result } = useMermaid(source);
  const nodes = result?.ok ? result.nodes : null;
  useEffect(() => {
    if (nodes !== null) onMeta(diagramMeta(diagramTypeOf(source), nodes, formatSize(file.size)));
  }, [nodes, source, file.size, onMeta]);
  if (!result)
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-caption" data-testid="file-mermaid-drawing">
        Drawing…
      </div>
    );
  if (!result.ok)
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-auto p-6 text-center" data-testid="file-mermaid-error">
        <TriangleAlert className="size-6 text-cf-error" aria-hidden />
        <p className="text-subheading">This diagram cannot be drawn</p>
        <pre className="max-w-full overflow-x-auto rounded-md bg-cf-surface-sunken px-3 py-2 text-left text-code whitespace-pre-wrap text-cf-text-secondary" data-testid="file-mermaid-message">
          {result.message}
        </pre>
        <Button
          variant="outline"
          size="sm"
          className="mt-1"
          onClick={() => {
            onMode(SOURCE.id);
          }}
          data-testid="file-mermaid-source"
        >
          <Code aria-hidden />
          Show source
        </Button>
      </div>
    );
  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="file-mermaid">
      <div className="flex min-h-full items-center px-4 py-6">
        <DiagramSvg diagram={result} testId="file-mermaid-diagram" />
      </div>
    </div>
  );
}
