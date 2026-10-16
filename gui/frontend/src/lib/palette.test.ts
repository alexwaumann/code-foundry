import { describe, expect, it } from "vitest";

/**
 * Colours come from the theme's tokens (index.css: success, warning, info, destructive,
 * highlight, link and the shadcn set), never from Tailwind's palette or a literal, so an
 * imported theme recolours everything (docs/notes/theme-2-palette.md). Every source file
 * is read as text and searched for:
 * - a palette class (`text-amber-600`, `dark:bg-sky-400/10`, `fill-emerald-400`, ...);
 * - an arbitrary colour in a class (`bg-[#fff]`, `text-[oklch(...)]`,
 *   `[--chip-accent:oklch(...)]`);
 * - a colour literal in TypeScript (`"#d97757"`, `oklch(0.55 0.13 ...)`, `rgb(...)`) or a
 *   white/black class (`bg-white/[0.035]`, `text-white`), except the deliberate ones in
 *   ALLOW;
 * - a colour literal in a component stylesheet (`#cf222e`, `oklch(1 0 0 / 5%)`, `white`),
 *   except the deliberate ones in CSS_ALLOW: those alias a token (`var(--terminal-ansi-1)`)
 *   or mix one (`color-mix(in oklab, var(--foreground) 5%, transparent)`).
 * index.css is the palette itself and is not scanned.
 */

const sources = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/gen/**", "!/src/lib/palette.test.ts"], { query: "?raw", import: "default", eager: true });
// Vitest hands stylesheets back empty unless they are "?raw" (vite.config.ts test.css).
const stylesheets = import.meta.glob<string>("/src/components/**/*.css", { query: "?raw", import: "default", eager: true });

const SHADES = "(?:50|[1-9]00|950)";
const HUES = "(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)";
const PROPS = "(?:text|bg|border(?:-[trblxyse])?|ring|ring-offset|fill|stroke|from|via|to|accent|caret|decoration|outline|shadow|divide|placeholder)";
const PALETTE_CLASS = new RegExp(`(?<![\\w-])${PROPS}-${HUES}-${SHADES}\\b`);
const COLOR_FN = "(?:#[0-9a-fA-F]{3,8}|(?:oklch|oklab|lch|lab|rgba?|hsla?)\\()";
const ARBITRARY_COLOR = new RegExp(`-\\[${COLOR_FN}|\\[--[\\w-]+:${COLOR_FN}`);
const COLOR_LITERAL = /["'`]#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})["'`]|\b(?:oklch|oklab|rgba?|hsla?)\(/;
const BW_CLASS = new RegExp(`(?<![\\w-])${PROPS}-(?:white|black)(?![\\w-])`);
const CSS_COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:oklch|oklab|lch|lab|rgba?|hsla?|hwb)\(|(?<![\w-])(?:white|black)(?![\w-])/;

/** Colours that are data, not theme: kept on purpose. `match` must appear in the line. */
const ALLOW: { file: string; match: string; why: string }[] = [
  { file: "/src/components/icons/ClaudeMark.tsx", match: 'CLAUDE_ORANGE = "#d97757"', why: "Anthropic's brand colour for the Claude mark" },
  { file: "/src/lib/usage.ts", match: "light: ", why: "Usage page: one fixed categorical colour per model family (DESIGN.md), light and dark" },
  { file: "/src/components/compose/ProjectRows.tsx", match: "oklch(0.55 0.13 ${String(hue)})", why: "a project's identity dot, its hue hashed from the name" },
  { file: "/src/components/compose/CompletionCard.tsx", match: "oklch(0.55 0.13 ${String(projectHue(name))})", why: "the same project identity dot" },
  { file: "/src/components/compose/AttachmentChip.tsx", match: 'DEFAULT_ACCENT = "oklch(', why: "an image chip's tint before its thumbnail is sampled" },
  { file: "/src/components/compose/AttachmentChip.tsx", match: "return `rgb(${", why: "an image chip's tint: the thumbnail's average colour" },
  { file: "/src/components/compose/ProjectRows.tsx", match: "tracking-wide text-white", why: "the initials on a project's identity tile (the hashed hue above), not a theme colour" },
  { file: "/src/components/ui/dialog.tsx", match: "bg-black/40", why: "the dialog scrim dims whatever is under it, black in every theme" },
  { file: "/src/components/compose/AttachmentPreview.tsx", match: 'overlayClassName="bg-black/80"', why: "the image lightbox scrim" },
  { file: "/src/components/thread/UserBubble.tsx", match: 'overlayClassName="bg-black/80"', why: "the image lightbox scrim" },
  { file: "/src/components/compose/Composer.tsx", match: "rounded-full bg-black/70 text-white", why: "the remove button sits on an image thumbnail, not on a theme surface" },
];

/** Literal colours kept in component stylesheets. `match` must appear in the line. */
const CSS_ALLOW: { file: string; match: string; why: string }[] = [
  { file: "/src/components/thread/thread.css", match: "box-shadow: 0 1px 3px oklch(0 0 0 /", why: "a shadow is black in every theme" },
  { file: "/src/components/thread/thread.css", match: "box-shadow: 0 1px 2px oklch(0 0 0 /", why: "a shadow is black in every theme" },
  { file: "/src/components/thread/thread.css", match: "85%, black);", why: "light status tones darken the theme's token a step so small text clears 4.5:1" },
  { file: "/src/components/backdrop/backdrop.css", match: "radial-gradient(55% 45% at 50% 50%, #000 0%, rgba(0, 0, 0, 0.6) 40%, transparent 100%)", why: "a mask: only its alpha is used" },
];

interface Hit {
  file: string;
  line: number;
  text: string;
}

function scan(re: RegExp, filter: (file: string) => boolean = () => true): Hit[] {
  const hits: Hit[] = [];
  for (const [file, src] of Object.entries(sources)) {
    if (!filter(file)) continue;
    src.split("\n").forEach((text, i) => {
      if (re.test(text)) hits.push({ file, line: i + 1, text: text.trim() });
    });
  }
  return hits;
}

/** The stylesheets with comments blanked (line breaks kept, so line numbers hold). */
const cssCode = Object.fromEntries(Object.entries(stylesheets).map(([file, src]) => [file, src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))]));

