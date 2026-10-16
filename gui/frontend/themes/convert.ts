/**
 * Ghostty themes -> the app's colour variables. `pnpm run themes` regenerates
 * src/themes/catalog.json, src/themes/themes.css and the daemon's copy
 * internal/theme/catalog.json (ids, names, schemes, pairs and the defaults; all committed);
 * `pnpm run themes -- --refresh` first re-copies the vendored Ghostty files from
 * /Applications/Ghostty.app. src/themes/catalog.test.ts regenerates in memory and fails
 * on drift. docs/notes/theme-engine-2-engine.md explains every rule and guard.
 *
 * Inputs: themes/ghostty/<file> (vendored), themes/overrides.json (curated list, names,
 * accents, hue fixes), and src/index.css (the variable names, and Graphite's values from
 * `:root` / `.dark`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DARK, DEFAULT_LIGHT } from "../src/themes/defaults.ts";
import { chroma, contrast, ensureContrast, lightness, mix, over, parseCss, parseHex, shiftL, toHex } from "./color.ts";

export type Scheme = "light" | "dark";

export interface CatalogTheme {
  id: string;
  name: string;
  scheme: Scheme;
  pair?: string;
  source: string;
  vars: Record<string, string>;
}

type StatusKey = "destructive" | "success" | "warning" | "info" | "highlight";

/** One entry of overrides.json. */
export interface Override {
  name: string;
  /** Ghostty theme file name (themes/ghostty/<file>). */
  ghostty?: string;
  /** Graphite: values from index.css `.dark` or `:root` instead of a Ghostty file. */
  graphite?: Scheme;
  pair?: string;
  upstream: string;
  /** `--primary`; the foreground when absent. */
  accent?: string;
  /** Which ANSI slots the status colours start from. Default: bright (9-13) on dark, normal (1-5) on light. */
  slots?: "normal" | "bright";
  /** A status colour from another ANSI slot (0-15) or a literal hex. Still guarded. */
  status?: Partial<Record<StatusKey, number | string>>;
  /** Literal variable values, applied before the guards. */
  vars?: Record<string, string>;
  why: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const PATHS = {
  ghostty: path.join(here, "ghostty"),
  overrides: path.join(here, "overrides.json"),
  indexCss: path.join(here, "../src/index.css"),
  threadCss: path.join(here, "../src/components/thread/thread.css"),
  catalog: path.join(here, "../src/themes/catalog.json"),
  css: path.join(here, "../src/themes/themes.css"),
  goCatalog: path.join(here, "../../../internal/theme/catalog.json"),
};
const GHOSTTY_APP = "/Applications/Ghostty.app/Contents/Resources/ghostty/themes";

/** index.css variables that are not colours. */
const NOT_COLOURS = new Set(["--cf-zoom", "--radius", "--gap-shell"]);

/**
 * thread.css's syntax colours. thread.css declares them on `.cf-thread` as aliases of
 * terminal slots (`--syn-kw: var(--terminal-ansi-1)`, other slots under `.dark`); the
 * converter starts from the same aliases, and themes.css patches only the tokens a guard
 * or override changed, on `html[data-theme] .cf-thread` (which outranks `.dark .cf-thread`).
 */
/**
 * thread.css's dark block. The :not() keeps a light preview (a `.light` scope inside the
 * dark window, lib/theme.ts) on the light rules; :where() keeps it at (0,2,0).
 */
export const DARK_THREAD = ".dark .cf-thread:not(:where(.light *))";

export const SYNTAX_VARS = ["--syn-fg", "--syn-kw", "--syn-fn", "--syn-type", "--syn-str", "--syn-com", "--syn-num", "--sh-cmd", "--sh-flag", "--sh-str"] as const;

const STATUS: readonly [StatusKey, number][] = [
  ["destructive", 1],
  ["success", 2],
  ["warning", 3],
  ["info", 4],
  ["highlight", 5],
];

/** A variable that must exist by this point of the derivation. */
function get(v: Readonly<Record<string, string>>, k: string): string {
  const value = v[k];
  if (value === undefined) throw new Error(`no value for ${k}`);
  return value;
}

/** An ANSI slot (parseGhostty guarantees all 16). */
function at(p: readonly string[], n: number): string {
  const c = p[n];
  if (c === undefined) throw new Error(`no palette colour ${String(n)}`);
  return c;
}

// ---------------------------------------------------------------- index.css

type Block = Map<string, string>;

function cssBlock(css: string, selector: string): Block {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([\\s\\S]*?)^\\}`, "m");
  const m = re.exec(noComments);
  if (!m?.[1]) throw new Error(`index.css: no ${selector} block`);
  const out: Block = new Map();
  for (const [, name = "", value = ""] of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(name, value.trim());
  return out;
}

/** The colour variables index.css declares, in its order. */
export function indexVarNames(css: string): string[] {
  return [...cssBlock(css, ":root").keys()].filter((k) => !NOT_COLOURS.has(k));
}

/** Per scheme, each syntax variable and the terminal variable thread.css aliases it to. */
export type SyntaxAliases = Record<Scheme, Map<string, string>>;

export function syntaxAliases(threadCss: string): SyntaxAliases {
  const pick = (b: Block) => {
    const out = new Map<string, string>();
    for (const [k, val] of b) {
      if (!(SYNTAX_VARS as readonly string[]).includes(k)) continue;
      const ref = /^var\((--terminal-[\w-]+)\)$/.exec(val);
      if (!ref?.[1]) throw new Error(`thread.css: ${k} is not a terminal alias: ${val}`);
      out.set(k, ref[1]);
    }
    return out;
  };
  const light = pick(cssBlock(threadCss, ".cf-thread"));
  const dark = new Map([...light, ...pick(cssBlock(threadCss, DARK_THREAD))]);
  for (const k of SYNTAX_VARS) if (!light.has(k)) throw new Error(`thread.css: no ${k}`);
  return { light, dark };
}

/** The syntax colours as thread.css's aliases resolve them on this theme's terminal palette. */
function syntaxBase(v: Readonly<Record<string, string>>, scheme: Scheme, aliases: SyntaxAliases): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, term] of aliases[scheme]) out[k] = get(v, term);
  return out;
}

/** A Graphite block as hex: var() resolved, alpha colours painted over the pane. */
function graphiteBase(css: string, scheme: Scheme): Record<string, string> {
  const root = cssBlock(css, ":root");
  const block = scheme === "dark" ? new Map([...root, ...cssBlock(css, ".dark")]) : root;
  const raw = (name: string): string => {
    const v = block.get(name);
    if (v === undefined) throw new Error(`index.css: ${name} missing`);
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    return ref?.[1] ? raw(ref[1]) : v;
  };
  const pane = parseCss(raw("--pane")).hex;
  const out: Record<string, string> = {};
  for (const name of indexVarNames(css)) {
    const { hex, alpha } = parseCss(raw(name));
    out[name] = alpha < 1 ? over(hex, alpha, pane) : hex;
  }
  return out;
}

// ---------------------------------------------------------------- Ghostty

export interface Ghostty {
  background: string;
  foreground: string;
  palette: string[];
  cursor?: string;
  cursorText?: string;
  selection?: string;
}

export function parseGhostty(text: string): Ghostty {
  const kv = new Map<string, string>();
  const palette: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*([a-z-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    const key = m[1];
    const value = m[2].toLowerCase();
    if (key === "palette") {
      const [n = "", c = ""] = value.split("=");
      palette[Number(n)] = toHex(parseHex(c).rgb);
    } else kv.set(key, value);
  }
  const hex = (k: string) => {
    const v = kv.get(k);
    return v ? toHex(parseHex(v).rgb) : undefined;
  };
  const background = hex("background");
  const foreground = hex("foreground");
  if (!background || !foreground) throw new Error("ghostty theme without background/foreground");
  if (palette.length !== 16 || palette.some((c) => !c)) throw new Error("ghostty theme without 16 palette colours");
  return { background, foreground, palette, cursor: hex("cursor-color"), cursorText: hex("cursor-text"), selection: hex("selection-background") };
}

// ---------------------------------------------------------------- derivation + guards

/** Dark when the background's OKLab lightness is under 0.6. */
export const schemeOf = (background: string): Scheme => (lightness(background) < 0.6 ? "dark" : "light");

/** Text for a solid fill: the darker of the two if it reaches 4.5:1, else the lighter, else the better. */
function textOn(fill: string, a: string, b: string): string {
  const [dark, light] = lightness(a) <= lightness(b) ? [a, b] : [b, a];
  if (contrast(dark, fill) >= 4.5) return dark;
  if (contrast(light, fill) >= 4.5) return light;
  return contrast(dark, fill) >= contrast(light, fill) ? dark : light;
}

/** Status/syntax text steps away from the pane: lighter on dark, darker on light. */
const away = (scheme: Scheme) => (scheme === "dark" ? 0.005 : -0.005);

function derive(g: Ghostty, o: Override, names: readonly string[], aliases: SyntaxAliases): Record<string, string> {
  const scheme = schemeOf(g.background);
  const dark = scheme === "dark";
  const p = g.palette;
  const pane = g.background;
  // Guard: body text at least 7:1 (Solarized is 4.1-4.8 by design, Rosé Pine Dawn 6.7).
  const fg = ensureContrast(g.foreground, [pane], 7, away(scheme));
  const sheet = shiftL(pane, dark ? -0.05 : -0.045);
  const popover = shiftL(pane, dark ? 0.03 : 0.02);
  // Hover/muted surface: about Catppuccin surface0 on dark, a lighter step on light.
  const surface = mix(pane, fg, dark ? 0.14 : 0.07);
  const v: Record<string, string> = {};

  v["--sheet"] = sheet;
  v["--pane"] = pane;
  v["--pane-border"] = over(fg, dark ? 0.11 : 0.08, pane);
  v["--background"] = sheet;
  v["--foreground"] = fg;
  v["--card"] = pane;
  v["--card-foreground"] = fg;
  v["--popover"] = popover;
  v["--popover-foreground"] = fg;
  v["--secondary"] = surface;
  v["--secondary-foreground"] = fg;
  v["--muted"] = surface;
  v["--muted-foreground"] = mix(fg, pane, 0.32);
  v["--accent"] = surface;
  v["--accent-foreground"] = fg;

  const bright = o.slots ? o.slots === "bright" : dark;
  for (const [key, n] of STATUS) {
    const ov = o.status?.[key];
    let c: string;
    if (typeof ov === "number") c = at(p, ov);
    else if (typeof ov === "string") c = toHex(parseHex(ov).rgb);
    // Guard: a bright slot that is not a brighter hue (Solarized's greys) falls back to the normal one.
    else if (bright && chroma(at(p, n + 8)) >= 0.5 * chroma(at(p, n))) c = at(p, n + 8);
    else c = at(p, n);
    v[`--${key}`] = c;
  }
  v["--border"] = over(fg, dark ? 0.11 : 0.1, pane);
  v["--input"] = over(fg, dark ? 0.15 : 0.13, pane);
  v["--primary"] = o.accent ? toHex(parseHex(o.accent).rgb) : fg;
  [0.1, 0.35, 0.5, 0.65, 0.8].forEach((t, i) => (v[`--chart-${String(i + 1)}`] = mix(fg, pane, t)));
  v["--sidebar"] = sheet;
  v["--sidebar-foreground"] = fg;
  v["--sidebar-accent"] = mix(sheet, fg, 0.1);
  v["--sidebar-accent-foreground"] = fg;
  v["--sidebar-border"] = sheet;

  const tfg = g.foreground;
  const cursor = g.cursor ?? tfg;
  v["--terminal-fg"] = tfg;
  v["--terminal-cursor"] = cursor;
  // Some themes' cursor-text is unreadable on their cursor (GitHub Dark, Monokai Pro).
  v["--terminal-cursor-accent"] = g.cursorText && contrast(g.cursorText, cursor) >= 3 ? g.cursorText : textOn(cursor, pane, tfg);
  v["--terminal-selection"] = g.selection ?? mix(pane, tfg, 0.2);
  p.forEach((c, i) => (v[`--terminal-ansi-${String(i)}`] = c));

  Object.assign(v, syntaxBase(v, scheme, aliases), o.vars);
  guard(v, scheme);
  // Derived from guarded values.
  v["--link"] = get(v, "--info");
  v["--ring"] = mix(get(v, "--primary"), pane, 0.35);
  v["--sidebar-ring"] = v["--ring"];
  v["--sidebar-primary"] = get(v, "--primary");
  v["--sidebar-primary-foreground"] = get(v, "--primary-foreground");
  for (const [key] of STATUS) v[`--${key}-foreground`] = textOn(get(v, `--${key}`), pane, fg);
  v["--terminal-selection-inactive"] = mix(get(v, "--terminal-selection"), pane, 0.5);

  return ordered(v, names);
}

/**
 * The automatic guards, shared by Ghostty themes and Graphite. Mutates `v`.
 * docs/notes/theme-engine-2-engine.md has the table.
 */
function guard(v: Record<string, string>, scheme: Scheme): void {
  const pane = get(v, "--pane");
  const sheet = get(v, "--sheet");
  const fg = get(v, "--foreground");
  const step = away(scheme);
  // Status text at least 4.5:1 on the pane and the sheet (sidebar rows), lightness only.
  const oldInfo = v["--info"];
  for (const [key] of STATUS) v[`--${key}`] = ensureContrast(get(v, `--${key}`), [pane, sheet], 4.5, step);
  if (v["--link"] === oldInfo) v["--link"] = get(v, "--info");
  // Muted text at least 4.5:1 on the pane and the sheet: mix toward the foreground.
  let muted = get(v, "--muted-foreground");
  for (let t = 0.05; t <= 1 && (contrast(muted, pane) < 4.5 || contrast(muted, sheet) < 4.5); t += 0.05) muted = mix(get(v, "--muted-foreground"), fg, t);
  v["--muted-foreground"] = muted;
  // Primary text at least 4.5:1 on the primary: pick dark or light text, then nudge the accent.
  let primary = get(v, "--primary");
  const pfg = v["--primary-foreground"] ?? textOn(primary, pane, fg);
  if (contrast(pfg, primary) < 4.5) {
    const text = textOn(primary, pane, fg);
    primary = ensureContrast(primary, [text], 4.5, lightness(text) < lightness(primary) ? 0.005 : -0.005);
    v["--primary"] = primary;
    v["--primary-foreground"] = text;
  } else v["--primary-foreground"] = pfg;
  // A selection that is the foreground (inverted themes) would hide the text under it:
  // xterm keeps the cell's colour. Use the foreground at 25% instead.
  const tfg = get(v, "--terminal-fg");
  if (contrast(tfg, get(v, "--terminal-selection")) < 3) v["--terminal-selection"] = mix(pane, tfg, 0.25);
  // Code: every token at 4.5:1 on the pane and on code blocks (--muted), except comments.
  for (const k of SYNTAX_VARS) if (k !== "--syn-com" && v[k]) v[k] = ensureContrast(v[k], [pane, get(v, "--muted")], 4.5, step);
  // Comments (ANSI 8) under 3:1, or as strong as body text, become muted-foreground.
  const com = v["--syn-com"];
  if (com) {
    const cc = contrast(com, pane);
    if (cc < 3 || cc > 0.85 * contrast(fg, pane)) v["--syn-com"] = muted;
  }
}

function ordered(v: Record<string, string>, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [...names, ...SYNTAX_VARS]) {
    const val = v[k];
    if (val === undefined) throw new Error(`no value for ${k}`);
    out[k] = val;
  }
  return out;
}

// ---------------------------------------------------------------- build

export interface Inputs {
  overrides: Record<string, Override>;
  indexCss: string;
  threadCss: string;
  ghostty: (file: string) => string;
}

export function readInputs(): Inputs {
  return {
    overrides: JSON.parse(fs.readFileSync(PATHS.overrides, "utf8")) as Record<string, Override>,
    indexCss: fs.readFileSync(PATHS.indexCss, "utf8"),
    threadCss: fs.readFileSync(PATHS.threadCss, "utf8"),
    ghostty: (file) => fs.readFileSync(path.join(PATHS.ghostty, file), "utf8"),
  };
}

export function buildCatalog(inputs: Inputs): CatalogTheme[] {
  const names = indexVarNames(inputs.indexCss);
  const aliases = syntaxAliases(inputs.threadCss);
  const out: CatalogTheme[] = [];
  for (const [id, o] of Object.entries(inputs.overrides)) {
    let vars: Record<string, string>;
    let scheme: Scheme;
    let source: string;
    if (o.graphite) {
      scheme = o.graphite;
      const graphite = graphiteBase(inputs.indexCss, scheme);
      const base = { ...graphite, ...syntaxBase(graphite, scheme, aliases), ...o.vars };
      guard(base, scheme);
      vars = ordered(base, names);
      source = o.upstream;
    } else if (o.ghostty) {
      const g = parseGhostty(inputs.ghostty(o.ghostty));
      scheme = schemeOf(g.background);
      vars = derive(g, o, names, aliases);
      source = `${o.upstream}; Ghostty theme "${o.ghostty}" (iTerm2-Color-Schemes, MIT)`;
    } else throw new Error(`${id}: neither ghostty nor graphite`);
    out.push({ id, name: o.name, scheme, ...(o.pair ? { pair: o.pair } : {}), source, vars });
  }
  // Dark first, then light; overrides.json order within each (the default, GitHub, first).
  return [...out.filter((t) => t.scheme === "dark"), ...out.filter((t) => t.scheme === "light")];
}

export function catalogJson(catalog: CatalogTheme[]): string {
  return JSON.stringify(catalog, null, 2) + "\n";
}

/**
 * The daemon's copy (internal/theme, go:embed): what it needs to validate and list the
 * appearance.theme_dark / theme_light settings. No colours: the daemon never paints.
 */
export function goCatalogJson(catalog: CatalogTheme[]): string {
  const themes = catalog.map((t) => ({ id: t.id, name: t.name, scheme: t.scheme, ...(t.pair ? { pair: t.pair } : {}) }));
  return JSON.stringify({ defaults: { dark: DEFAULT_DARK, light: DEFAULT_LIGHT }, themes }, null, 2) + "\n";
}

/**
 * The attribute that makes any element a theme scope: `<div data-theme-scope
 * data-theme="dracula">` paints its subtree in Dracula whatever <html> shows (the Themes
 * page's gallery previews a theme this way, components/themes/ThemeScope.tsx).
 */
export const THEME_SCOPE_ATTR = "data-theme-scope";

export function themesCss(catalog: CatalogTheme[], aliases: SyntaxAliases): string {
  const syntax = new Set<string>(SYNTAX_VARS);
  const lines = [
    "/* Generated by themes/convert.ts (`pnpm run themes`) from themes/ghostty and",
    " * themes/overrides.json. Do not edit; src/themes/catalog.test.ts fails on drift.",
    " * lib/theme.ts sets data-theme on <html>; these outrank index.css's :root/.dark.",
    ` * An element with ${THEME_SCOPE_ATTR} and a data-theme is a nested scope (a preview):`,
    " * (0,2,0) outranks .dark on the element itself, and its .cf-thread block carries every",
    " * syntax colour at (0,3,0), so the window theme's html[data-theme] .cf-thread patch",
    " * (0,2,1) never leaks into it. */",
  ];
  for (const t of catalog) {
    const sel = `html[data-theme="${t.id}"]`;
    const scope = `[${THEME_SCOPE_ATTR}][data-theme="${t.id}"]`;
    const decl = (pred: (k: string) => boolean) =>
      Object.entries(t.vars)
        .filter(([k]) => pred(k))
        .map(([k, val]) => `  ${k}: ${val};`);
    lines.push("", `/* ${t.name} (${t.scheme}) */`, `${sel},`, `${scope} {`, `  color-scheme: ${t.scheme};`, ...decl((k) => !syntax.has(k)), "}");
    // Syntax: only what differs from thread.css's alias of the terminal palette.
    const patch = decl((k) => syntax.has(k) && t.vars[k] !== t.vars[aliases[t.scheme].get(k) ?? ""]);
    if (patch.length) lines.push(`${sel} .cf-thread {`, ...patch, "}");
    lines.push(`${scope} .cf-thread {`, ...decl((k) => syntax.has(k)), "}");
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- CLI

function main(): void {
  const inputs = readInputs();
  if (process.argv.includes("--refresh")) {
    for (const o of Object.values(inputs.overrides)) {
      if (!o.ghostty) continue;
      fs.copyFileSync(path.join(GHOSTTY_APP, o.ghostty), path.join(PATHS.ghostty, o.ghostty));
    }
  }
  const catalog = buildCatalog(inputs);
  fs.writeFileSync(PATHS.catalog, catalogJson(catalog));
  fs.writeFileSync(PATHS.css, themesCss(catalog, syntaxAliases(inputs.threadCss)));
  fs.writeFileSync(PATHS.goCatalog, goCatalogJson(catalog));
  const r = (a: string | undefined, b: string | undefined) => (a && b ? Number(contrast(a, b).toFixed(1)) : NaN);
  console.table(
    catalog.map((t) => {
      const v = t.vars;
      return {
        id: t.id,
        fg: r(v["--foreground"], v["--pane"]),
        muted: r(v["--muted-foreground"], v["--sheet"]),
        red: r(v["--destructive"], v["--pane"]),
        green: r(v["--success"], v["--pane"]),
        amber: r(v["--warning"], v["--pane"]),
        info: r(v["--info"], v["--pane"]),
        primary: r(v["--primary-foreground"], v["--primary"]),
        dL: Number(((lightness(get(v, "--pane")) - lightness(get(v, "--sheet"))) * 100).toFixed(1)),
      };
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
