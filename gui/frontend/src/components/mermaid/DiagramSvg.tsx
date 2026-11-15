import { useId, useLayoutEffect, useRef, type CSSProperties } from "react";
import type { RenderedDiagram } from "./types";
import "./mermaid.css";

type Drawn = Extract<RenderedDiagram, { ok: true }>;

/**
 * A rendered diagram's sanitized SVG (render.ts, sanitizeSvg): fitted to the width it is
 * given, centred, never larger than its natural size, and no smaller than 60% of it
 * (past that it scrolls, so a wide diagram's labels stay readable). Each view gets ids of
 * its own: a cached render shown twice must not share marker ids with itself (an arrowhead
 * pointing into a hidden copy draws nothing).
 */
export function DiagramSvg({ diagram, testId }: { diagram: Drawn; testId?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const own = useId().replace(/[^A-Za-z0-9]/g, "");
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // The id is [a-z0-9] and the markup was sanitized before it was cached: renaming it
    // cannot make markup, so the string can go in as it is.
    el.innerHTML = diagram.svg.replaceAll(diagram.id, `${diagram.id}${own}`);
    const svg = el.firstElementChild;
    if (svg instanceof SVGSVGElement) {
      // Mermaid's own sizing (width 100%, an inline max-width) gives way to ours (mermaid.css).
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      svg.style.removeProperty("max-width");
      svg.setAttribute("role", svg.getAttribute("role") ?? "img");
    }
  }, [diagram, own]);
  return <div ref={box} className="cf-mermaid" style={{ "--cf-diagram-w": `${String(diagram.width)}px` } as CSSProperties} data-testid={testId} data-diagram-type={diagram.type} data-find-skip />;
}
