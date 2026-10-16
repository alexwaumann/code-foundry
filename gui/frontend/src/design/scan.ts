import ts from "typescript";

/**
 * The design-system guard's scanner (docs/notes/design-system-1-tokens.md), shared by
 * src/design/guards.test.ts and `pnpm run guards:allow` (scripts/guards-allow.ts). It finds
 * Tailwind sizes, arbitrary line-heights and off-scale radii inside string and template
 * literals: text uses a type role (`text-body`, `text-caption`, ...) and radii the scale
 * (`rounded-sm/md/lg/pane`). Weights (`font-medium`, ...) are not scanned: with sizes
 * banned, a weight only ever modifies a role, which is allowed. Comments, JSX text and
 * regex literals are not class strings and are not read.
 */

export const CATEGORIES = ["size", "leading", "radius"] as const;
export type Category = (typeof CATEGORIES)[number];
export type Counts = Record<Category, number>;
/** Per file (repo-relative path), the hits each category may still have. */
export type Allowlist = Record<string, Counts>;

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
  size: "a type role (text-title, text-heading, text-subheading, text-overline, text-body, text-body-sm, text-label, text-caption, text-caption-sm, text-link, text-code)",
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

export function zero(): Counts {
  return { size: 0, leading: 0, radius: 0 };
}

export function count(hits: readonly Hit[]): Counts {
  const c = zero();
  for (const h of hits) c[h.category] += 1;
  return c;
}

/**
 * The allowlist for a tree: `files` maps paths relative to gui/frontend to their source;
 * only scanned files with a hit are listed, keyed repo-relative, sorted.
 */
export function buildAllowlist(files: Readonly<Record<string, string>>): Allowlist {
  const out: Allowlist = {};
  for (const path of Object.keys(files).filter(isScanned).sort()) {
    const c = count(scanSource(path, files[path] ?? ""));
    if (CATEGORIES.some((k) => c[k] > 0)) out[FRONTEND + path] = c;
  }
  return out;
}

/** guards.allow.json's text: one file per line, so a diff shows which files moved. */
export function serialize(allow: Allowlist): string {
  const rows = Object.keys(allow)
    .sort()
    .map((file) => {
      const c = allow[file] ?? zero();
      return `  ${JSON.stringify(file)}: { "size": ${String(c.size)}, "leading": ${String(c.leading)}, "radius": ${String(c.radius)} }`;
    });
  return `{\n${rows.join(",\n")}\n}\n`;
}
