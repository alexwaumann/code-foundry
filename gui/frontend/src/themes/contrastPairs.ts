/**
 * The readability floor of a theme (docs/THEMES.md): every pair of resolved slots that sits
 * one on the other somewhere in the app, and the WCAG contrast it must reach. contrast.test.ts
 * holds the curated themes and two base-only fixtures to it; a future theme import and the
 * Settings override editor check a file with the same list (contrastFailures). Pure: no DOM.
 *
 * A tint (`#rrggbbaa`) is checked as painted: flattened over `over` (a slot name) first.
 * 4.5 is text, 3 is large text, comments and non-text marks (fills, focus rings, chart
 * series), 7 is body text; 1.25 is the one separation rule (a selected sidebar row).
 */
import { contrast, flatten } from "./color";

export interface ContrastPair {
  /** The slot drawn on top (text, an icon, a fill, a ring). */
  readonly fg: string;
  /** The slot it sits on. */
  readonly bg: string;
  /** When bg is a tint: the opaque slot it is painted over. */
  readonly over?: string;
  readonly min: number;
  /** Where the pair occurs, for a failure message. */
  readonly why: string;
}

const TONES = ["success", "warning", "error", "info", "highlight", "update"] as const;
const TOKENS = ["--syn-fg", "--syn-kw", "--syn-fn", "--syn-type", "--syn-str", "--syn-num", "--sh-cmd", "--sh-flag", "--sh-str"] as const;

const on = (fg: string, bgs: readonly string[], min: number, why: string): ContrastPair[] => bgs.map((bg) => ({ fg, bg, min, why }));
const onTint = (fg: string, bg: string, overs: readonly string[], min: number, why: string): ContrastPair[] => overs.map((over) => ({ fg, bg, over, min, why }));

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...on("--cf-text", ["--cf-surface"], 7, "body text on a pane"),
  ...on("--cf-text-muted", ["--cf-surface", "--cf-canvas", "--cf-surface-sunken", "--cf-control-hover"], 4.5, "secondary text on a pane, the sheet, a well and a hovered row"),
  ...on("--cf-text-secondary", ["--cf-surface", "--cf-canvas"], 4.5, "blockquotes and dimmed rows"),
  ...on("--cf-placeholder", ["--cf-surface", "--cf-canvas"], 4.5, "an empty field's placeholder"),
  ...on("--cf-icon-muted", ["--cf-surface", "--cf-canvas"], 4.5, "a row's leading icon"),
  ...on("--cf-link", ["--cf-surface", "--cf-canvas"], 4.5, "links"),
  ...on("--cf-sidebar-foreground", ["--cf-sidebar", "--cf-sidebar-row-selected"], 4.5, "a sidebar row's title"),
  ...on("--cf-sidebar-muted-foreground", ["--cf-sidebar", "--cf-sidebar-row-selected", "--cf-sidebar-row-hover"], 4.5, "a sidebar row's second line"),
  ...on("--cf-sidebar-row-selected", ["--cf-sidebar"], 1.25, "the selected sidebar row stands out from the sidebar"),
  ...TONES.flatMap((t) => [
    ...on(`--cf-${t}-text`, ["--cf-surface", "--cf-canvas"], 4.5, `${t} text on a pane or the sheet`),
    ...onTint(`--cf-${t}-text`, `--cf-${t}-surface`, ["--cf-surface", "--cf-canvas"], 4.5, `${t} text on its own tint (chips, banners), on a pane or the sheet`),
    ...on(`--cf-${t}-foreground`, [`--cf-${t}`], 4.5, `text on a solid ${t} fill`),
    ...on(`--cf-${t}`, ["--cf-surface", "--cf-canvas"], 3, `a ${t} fill (dot, bar, badge) against a pane or the sheet`),
  ]),
  ...on("--cf-diff-addition", ["--cf-surface"], 4.5, "+N counts and added-file letters"),
  ...on("--cf-diff-deletion", ["--cf-surface"], 4.5, "−N counts and deleted-file letters"),
  ...on("--cf-diff-modified", ["--cf-surface"], 4.5, "modified-file letters"),
  ...on("--cf-accent-foreground", ["--cf-accent"], 4.5, "a primary button's label"),
  ...onTint("--cf-accent-surface-foreground", "--cf-accent-surface", ["--cf-surface"], 4.5, "text on an accent chip"),
  ...onTint("--cf-message-foreground", "--cf-message-surface", ["--cf-surface"], 4.5, "the user's bubble"),
  ...on("--cf-focus", ["--cf-surface", "--cf-canvas"], 3, "a focus ring"),
  ...onTint("--cf-code-foreground", "--cf-code-background", ["--cf-surface"], 4.5, "inline code and a code block's plain text"),
  ...TOKENS.flatMap((k) => [...on(k, ["--cf-surface"], 4.5, "syntax on a pane"), ...onTint(k, "--cf-code-background", ["--cf-surface"], 4.5, "syntax in a code block")]),
  ...on("--syn-com", ["--cf-surface"], 3, "code comments on a pane"),
  ...onTint("--syn-com", "--cf-code-background", ["--cf-surface"], 3, "code comments in a code block"),
  ...[1, 2, 3, 4, 5, 6].flatMap((i) => on(`--cf-chart-${String(i)}`, ["--cf-surface"], 3, "a chart series")),
  ...on("--terminal-fg", ["--terminal-selection"], 3, "selected terminal text"),
];

export interface ContrastFailure {
  readonly pair: ContrastPair;
  readonly ratio: number;
  /** `fg on bg (over X)`: the pair in words. */
  readonly label: string;
}

/** The pairs `slots` (a resolved slot map) falls short on; empty when it reads everywhere. */
export function contrastFailures(slots: Readonly<Record<string, string>>, pairs: readonly ContrastPair[] = CONTRAST_PAIRS): ContrastFailure[] {
  const get = (k: string) => {
    const v = slots[k];
    if (v === undefined) throw new Error(`no ${k}`);
    return v;
  };
  const out: ContrastFailure[] = [];
  for (const pair of pairs) {
    const bg = pair.over ? flatten(get(pair.bg), get(pair.over)) : get(pair.bg);
    const ratio = contrast(flatten(get(pair.fg), bg), bg);
    if (ratio < pair.min) out.push({ pair, ratio, label: `${pair.fg} on ${pair.bg}${pair.over ? ` over ${pair.over}` : ""}` });
  }
  return out;
}
