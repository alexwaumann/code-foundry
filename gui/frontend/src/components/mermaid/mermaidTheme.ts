/**
 * The bridge from the app's themes to Mermaid (docs/notes/file-previews-4-mermaid.md), as
 * lib/codeTheme.ts is to the code view's highlighter. Mermaid's "base" theme derives the
 * colours it is not given from a few it is (khroma); every colour a diagram draws with most
 * is given here from the theme's resolved slots, so a node reads as the app's raised
 * controls, an edge as its muted text, in every theme (dark, light, a user's). Pure: the
 * catalog's values, no DOM.
 */
import type { Theme } from "@/themes";

/** The app's body font (index.css `body`); Mermaid measures labels with it, so it must be one the page has. */
export const DIAGRAM_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';

/** Labels' size: the app's body text. */
export const DIAGRAM_FONT_SIZE = "13px";

/** A slot as an opaque `#rrggbb` (a tint's alpha dropped: Mermaid mixes colours itself and a translucent fill would show the edges under it). */
function slot(theme: Theme, name: string, fallback: string): string {
  const v = theme.slots[name] ?? theme.slots[fallback];
  if (!v || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(v)) throw new Error(`theme ${theme.id} has no ${name}`);
  return v.slice(0, 7);
}

/** The palette a chart's series take (pie slices, git branches, a mindmap's levels), the theme's chart slots in turn. */
function chartColors(theme: Theme): string[] {
  return [1, 2, 3, 4, 5, 6].map((n) => slot(theme, `--cf-chart-${String(n)}`, "--cf-accent"));
}

/**
 * Mermaid's theme variables for an app theme. The names are Mermaid's (docs: theming); what
 * each takes, the sketch's: a node on the sunken surface with a strong border, the text
 * colour on it, edges and their arrowheads in muted text, an edge's label on the pane's
 * surface so the line breaks around it.
 */
export function mermaidThemeVariables(theme: Theme): Record<string, string | boolean> {
  const surface = slot(theme, "--cf-surface", "--cf-canvas");
  const node = slot(theme, "--cf-surface-sunken", "--cf-surface");
  const raised = slot(theme, "--cf-control", "--cf-surface-sunken");
  const text = slot(theme, "--cf-text", "--cf-text");
  const muted = slot(theme, "--cf-text-muted", "--cf-text");
  const border = slot(theme, "--cf-border-strong", "--cf-border");
  const faint = slot(theme, "--cf-border", "--cf-border-strong");
  const accent = slot(theme, "--cf-accent", "--cf-info");
  const error = slot(theme, "--cf-error", "--cf-error");
  const charts = chartColors(theme);
  // The series colours: a mindmap's or timeline's levels, pie slices, git branches.
  const series: Record<string, string> = {};
  for (let i = 0; i < 12; i++) {
    const c = charts[i % charts.length] ?? accent;
    series[`cScale${String(i)}`] = c;
    series[`cScaleLabel${String(i)}`] = surface;
    series[`pie${String(i + 1)}`] = c;
    series[`git${String(i)}`] = c;
  }
  return {
    darkMode: theme.scheme === "dark",
    background: surface,
    fontFamily: DIAGRAM_FONT,
    fontSize: DIAGRAM_FONT_SIZE,
    // The three colours "base" derives the rest from.
    primaryColor: node,
    primaryTextColor: text,
    primaryBorderColor: border,
    secondaryColor: raised,
    secondaryTextColor: text,
    secondaryBorderColor: border,
    tertiaryColor: surface,
    tertiaryTextColor: text,
    tertiaryBorderColor: faint,
    // Flowcharts, state and class diagrams.
    mainBkg: node,
    nodeBorder: border,
    nodeTextColor: text,
    textColor: text,
    titleColor: text,
    lineColor: muted,
    arrowheadColor: muted,
    edgeLabelBackground: surface,
    clusterBkg: surface,
    clusterBorder: faint,
    // Notes (sequence, state).
    noteBkgColor: raised,
    noteTextColor: text,
    noteBorderColor: border,
    // Sequence diagrams.
    actorBkg: node,
    actorBorder: border,
    actorTextColor: text,
    actorLineColor: faint,
    signalColor: muted,
    signalTextColor: text,
    labelBoxBkgColor: node,
    labelBoxBorderColor: border,
    labelTextColor: text,
    loopTextColor: text,
    activationBkgColor: raised,
    activationBorderColor: border,
    sequenceNumberColor: surface,
    // ER and class diagrams' alternating rows.
    attributeBackgroundColorOdd: surface,
    attributeBackgroundColorEven: node,
    // Gantt.
    sectionBkgColor: node,
    altSectionBkgColor: surface,
    sectionBkgColor2: raised,
    taskBkgColor: raised,
    taskBorderColor: border,
    taskTextColor: text,
    taskTextLightColor: text,
    taskTextOutsideColor: text,
    activeTaskBkgColor: accent,
    activeTaskBorderColor: accent,
    doneTaskBkgColor: node,
    doneTaskBorderColor: faint,
    critBkgColor: error,
    critBorderColor: error,
    gridColor: faint,
    todayLineColor: accent,
    // Pie charts.
    pieStrokeColor: surface,
    pieOuterStrokeColor: faint,
    pieTitleTextColor: text,
    pieSectionTextColor: surface,
    pieLegendTextColor: text,
    // Errors Mermaid draws itself (it is told not to, but a diagram type may still).
    errorBkgColor: node,
    errorTextColor: error,
    ...series,
  };
}

/**
 * Styles laid over the theme, as the sketch draws a diagram: thinner edges, softly rounded
 * boxes, an edge's label smaller and muted on an opaque patch of the surface (Mermaid's is
 * half transparent, so the edge shows through the text). Mermaid scopes them to the
 * diagram's own id, so they reach no other diagram on the page.
 */
export function diagramCss(theme: Theme): string {
  const muted = slot(theme, "--cf-text-muted", "--cf-text");
  return [
    ".flowchart-link{stroke-width:1.25px}",
    ".node rect.basic{rx:6px;ry:6px}",
    ".edgeLabel rect{opacity:1}",
    `.edgeLabel text{fill:${muted};font-size:11px}`,
  ].join("");
}

/** Everything a render takes from the app theme. */
export interface DiagramTheme {
  readonly variables: Record<string, string | boolean>;
  readonly css: string;
}

export function diagramThemeOf(theme: Theme): DiagramTheme {
  return { variables: mermaidThemeVariables(theme), css: diagramCss(theme) };
}