function scanCss(re: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const [file, src] of Object.entries(cssCode)) {
    src.split("\n").forEach((text, i) => {
      if (re.test(text)) hits.push({ file, line: i + 1, text: text.trim() });
    });
  }
  return hits;
}

const allowed = (h: Hit) => ALLOW.some((a) => a.file === h.file && h.text.includes(a.match));
const cssAllowed = (h: Hit) => CSS_ALLOW.some((a) => a.file === h.file && h.text.includes(a.match));
const show = (hits: Hit[]) => hits.map((h) => `${h.file}:${String(h.line)}: ${h.text}`);
const isTest = (file: string) => /\.test\.tsx?$/.test(file);

describe("palette guard", () => {
  it("reads the sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(sources["/src/components/sidebar/SidebarRow.tsx"]).toContain("text-warning");
    expect(Object.keys(stylesheets).length).toBeGreaterThan(3);
    expect(stylesheets["/src/components/thread/thread.css"]).toContain("--syn-kw: var(--terminal-ansi-1)");
  });

  it("no Tailwind palette classes: use the theme tokens (text-warning, bg-success/15, border-info/30, ...)", () => {
    expect(show(scan(PALETTE_CLASS))).toEqual([]);
  });

  it("no arbitrary colours in classes: use a token, or var(--token) inside the brackets", () => {
    expect(show(scan(ARBITRARY_COLOR))).toEqual([]);
  });

  it("no colour literals in TypeScript outside the allowlist", () => {
    expect(show(scan(COLOR_LITERAL, (f) => !isTest(f)).filter((h) => !allowed(h)))).toEqual([]);
  });

  it("no white/black classes outside the allowlist: use a token (text-destructive-foreground, bg-foreground/5, ...)", () => {
    expect(show(scan(BW_CLASS, (f) => !isTest(f)).filter((h) => !allowed(h)))).toEqual([]);
  });

  it("no colour literals in component stylesheets outside the allowlist: alias or color-mix a token", () => {
    expect(show(scanCss(CSS_COLOR).filter((h) => !cssAllowed(h)))).toEqual([]);
  });

  it("every allowlist entry still matches a line (drop stale ones)", () => {
    const hits = [...scan(COLOR_LITERAL, (f) => !isTest(f)), ...scan(BW_CLASS, (f) => !isTest(f))];
    const stale = ALLOW.filter((a) => !hits.some((h) => h.file === a.file && h.text.includes(a.match)));
    expect(stale.map((a) => `${a.file}: ${a.match}`)).toEqual([]);
    const cssHits = scanCss(CSS_COLOR);
    const cssStale = CSS_ALLOW.filter((a) => !cssHits.some((h) => h.file === a.file && h.text.includes(a.match)));
    expect(cssStale.map((a) => `${a.file}: ${a.match}`)).toEqual([]);
  });

  it("the patterns catch what they guard against", () => {
    for (const s of ["text-amber-600", "dark:bg-sky-400/10", "hover:border-emerald-500/30", "fill-red-500", "border-t-violet-300"]) expect(PALETTE_CLASS.test(s), s).toBe(true);
    for (const s of ["text-warning", "bg-success/15", "text-muted-foreground", "data-tone=amber", "max-w-24", "border-border"]) expect(PALETTE_CLASS.test(s), s).toBe(false);
    for (const s of ["bg-[#0a0a0a]", "text-[oklch(0.7_0.1_200)]", "[--chip-accent:oklch(0.6_0.1_230)]", "border-[rgb(0_0_0)]"]) expect(ARBITRARY_COLOR.test(s), s).toBe(true);
    for (const s of ["[--chip-accent:var(--info)]", "bg-[color-mix(in_oklab,var(--chip-accent)_11%,transparent)]", "bg-[Highlight]/30", "h-[1.41em]"]) expect(ARBITRARY_COLOR.test(s), s).toBe(false);
    for (const s of ['"#d97757"', "oklch(0.5 0 0)", "rgb(1 2 3)"]) expect(COLOR_LITERAL.test(s), s).toBe(true);
    for (const s of ['"PR #142 merged"', '"#142 by kim"', "&#123;", "color-mix(in oklab, red, blue)"]) expect(COLOR_LITERAL.test(s), s).toBe(false);
    for (const s of ["text-white", "dark:bg-white/[0.035]", "bg-black/40", "hover:border-black"]) expect(BW_CLASS.test(s), s).toBe(true);
    for (const s of ["whitespace-nowrap", "text-foreground", "bg-white-ish", "data-black"]) expect(BW_CLASS.test(s), s).toBe(false);
    for (const s of ["--syn-kw: #cf222e;", "background: oklch(1 0 0 / 5%);", "color: rgb(0 0 0);", "fill: white;", "color-mix(in oklab, var(--info) 85%, black)", "lab(50% 0 0)"]) expect(CSS_COLOR.test(s), s).toBe(true);
    for (const s of ["--syn-kw: var(--terminal-ansi-1);", "background: color-mix(in oklab, var(--foreground) 5%, transparent);", "white-space: nowrap;", ".cf-thread #root {", "--t-black-ish: var(--x);"]) expect(CSS_COLOR.test(s), s).toBe(false);
  });
});
