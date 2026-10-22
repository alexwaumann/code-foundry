import ts from "typescript";
import { COMPONENT_ALIASES } from "@/themes/slots";

/**
 * The design-system guard's scanner (docs/notes/design-system-1-tokens.md), used by
 * src/design/guards.test.ts, which allows no hit anywhere under src. It finds
 * Tailwind sizes, arbitrary line-heights and off-scale radii inside string and template
 * literals: text uses a type role (`text-body`, `text-caption`, ...) and radii the scale
 * (`rounded-sm/md/lg/pane`). Weights (`font-medium`, ...) are not scanned: with sizes
 * banned, a weight only ever modifies a role, which is allowed. Comments, JSX text and
 * regex literals are not class strings and are not read.
 */

export const CATEGORIES = ["size", "leading", "radius"] as const;
export type Category = (typeof CATEGORIES)[number];

/** What each category bans. Global: every occurrence counts. */
export const PATTERNS: Record<Category, readonly RegExp[]> = {
  // An arbitrary text-[…] is a size unless it is a colour (`text-[color-mix(…)]`); the
  // palette guard (lib/palette.test.ts) polices arbitrary colours.
  size: [/\btext-(?:xs|sm|base|lg|xl|2xl|3xl)\b/g, /\btext-\[(?!(?:color:|color-mix\(|oklch\(|oklab\(|rgba?\(|hsla?\(|#))[^\]]+\]/g],
  leading: [/\bleading-\[[^\]]+\]/g],
  radius: [/\brounded\b(?!-)/g, /\brounded-\[[^\]]+\]/g],
};

/** What to use instead, for the failure message. */
export const INSTEAD: Record<Category, string> = {
  size: "a type role (text-display, text-display-sm, text-title, text-heading, text-subheading, text-overline, text-body, text-body-sm, text-label, text-caption, text-caption-sm, text-link, text-code)",
  leading: "a type role (each sets its own line-height)",
  radius: "the scale: rounded-sm (4), rounded-md (6), rounded-lg (10), rounded-pane (12), rounded-2xl (16), rounded-full",
};

export interface Hit {
  category: Category;
  /** The pattern's source, e.g. `\brounded\b(?!-)`. */
  pattern: string;
  /** The matched text, e.g. `text-[13px]`. */
  match: string;
  /** 1-based. */
  line: number;
  /** The whole source line, trimmed. */
  text: string;
}

/** Repo-relative prefix of the frontend; scanned paths are relative to it. */
export const FRONTEND = "gui/frontend/";

/** Whether a path relative to gui/frontend (`src/components/ui/button.tsx`) is scanned. */
export function isScanned(path: string): boolean {
  return /^src\/.+\.tsx?$/.test(path) && !path.startsWith("src/gen/") && !/\.test\.tsx?$/.test(path) && !path.endsWith(".d.ts");
}

const STRING_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

/** Every banned class in `source`'s string and template literals, in source order. */
export function scanSource(fileName: string, source: string): Hit[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const lines = source.split("\n");
  const hits: Hit[] = [];
  const visit = (node: ts.Node): void => {
    if (STRING_KINDS.has(node.kind)) {
      const start = node.getStart(sf);
      const raw = source.slice(start, node.end);
      for (const category of CATEGORIES) {
        for (const re of PATTERNS[category]) {
          for (const m of raw.matchAll(re)) {
            const line = sf.getLineAndCharacterOfPosition(start + m.index).line;
            hits.push({ category, pattern: re.source, match: m[0], line: line + 1, text: (lines[line] ?? "").trim() });
          }
        }
      }
    }
    // A template's head/middle/tail spans are children of the template; their
    // substitutions are visited like any other expression.
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------- colour names

/**
 * The colour guard (docs/notes/theme-slots-2-components.md): outside components/ui
 * (vendored shadcn, which keeps its own names), code says what it means with the semantic
 * slots (`bg-cf-surface-raised`, `text-cf-text-muted`, `var(--cf-warning)`), never with a
 * shadcn component name (`bg-card`, `text-muted-foreground`, `bg-warning/10`,
 * `var(--border)`), so a theme override of a slot changes exactly what it names. Also
 * banned: Tailwind's `var(--color-*)`, which resolves on :root, so a preview scope would
 * paint in the window's colours. Raw colours are lib/palette.test.ts's job.
 */

/** The component names without their `--`, longest first so `card-foreground` wins over `card`. */
const COMPONENT_NAMES = Object.keys(COMPONENT_ALIASES)
  .map((n) => n.slice(2))
  .sort((a, b) => b.length - a.length);
const NAME_ALT = COMPONENT_NAMES.join("|");
/** Every Tailwind prefix that takes a colour. */
const COLOUR_PROPS = String.raw`(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|fill|stroke|from|via|to|accent|caret|decoration|outline|shadow|divide(?:-[xy])?|placeholder|inset-ring|inset-shadow)`;

export const COLOUR_PATTERNS = {
  /** `bg-card`, `hover:text-muted-foreground`, `bg-warning/10` (`text-link` is the type role). */
  utility: new RegExp(String.raw`(?<![\w-])(?!text-link(?![\w-]))${COLOUR_PROPS}-(?:${NAME_ALT})(?![\w-])`, "g"),
  /** `var(--card)`, `var(--info, …)`. */
  variable: new RegExp(String.raw`var\(\s*--(?:${NAME_ALT})\s*[,)]`, "g"),
  /** Tailwind's own `var(--color-foreground)`. */
  tailwind: /var\(\s*--color-[\w-]+/g,
  /** A whole literal that is a component name: a theme-map or computed-style key (`"--pane"`). */
  name: new RegExp(String.raw`^["'\x60]--(?:${NAME_ALT})["'\x60]$`, "g"),
} as const;

export type ColourKind = keyof typeof COLOUR_PATTERNS;

export interface ColourHit {
  kind: ColourKind;
  match: string;
  /** The slot to use instead, e.g. `bg-cf-surface-raised` or `var(--cf-text)`. */
  instead: string;
  /** 1-based. */
  line: number;
  text: string;
}

/** Whether a path relative to gui/frontend is held to the colour guard (components/ui keeps shadcn's names). */
export function isColourScanned(path: string): boolean {
  return !path.startsWith("src/components/ui/");
}

/** What a hit should say instead: the slot its component name aliases. */
function slotFor(kind: ColourKind, match: string): string {
  if (kind === "tailwind") return "var(--cf-<slot>), which resolves where it is used";
  const name = COMPONENT_NAMES.find((n) => new RegExp(String.raw`--?${n}(?![\w-])`).test(match));
  const slot = name ? COMPONENT_ALIASES[`--${name}`] : undefined;
  if (!name || !slot) return "a --cf-* slot";
  if (kind === "utility") return match.replace(new RegExp(String.raw`-${name}(?![\w-])`), `-${slot.slice(2)}`);
  if (kind === "variable") return `var(${slot})`;
  return `"${slot}"`;
}

function colourHits(raw: string, lineAt: (offset: number) => number, lines: readonly string[], kinds: readonly ColourKind[]): ColourHit[] {
  const hits: ColourHit[] = [];
  for (const kind of kinds) {
    for (const m of raw.matchAll(COLOUR_PATTERNS[kind])) {
      const line = lineAt(m.index);
      hits.push({ kind, match: m[0], instead: slotFor(kind, m[0]), line: line + 1, text: (lines[line] ?? "").trim() });
    }
  }
  return hits;
}

/** Every shadcn colour name in `source`'s string and template literals (an object key declares a name, so it is not read as a use). */
export function scanColours(fileName: string, source: string): ColourHit[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const lines = source.split("\n");
  const hits: ColourHit[] = [];
  const visit = (node: ts.Node): void => {
    if (STRING_KINDS.has(node.kind)) {
      const key = ts.isPropertyAssignment(node.parent) && node.parent.name === node;
      const start = node.getStart(sf);
      const raw = source.slice(start, node.end);
      const kinds: readonly ColourKind[] = key ? ["utility", "variable", "tailwind"] : ["utility", "variable", "tailwind", "name"];
      hits.push(...colourHits(raw, (o) => sf.getLineAndCharacterOfPosition(start + o).line, lines, kinds));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits.sort((a, b) => a.line - b.line);
}

/**
 * The same for a stylesheet: `var(--card)`, `var(--color-*)` and `@apply bg-card`. Comments
 * are not read; in index.css the two blocks that define the names (`@theme inline` and the
 * `:root, [data-theme-scope]` alias block) are skipped.
 */
export function scanStylesheet(fileName: string, css: string): ColourHit[] {
  let src = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  if (fileName.endsWith("src/index.css")) {
    for (const head of ["@theme inline {", ":root,\n[data-theme-scope] {"]) {
      const at = src.indexOf(head);
      if (at < 0) throw new Error(`${fileName}: no "${head}" block`);
      const end = src.indexOf("}", at);
      src = src.slice(0, at) + src.slice(at, end).replace(/[^\n]/g, " ") + src.slice(end);
    }
  }
  const lines = css.split("\n");
  const lineAt = (o: number) => src.slice(0, o).split("\n").length - 1;
  const hits = colourHits(src, lineAt, lines, ["variable", "tailwind"]);
  for (const m of src.matchAll(/@apply[^;]*;/g)) hits.push(...colourHits(m[0], (o) => lineAt(m.index + o), lines, ["utility"]));
  return hits.sort((a, b) => a.line - b.line);
}
