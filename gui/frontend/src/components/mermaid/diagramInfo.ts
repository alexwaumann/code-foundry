/**
 * What can be said about a Mermaid diagram without Mermaid (which is loaded only to draw):
 * its type from the keyword it opens with, for the File tab's meta line, and whether a
 * markdown fence is one. Pure and cheap: one pass over the first lines.
 */

/** A diagram's opening keyword (lower case, without a version suffix) to the name the meta line shows. */
const TYPES: Readonly<Record<string, string>> = {
  flowchart: "Flowchart",
  graph: "Flowchart",
  sequencediagram: "Sequence diagram",
  classdiagram: "Class diagram",
  statediagram: "State diagram",
  erdiagram: "ER diagram",
  journey: "User journey",
  gantt: "Gantt chart",
  pie: "Pie chart",
  quadrantchart: "Quadrant chart",
  requirementdiagram: "Requirement diagram",
  gitgraph: "Git graph",
  c4context: "C4 diagram",
  c4container: "C4 diagram",
  c4component: "C4 diagram",
  c4dynamic: "C4 diagram",
  c4deployment: "C4 diagram",
  mindmap: "Mindmap",
  timeline: "Timeline",
  zenuml: "ZenUML",
  sankey: "Sankey diagram",
  xychart: "XY chart",
  block: "Block diagram",
  packet: "Packet diagram",
  kanban: "Kanban",
  architecture: "Architecture diagram",
  radar: "Radar chart",
  treemap: "Treemap",
};

/**
 * The diagram's type as the meta line names it ("Flowchart"), from its first line that is
 * not front matter, a comment or a directive; null when that line is no keyword Mermaid
 * knows (Mermaid will say what is wrong when it draws).
 */
export function diagramTypeOf(source: string): string | null {
  const lines = source.split("\n", 400);
  let i = 0;
  // Front matter: a first line of --- up to the next ---.
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, j) => j > 0 && l.trim() === "---");
    if (end < 0) return null;
    i = end + 1;
  }
  for (; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "" || line.startsWith("%%")) continue;
    const word = /^[A-Za-z][\w-]*/.exec(line)?.[0].toLowerCase() ?? "";
    // stateDiagram-v2, classDiagram-v2, xychart-beta, sankey-beta: the base keyword.
    const base = word.replace(/-(?:v2|beta)$/, "");
    return TYPES[base] ?? null;
  }
  return null;
}

/** Row two of a Mermaid file: "Flowchart · 9 nodes · 312 B · Mermaid", the parts that are known. */
export function diagramMeta(type: string | null, nodes: number | null, size: string): string {
  const parts = [type, nodes === null ? null : `${String(nodes)} ${nodes === 1 ? "node" : "nodes"}`, size, "Mermaid"];
  return parts.filter((p): p is string => p !== null).join(" · ");
}

/** A fenced block's info string names Mermaid (```mermaid, as GitHub draws it). */
export function isMermaidFence(lang: string): boolean {
  return lang.trim().toLowerCase() === "mermaid";
}

/** Mermaid's own limit on a diagram's text (maxTextSize); past it Mermaid draws a notice in place of the diagram, so we say so ourselves. */
export const MAX_DIAGRAM_CHARS = 50_000;

/**
 * A parser's message in one line, for the note under a fence that was not drawn: its first
 * line, and when that only introduces the rest ("Parse error on line 3:"), its last line too
 * ("Expecting 'AMP', ..., got 'LINK'"); the whole message stays for the tooltip.
 */
export function messageSummary(message: string): string {
  const lines = message.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const first = lines[0] ?? "";
  const last = lines[lines.length - 1] ?? "";
  return first.endsWith(":") && lines.length > 1 ? `${first.slice(0, -1)}: ${last}` : first;
}
