/**
 * Ghostty themes -> theme files (docs/notes/theme-slots-1-engine.md). `pnpm run themes`
 * regenerates src/themes/catalog.json (every curated theme as a theme file: base +
 * overrides) and the daemon's copy internal/theme/catalog.json (ids, names, schemes, pairs
 * and the defaults); both committed. `pnpm run themes -- --refresh` first re-copies the
 * vendored Ghostty files from /Applications/Ghostty.app. themes/convert.test.ts regenerates
 * in memory and fails on drift.
 *
 * The converter only fills the base tier. Every other colour is derived at load time by
 * the rules in src/themes/slots.ts, so a theme here and a theme the model writes are the
 * same kind of file. Inputs: themes/ghostty/<file> (vendored) and themes/overrides.json
 * (the curated list: names, accents, status picks, slot overrides, literal bases).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DARK, DEFAULT_LIGHT } from "../src/themes/defaults.ts";
import { chroma, contrast, lightness, parseHex, shiftL, toHex } from "../src/themes/color.ts";
import { parseThemeFile, resolveSlots, type ThemeBase, type ThemeFile, type ThemeScheme } from "../src/themes/slots.ts";

export type Scheme = ThemeScheme;

type StatusKey = "error" | "success" | "warning" | "info" | "highlight";

/** One entry of overrides.json. */
export interface Override {
  name: string;
  /** Ghostty theme file name (themes/ghostty/<file>). */
  ghostty?: string;
  /** A theme with no Ghostty file (Graphite): its scheme and base, literally. */
  scheme?: Scheme;
  base?: ThemeBase;
  pair?: string;
  upstream: string;
  /** base.accent; the foreground when absent. */
  accent?: string;
  /** Which ANSI slots the status colours start from. Default: bright (9-13) on dark, normal (1-5) on light. */
  slots?: "normal" | "bright";
  /** A status colour from another ANSI slot (0-15) or a literal hex. Still guarded by the rules. */
  status?: Partial<Record<StatusKey, number | string>>;
  /** Final slot values (no guard), where a rule's result is not what the theme wants. */
  overrides?: Record<string, string>;
  why: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const PATHS = {
  ghostty: path.join(here, "ghostty"),
  overrides: path.join(here, "overrides.json"),
  catalog: path.join(here, "../src/themes/catalog.json"),
  goCatalog: path.join(here, "../../../internal/theme/catalog.json"),
};
const GHOSTTY_APP = "/Applications/Ghostty.app/Contents/Resources/ghostty/themes";

const STATUS: readonly [StatusKey, number][] = [
  ["error", 1],
  ["success", 2],
  ["warning", 3],
  ["info", 4],
  ["highlight", 5],
];

/** An ANSI slot (parseGhostty guarantees all 16). */
function at(p: readonly string[], n: number): string {
  const c = p[n];
  if (c === undefined) throw new Error(`no palette colour ${String(n)}`);
  return c;
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

/** Dark when the background's OKLab lightness is under 0.6. */
export const schemeOf = (background: string): Scheme => (lightness(background) < 0.6 ? "dark" : "light");

/**
 * A Ghostty theme's base tier. The canvas is the background a step darker (OKLCH L −0.05
 * dark, −0.045 light); the statuses are ANSI 9-13 on dark and 1-5 on light unless the
 * override picks other slots, and a bright slot with under half the normal one's chroma
 * (Solarized's greys) falls back to the normal one. Text, statuses and the selection go in
 * as the file has them: the rules guard them.
 */
export function ghosttyBase(g: Ghostty, o: Override): { scheme: Scheme; base: ThemeBase } {
  const scheme = schemeOf(g.background);
  const dark = scheme === "dark";
  const p = g.palette;
  const bright = o.slots ? o.slots === "bright" : dark;
  const status = {} as Record<StatusKey, string>;
  for (const [key, n] of STATUS) {
    const ov = o.status?.[key];
    if (typeof ov === "number") status[key] = at(p, ov);
    else if (typeof ov === "string") status[key] = toHex(parseHex(ov).rgb);
    else if (bright && chroma(at(p, n + 8)) >= 0.5 * chroma(at(p, n))) status[key] = at(p, n + 8);
    else status[key] = at(p, n);
  }
  return {
    scheme,
    base: {
      canvas: shiftL(g.background, dark ? -0.05 : -0.045),
      surface: g.background,
      text: g.foreground,
      accent: o.accent ? toHex(parseHex(o.accent).rgb) : g.foreground,
      ...status,
      terminal: {
        foreground: g.foreground,
        ...(g.cursor ? { cursor: g.cursor } : {}),
        ...(g.cursorText ? { cursorText: g.cursorText } : {}),
        ...(g.selection ? { selection: g.selection } : {}),
        ansi: g.palette,
      },
    },
  };
}

// ---------------------------------------------------------------- build

export interface Inputs {
  overrides: Record<string, Override>;
  ghostty: (file: string) => string;
}

export function readInputs(): Inputs {
  return {
    overrides: JSON.parse(fs.readFileSync(PATHS.overrides, "utf8")) as Record<string, Override>,
    ghostty: (file) => fs.readFileSync(path.join(PATHS.ghostty, file), "utf8"),
  };
}

export function buildCatalog(inputs: Inputs): ThemeFile[] {
  const out: ThemeFile[] = [];
  for (const [id, o] of Object.entries(inputs.overrides)) {
    let scheme: Scheme;
    let base: ThemeBase;
    let source: string;
    if (o.base && o.scheme) {
      ({ scheme, base } = o);
      source = o.upstream;
    } else if (o.ghostty) {
      ({ scheme, base } = ghosttyBase(parseGhostty(inputs.ghostty(o.ghostty)), o));
      source = `${o.upstream}; Ghostty theme "${o.ghostty}" (iTerm2-Color-Schemes, MIT)`;
    } else throw new Error(`${id}: neither ghostty nor a literal scheme and base`);
    // parseThemeFile normalises the hex and refuses an override of a name that is not a slot.
    out.push(parseThemeFile({ id, name: o.name, scheme, ...(o.pair ? { pair: o.pair } : {}), source, base, ...(o.overrides ? { overrides: o.overrides } : {}) }));
  }
  // Dark first, then light; overrides.json order within each (the default, GitHub, first).
  return [...out.filter((t) => t.scheme === "dark"), ...out.filter((t) => t.scheme === "light")];
}

export function catalogJson(catalog: ThemeFile[]): string {
  return JSON.stringify(catalog, null, 2) + "\n";
}

/**
 * The daemon's copy (internal/theme, go:embed): what it needs to validate and list the
 * appearance.theme_dark / theme_light settings. No colours: the daemon never paints.
 */
export function goCatalogJson(catalog: ThemeFile[]): string {
  const themes = catalog.map((t) => ({ id: t.id, name: t.name, scheme: t.scheme, ...(t.pair ? { pair: t.pair } : {}) }));
  return JSON.stringify({ defaults: { dark: DEFAULT_DARK, light: DEFAULT_LIGHT }, themes }, null, 2) + "\n";
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
  fs.writeFileSync(PATHS.goCatalog, goCatalogJson(catalog));
  const r = (a: string | undefined, b: string | undefined) => (a && b ? Number(contrast(a, b).toFixed(1)) : NaN);
  console.table(
    catalog.map((t) => {
      const v = resolveSlots(t);
      return {
        id: t.id,
        overrides: Object.keys(t.overrides ?? {}).length,
        fg: r(v["--cf-text"], v["--cf-surface"]),
        muted: r(v["--cf-text-muted"], v["--cf-canvas"]),
        red: r(v["--cf-error"], v["--cf-surface"]),
        green: r(v["--cf-success"], v["--cf-surface"]),
        amber: r(v["--cf-warning"], v["--cf-surface"]),
        info: r(v["--cf-info"], v["--cf-surface"]),
        accent: r(v["--cf-accent-foreground"], v["--cf-accent"]),
        dL: Number(((lightness(v["--cf-surface"] ?? "") - lightness(v["--cf-canvas"] ?? "")) * 100).toFixed(1)),
      };
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
