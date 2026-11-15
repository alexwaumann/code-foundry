/** A render's outcome (render.ts): the sanitized SVG and what it shows, or the parser's or renderer's message. */
export type RenderedDiagram =
  | {
      readonly ok: true;
      /** The id Mermaid drew under: the SVG's id, and the prefix of its CSS and marker ids (`useMermaid` gives each view its own). */
      readonly id: string;
      /** Sanitized markup (sanitizeSvg). */
      readonly svg: string;
      /** Mermaid's name for the type ("flowchart-v2", "sequence"). */
      readonly type: string;
      /** The natural size, from the viewBox, in CSS pixels. */
      readonly width: number;
      readonly height: number;
      /** A flowchart's node count; null where "node" means nothing countable. */
      readonly nodes: number | null;
    }
  | { readonly ok: false; readonly message: string };
