import { diagramMeta, diagramTypeOf } from "@/components/mermaid/diagramInfo";
import { formatSize } from "../../fileKind";
import { MermaidBody } from "../MermaidBody";
import type { PreviewKind } from "../types";

/**
 * Mermaid: Diagram | Source. The body is light; the library loads when it first draws
 * (components/mermaid/useMermaid), so it is not lazy itself. The type comes from the text;
 * the node count from the drawing (MermaidBody), for a flowchart only.
 */
const mermaid: PreviewKind = {
  id: "mermaid",
  match: { ext: ["mmd", "mermaid"], mime: ["text/vnd.mermaid"] },
  modes: [{ id: "diagram", label: "Diagram" }],
  Body: MermaidBody,
  meta: ({ file }) => diagramMeta(diagramTypeOf(file.text ?? ""), null, formatSize(file.size)),
};

export default mermaid;
