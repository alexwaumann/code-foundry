/**
 * Mermaid itself: loaded only by `import("./render")` (useMermaid), so the library (and
 * DOMPurify) stay out of the main bundle until a diagram is on screen. One render at a
 * time: Mermaid's configuration is global, and each render sets the theme it draws with.
 */
import mermaid, { type MermaidConfig } from "mermaid";
import { DIAGRAM_FONT, type DiagramTheme } from "./mermaidTheme";
import { sanitizeSvg } from "./sanitizeSvg";
import type { RenderedDiagram } from "./types";

/**
 * Keys a diagram's own text (`%%{init}%%`, front matter) may not change, on top of
 * Mermaid's own (securityLevel, maxTextSize, ...): its labels stay SVG text, not HTML, and
 * an error is ours to show, never Mermaid's bomb graphic.
 */
const SECURE: NonNullable<MermaidConfig["secure"]> = ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "suppressErrorRendering", "htmlLabels", "arrowMarkerAbsolute", "dompurifyConfig"];

/** The configuration every render starts from, in the app theme's colours. */
export function mermaidConfig(look: DiagramTheme): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    suppressErrorRendering: true,
    secure: SECURE,
    theme: "base",
    themeVariables: look.variables,
    themeCSS: look.css,
    darkMode: look.variables.darkMode === true,
    fontFamily: DIAGRAM_FONT,
    fontSize: 13,
    // Dagre's curved edges, as GitHub draws a fenced diagram; a diagram can still ask for ELK.
    layout: "dagre",
    // Tighter than Mermaid's defaults (50 / 50 / 8), so a diagram fits a side pane at its
    // natural size more often instead of shrinking its text.
    flowchart: { nodeSpacing: 28, rankSpacing: 40, diagramPadding: 4, padding: 12 },
    // Sequence diagrams measure their text with fonts of their own (Trebuchet by default):
    // the app's, or a label runs past its box.
    sequence: { actorFontFamily: DIAGRAM_FONT, noteFontFamily: DIAGRAM_FONT, messageFontFamily: DIAGRAM_FONT, actorFontSize: 13, noteFontSize: 13, messageFontSize: 13 },
    logLevel: "fatal",
  };
}

let queue: Promise<unknown> = Promise.resolve();
let n = 0;

/** Every element Mermaid made outside our container for a render: its temporary divs and any error graphic. */
function strays(id: string): Element[] {
  return [...document.querySelectorAll(`#${id}, #d${id}, #i${id}`)];
}

/** The diagram types whose `g.node` groups are the diagram's nodes (a cluster is `g.cluster`). */
const NODE_TYPES = new Set(["flowchart", "flowchart-v2", "flowchart-elk", "graph"]);

/** Renders `source` with the theme's variables; never throws (an error is a result), never leaves anything in the document. */
export function renderDiagram(source: string, look: DiagramTheme): Promise<RenderedDiagram> {
  const run = queue.then(() => draw(source, look));
  queue = run.catch(() => undefined);
  return run;
}

async function draw(source: string, look: DiagramTheme): Promise<RenderedDiagram> {
  n += 1;
  const id = `cfmmd${String(n)}${Math.random().toString(36).slice(2, 8)}`;
  // Mermaid measures text with getBBox, so it draws in the document: in a box of ours,
  // out of sight, removed whatever happens.
  const box = document.createElement("div");
  box.setAttribute("aria-hidden", "true");
  box.style.cssText = "position:fixed;left:-100000px;top:0;width:2000px;visibility:hidden;pointer-events:none;contain:layout style";
  document.body.append(box);
  try {
    mermaid.initialize(mermaidConfig(look));
    const out = await mermaid.render(id, source, box);
    const svg = sanitizeSvg(out.svg);
    const shape = shapeOf(svg);
    if (!shape) return { ok: false, message: "Mermaid drew nothing." };
    return { ok: true, id, svg, type: out.diagramType, width: shape.width, height: shape.height, nodes: NODE_TYPES.has(out.diagramType) ? shape.nodes : null };
  } catch (e) {
    return { ok: false, message: messageOf(e) };
  } finally {
    box.remove();
    for (const el of strays(id)) el.remove();
  }
}

/** The SVG's natural size (its viewBox) and its node groups, from the sanitized markup. */
function shapeOf(svg: string): { width: number; height: number; nodes: number } | null {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName !== "svg") return null;
  const vb = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  const width = vb[2] ?? 0;
  const height = vb[3] ?? 0;
  if (!(width > 0 && height > 0)) return null;
  return { width, height, nodes: root.querySelectorAll("g.node").length };
}

/** A parser's or renderer's error as the text to show: its message, without Mermaid's prefixes. */
export function messageOf(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : (e as { str?: unknown } | null)?.str;
  const text = typeof raw === "string" && raw.trim() ? raw.trim() : "Mermaid could not draw this diagram.";
  return text.replace(/^Error:\s*/, "");
}
