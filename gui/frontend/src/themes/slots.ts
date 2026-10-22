/**
 * The three-tier theme model (docs/notes/theme-slots-1-engine.md).
 *
 * 1. Base: the few values a theme file must give (ThemeBase).
 * 2. Semantic slots: SLOTS below, derived from the base at load time, each overridable per
 *    theme (ThemeFile.overrides). Named `--cf-<slot>`, plus the terminal (`--terminal-*`)
 *    and syntax (`--syn-*`, `--sh-*`) palettes, which keep their names.
 * 3. Component names: the shadcn variables (`--card`, `--primary`, ...), aliases of slots
 *    in index.css (COMPONENT_ALIASES lists the same pairs), never set by a theme.
 *
 * A slot exists only when two unrelated components need the same distinction; anything
 * else derives from the slots that exist. Pure: no DOM, so the converter, the tests and
 * the app all resolve with the same code.
 */
import { contrast, ensureContrast, flatten, hue, lightness, mix, over, parseHex, shiftL, toHex, withAlpha } from "./color";

export type ThemeScheme = "light" | "dark";

/** What a theme must supply. Every colour is `#rrggbb`. */
export interface ThemeBase {
  /** The window background: the sheet the panes, sidebar and title band sit on. */
  readonly canvas: string;
  /** A pane's background (also the terminal's). */
  readonly surface: string;
  /** Body text. Lifted (or darkened) to 7:1 on the surface if it is fainter. */
  readonly text: string;
  /** The brand colour: primary buttons, the user's bubble tint, focus. */
  readonly accent: string;
  /** One hue per status; each is stepped to 4.5:1 on the surface and the canvas. */
  readonly success: string;
  readonly warning: string;
  readonly error: string;
  readonly info: string;
  readonly highlight: string;
  /** Links; the info colour when absent. */
  readonly link?: string;
  readonly terminal: {
    readonly foreground: string;
    /** The terminal foreground when absent. */
    readonly cursor?: string;
    /** Text under the cursor; ignored under 3:1 on the cursor. */
    readonly cursorText?: string;
    /** 20% of the foreground over the surface when absent. */
    readonly selection?: string;
    /** ANSI 0-15: black, red, green, yellow, blue, magenta, cyan, white, then bright. */
    readonly ansi: readonly string[];
  };
}

/** One theme as a file: the catalog entries and, later, a theme the model writes. */
export interface ThemeFile {
  readonly id: string;
  readonly name: string;
  readonly scheme: ThemeScheme;
  /** The light/dark sibling (GitHub Dark and Light, ...). */
  readonly pair?: string;
  /** Upstream project and where the colours came from. */
  readonly source: string;
  readonly base: ThemeBase;
  /** Final values for individual slots (`#rrggbb` or `#rrggbbaa`), applied as is: no guard. */
  readonly overrides?: Readonly<Record<string, string>>;
}

export const SLOT_GROUPS = ["surfaces", "text", "interactive", "sidebar", "thread", "status", "diff", "charts", "terminal", "syntax"] as const;
export type SlotGroup = (typeof SLOT_GROUPS)[number];

/** What a rule reads: the theme's base and scheme, and every slot resolved before it. */
export interface RuleContext {
  readonly scheme: ThemeScheme;
  readonly dark: boolean;
  readonly base: ThemeBase;
  /** A slot resolved earlier in SLOTS (overrides applied); throws on a forward reference. */
  get(name: string): string;
}

export interface Slot {
  readonly name: string;
  readonly group: SlotGroup;
  /** The rule in words, for the docs and a future settings page. */
  readonly rule: string;
  readonly derive: (c: RuleContext) => string;
}

/** Text and status colours step away from the surface: lighter on dark, darker on light. */
const away = (c: RuleContext) => (c.dark ? 0.005 : -0.005);

/** Text for a solid fill: the darker of the two if it reaches 4.5:1, else the lighter, else the better. */
export function textOn(fill: string, a: string, b: string): string {
  const [dark, light] = lightness(a) <= lightness(b) ? [a, b] : [b, a];
  if (contrast(dark, fill) >= 4.5) return dark;
  if (contrast(light, fill) >= 4.5) return light;
  return contrast(dark, fill) >= contrast(light, fill) ? dark : light;
}

/** `[dark, light]` picked by scheme. */
const by = (c: RuleContext, dark: number, light: number) => (c.dark ? dark : light);

function statusSlots(key: "success" | "warning" | "error" | "info" | "highlight"): Slot[] {
  return [
    {
      name: `--cf-${key}`,
      group: "status",
      rule: `base.${key}, lightness stepped away from the surface until 4.5:1 on the surface and the canvas`,
      derive: (c) => ensureContrast(c.base[key], [c.get("--cf-surface"), c.get("--cf-canvas")], 4.5, away(c)),
    },
  ];
}

function statusPair(key: string): Slot[] {
  return [
    { name: `--cf-${key}-foreground`, group: "status", rule: `text on a solid ${key} fill: the surface or the text, whichever reads (darker preferred)`, derive: (c) => textOn(c.get(`--cf-${key}`), c.get("--cf-surface"), c.get("--cf-text")) },
    { name: `--cf-${key}-surface`, group: "status", rule: `${key} at 10% alpha (a badge or banner tint over any surface)`, derive: (c) => withAlpha(c.get(`--cf-${key}`), 0.1) },
  ];
}

/** thread.css's syntax slots: per scheme, the ANSI colour each token starts from. */
const SYNTAX: readonly (readonly [string, number, number])[] = [
  // [name, light ANSI, dark ANSI]
  ["--syn-kw", 1, 5],
  ["--syn-fn", 5, 4],
  ["--syn-type", 4, 3],
  ["--syn-str", 2, 2],
  ["--syn-num", 6, 6],
  ["--sh-cmd", 4, 4],
  ["--sh-flag", 6, 6],
  ["--sh-str", 2, 2],
];

/** Code tokens: 4.5:1 on the surface and on a sunken code block. */
const codeGuard = (c: RuleContext, color: string) => ensureContrast(color, [c.get("--cf-surface"), c.get("--cf-surface-sunken")], 4.5, away(c));

const ansi = (c: RuleContext, n: number) => {
  const v = c.base.terminal.ansi[n];
  if (v === undefined) throw new Error(`no ANSI colour ${String(n)}`);
  return v;
};

/**
 * Every slot, in resolution order (a rule reads only slots above it). The display order
 * is SLOT_GROUPS; within a group, this order.
 */
export const SLOTS: readonly Slot[] = [
  // Surfaces: canvas and surface come from the base; text sits between because the
  // other surfaces mix toward it.
  { name: "--cf-canvas", group: "surfaces", rule: "base.canvas", derive: (c) => c.base.canvas },
  { name: "--cf-surface", group: "surfaces", rule: "base.surface", derive: (c) => c.base.surface },
  { name: "--cf-text", group: "text", rule: "base.text, lightness stepped away from the surface until 7:1 on it", derive: (c) => ensureContrast(c.base.text, [c.get("--cf-surface")], 7, away(c)) },
  { name: "--cf-chrome", group: "surfaces", rule: "canvas (the sidebar and title band sit on the sheet)", derive: (c) => c.get("--cf-canvas") },
  { name: "--cf-surface-raised", group: "surfaces", rule: "surface (cards and the composer are the pane's colour)", derive: (c) => c.get("--cf-surface") },
  { name: "--cf-surface-overlay", group: "surfaces", rule: "surface, OKLCH L +0.03 dark / +0.02 light (menus, popovers, dialogs)", derive: (c) => shiftL(c.get("--cf-surface"), by(c, 0.03, 0.02)) },
  { name: "--cf-surface-sunken", group: "surfaces", rule: "surface mixed 14% dark / 7% light toward the text (wells, code blocks)", derive: (c) => mix(c.get("--cf-surface"), c.get("--cf-text"), by(c, 0.14, 0.07)) },
  { name: "--cf-border", group: "surfaces", rule: "text at 11% dark / 10% light over the surface", derive: (c) => over(c.get("--cf-text"), by(c, 0.11, 0.1), c.get("--cf-surface")) },
  { name: "--cf-border-strong", group: "surfaces", rule: "text at 18% dark / 16% light over the surface", derive: (c) => over(c.get("--cf-text"), by(c, 0.18, 0.16), c.get("--cf-surface")) },
  { name: "--cf-divider", group: "surfaces", rule: "text at 11% dark / 8% light over the surface (pane outlines, header rules)", derive: (c) => over(c.get("--cf-text"), by(c, 0.11, 0.08), c.get("--cf-surface")) },

  // Text and icons.
  {
    name: "--cf-text-muted",
    group: "text",
    rule: "text mixed 32% toward the surface, then back toward the text in 5% steps until 4.5:1 on the surface and the canvas",
    derive: (c) => {
      const text = c.get("--cf-text");
      const bgs = [c.get("--cf-surface"), c.get("--cf-canvas")];
      const start = mix(text, c.get("--cf-surface"), 0.32);
      let muted = start;
      for (let t = 0.05; t <= 1 && bgs.some((bg) => contrast(muted, bg) < 4.5); t += 0.05) muted = mix(start, text, t);
      return muted;
    },
  },
  { name: "--cf-text-secondary", group: "text", rule: "halfway between the text and the muted text (so never fainter than muted)", derive: (c) => mix(c.get("--cf-text"), c.get("--cf-text-muted"), 0.5) },
  { name: "--cf-placeholder", group: "text", rule: "the muted text", derive: (c) => c.get("--cf-text-muted") },
  { name: "--cf-icon", group: "text", rule: "text (icons take their label's colour)", derive: (c) => c.get("--cf-text") },
  { name: "--cf-icon-muted", group: "text", rule: "the muted text", derive: (c) => c.get("--cf-text-muted") },

  // Status solids first: link and the charts read them.
  ...statusSlots("success"),
  ...statusSlots("warning"),
  ...statusSlots("error"),
  ...statusSlots("info"),
  ...statusSlots("highlight"),
  {
    name: "--cf-link",
    group: "text",
    rule: "base.link guarded as a status colour; info when absent",
    derive: (c) => (c.base.link ? ensureContrast(c.base.link, [c.get("--cf-surface"), c.get("--cf-canvas")], 4.5, away(c)) : c.get("--cf-info")),
  },

  // Interactive.
  {
    name: "--cf-accent",
    group: "interactive",
    rule: "base.accent; if neither the surface nor the text reaches 4.5:1 on it, its lightness steps away from the better one until it does",
    derive: (c) => {
      const accent = c.base.accent;
      const text = textOn(accent, c.get("--cf-surface"), c.get("--cf-text"));
      if (contrast(text, accent) >= 4.5) return accent;
      return ensureContrast(accent, [text], 4.5, lightness(text) < lightness(accent) ? 0.005 : -0.005);
    },
  },
  { name: "--cf-accent-foreground", group: "interactive", rule: "text on the accent: the surface or the text, whichever reads (darker preferred)", derive: (c) => textOn(c.get("--cf-accent"), c.get("--cf-surface"), c.get("--cf-text")) },
  { name: "--cf-accent-surface", group: "interactive", rule: "accent at 10% alpha (a selected tile, a chip)", derive: (c) => withAlpha(c.get("--cf-accent"), 0.1) },
  {
    name: "--cf-accent-surface-foreground",
    group: "interactive",
    rule: "accent, stepped away from the surface until 4.5:1 on accent-surface over the surface",
    derive: (c) => ensureContrast(c.get("--cf-accent"), [flatten(c.get("--cf-accent-surface"), c.get("--cf-surface"))], 4.5, away(c)),
  },
  { name: "--cf-focus", group: "interactive", rule: "accent mixed 35% toward the surface (focus rings)", derive: (c) => mix(c.get("--cf-accent"), c.get("--cf-surface"), 0.35) },
  { name: "--cf-input", group: "interactive", rule: "text at 15% dark / 13% light over the surface (field borders)", derive: (c) => over(c.get("--cf-text"), by(c, 0.15, 0.13), c.get("--cf-surface")) },
  { name: "--cf-control", group: "interactive", rule: "surface mixed 14% dark / 7% light toward the text (a secondary button at rest)", derive: (c) => mix(c.get("--cf-surface"), c.get("--cf-text"), by(c, 0.14, 0.07)) },
  { name: "--cf-control-hover", group: "interactive", rule: "surface mixed 14% dark / 7% light toward the text (a hovered ghost button or menu row)", derive: (c) => mix(c.get("--cf-surface"), c.get("--cf-text"), by(c, 0.14, 0.07)) },
  { name: "--cf-control-active", group: "interactive", rule: "surface mixed 20% dark / 11% light toward the text (pressed)", derive: (c) => mix(c.get("--cf-surface"), c.get("--cf-text"), by(c, 0.2, 0.11)) },
  { name: "--cf-selection", group: "interactive", rule: "accent at 25% alpha (selected text)", derive: (c) => withAlpha(c.get("--cf-accent"), 0.25) },

  // Status foregrounds and surfaces; update is info until a theme says otherwise.
  ...statusPair("success"),
  ...statusPair("warning"),
  ...statusPair("error"),
  ...statusPair("info"),
  ...statusPair("highlight"),
  { name: "--cf-update", group: "status", rule: "info (the update chip's available state)", derive: (c) => c.get("--cf-info") },
  { name: "--cf-update-foreground", group: "status", rule: "info-foreground", derive: (c) => c.get("--cf-info-foreground") },
  { name: "--cf-update-surface", group: "status", rule: "info-surface", derive: (c) => c.get("--cf-info-surface") },

  // Sidebar.
  { name: "--cf-sidebar", group: "sidebar", rule: "chrome", derive: (c) => c.get("--cf-chrome") },
  { name: "--cf-sidebar-foreground", group: "sidebar", rule: "text", derive: (c) => c.get("--cf-text") },
  { name: "--cf-sidebar-muted-foreground", group: "sidebar", rule: "the muted text (already 4.5:1 on the canvas)", derive: (c) => c.get("--cf-text-muted") },
  { name: "--cf-sidebar-row-hover", group: "sidebar", rule: "sidebar mixed 5% toward the text", derive: (c) => mix(c.get("--cf-sidebar"), c.get("--cf-text"), 0.05) },
  { name: "--cf-sidebar-row-selected", group: "sidebar", rule: "sidebar mixed 10% toward the text", derive: (c) => mix(c.get("--cf-sidebar"), c.get("--cf-text"), 0.1) },
  { name: "--cf-sidebar-row-active", group: "sidebar", rule: "sidebar mixed 15% toward the text", derive: (c) => mix(c.get("--cf-sidebar"), c.get("--cf-text"), 0.15) },
  { name: "--cf-sidebar-border", group: "sidebar", rule: "sidebar (no visible edge)", derive: (c) => c.get("--cf-sidebar") },

  // Terminal: faithful to the theme; only an unreadable selection or cursor text is replaced.
  { name: "--terminal-fg", group: "terminal", rule: "base.terminal.foreground (not guarded: the terminal stays faithful)", derive: (c) => c.base.terminal.foreground },
  { name: "--terminal-cursor", group: "terminal", rule: "base.terminal.cursor, else the terminal foreground", derive: (c) => c.base.terminal.cursor ?? c.get("--terminal-fg") },
  {
    name: "--terminal-cursor-accent",
    group: "terminal",
    rule: "base.terminal.cursorText if 3:1 on the cursor, else the surface or the terminal foreground, whichever reads",
    derive: (c) => {
      const cursor = c.get("--terminal-cursor");
      const ct = c.base.terminal.cursorText;
      return ct && contrast(ct, cursor) >= 3 ? ct : textOn(cursor, c.get("--cf-surface"), c.get("--terminal-fg"));
    },
  },
  {
    name: "--terminal-selection",
    group: "terminal",
    rule: "base.terminal.selection (else the foreground 20% over the surface); under 3:1 against the foreground, the foreground 25% over the surface",
    derive: (c) => {
      const fg = c.get("--terminal-fg");
      const surface = c.get("--cf-surface");
      const sel = c.base.terminal.selection ?? mix(surface, fg, 0.2);
      return contrast(fg, sel) < 3 ? mix(surface, fg, 0.25) : sel;
    },
  },
  { name: "--terminal-selection-inactive", group: "terminal", rule: "selection mixed 50% into the surface", derive: (c) => mix(c.get("--terminal-selection"), c.get("--cf-surface"), 0.5) },
  ...Array.from({ length: 16 }, (_, n): Slot => ({ name: `--terminal-ansi-${String(n)}`, group: "terminal", rule: `base.terminal.ansi[${String(n)}]`, derive: (c) => ansi(c, n) })),

  // Syntax: thread.css's tokens, from the terminal palette.
  { name: "--syn-fg", group: "syntax", rule: "terminal foreground, stepped to 4.5:1 on the surface and surface-sunken", derive: (c) => codeGuard(c, c.get("--terminal-fg")) },
  ...SYNTAX.map(([name, light, dark]): Slot => ({
    name,
    group: "syntax",
    rule: `ANSI ${String(light)} light / ${String(dark)} dark, stepped to 4.5:1 on the surface and surface-sunken`,
    derive: (c) => codeGuard(c, ansi(c, c.dark ? dark : light)),
  })),
  {
    name: "--syn-com",
    group: "syntax",
    rule: "ANSI 7 light / 8 dark; the muted text when under 3:1 on the surface or above 85% of the text's contrast",
    derive: (c) => {
      const com = ansi(c, c.dark ? 8 : 7);
      const surface = c.get("--cf-surface");
      const cc = contrast(com, surface);
      return cc < 3 || cc > 0.85 * contrast(c.get("--cf-text"), surface) ? c.get("--cf-text-muted") : com;
    },
  },

  // Thread.
  { name: "--cf-message-surface", group: "thread", rule: "accent at 14.5% dark / 8% light alpha (the user's bubble)", derive: (c) => withAlpha(c.get("--cf-accent"), by(c, 0.145, 0.08)) },
  { name: "--cf-message-foreground", group: "thread", rule: "text", derive: (c) => c.get("--cf-text") },
  { name: "--cf-code-background", group: "thread", rule: "text at 5% alpha dark; surface-sunken light", derive: (c) => (c.dark ? withAlpha(c.get("--cf-text"), 0.05) : c.get("--cf-surface-sunken")) },
  { name: "--cf-code-foreground", group: "thread", rule: "syn-fg", derive: (c) => c.get("--syn-fg") },
  { name: "--cf-quote-border", group: "thread", rule: "border", derive: (c) => c.get("--cf-border") },

  // Diff.
  { name: "--cf-diff-addition", group: "diff", rule: "success", derive: (c) => c.get("--cf-success") },
  { name: "--cf-diff-addition-surface", group: "diff", rule: "success at 12% alpha", derive: (c) => withAlpha(c.get("--cf-success"), 0.12) },
  { name: "--cf-diff-deletion", group: "diff", rule: "error", derive: (c) => c.get("--cf-error") },
  { name: "--cf-diff-deletion-surface", group: "diff", rule: "error at 12% alpha", derive: (c) => withAlpha(c.get("--cf-error"), 0.12) },
  { name: "--cf-diff-modified", group: "diff", rule: "warning (the M of a file's status)", derive: (c) => c.get("--cf-warning") },

  // Charts: six categorical colours from the status hues, then cyan.
  { name: "--cf-chart-1", group: "charts", rule: "info", derive: (c) => c.get("--cf-info") },
  { name: "--cf-chart-2", group: "charts", rule: "highlight", derive: (c) => c.get("--cf-highlight") },
  { name: "--cf-chart-3", group: "charts", rule: "success", derive: (c) => c.get("--cf-success") },
  { name: "--cf-chart-4", group: "charts", rule: "warning", derive: (c) => c.get("--cf-warning") },
  { name: "--cf-chart-5", group: "charts", rule: "error", derive: (c) => c.get("--cf-error") },
  {
    name: "--cf-chart-6",
    group: "charts",
    rule: "ANSI 6 (cyan), or the accent when cyan is within 30° of info's hue; stepped to 3:1 on the surface",
    derive: (c) => {
      const cyan = ansi(c, 6);
      const d = Math.abs(hue(cyan) - hue(c.get("--cf-info")));
      const pick = Math.min(d, 360 - d) < 30 ? c.get("--cf-accent") : cyan;
      return ensureContrast(pick, [c.get("--cf-surface")], 3, away(c));
    },
  },
];

export const SLOT_NAMES: readonly string[] = SLOTS.map((s) => s.name);
const SLOT_SET = new Set(SLOT_NAMES);

export const isSlot = (name: string): boolean => SLOT_SET.has(name);

/**
 * The component tier: each shadcn (and shell) variable and the slot it aliases. index.css
 * declares exactly these on `:root, [data-theme-scope]` (src/design/slots.test.ts checks
 * both ways); no theme sets them.
 */
export const COMPONENT_ALIASES: Readonly<Record<string, string>> = {
  "--sheet": "--cf-canvas",
  "--pane": "--cf-surface",
  "--pane-border": "--cf-divider",
  "--background": "--cf-canvas",
  "--foreground": "--cf-text",
  "--card": "--cf-surface-raised",
  "--card-foreground": "--cf-text",
  "--popover": "--cf-surface-overlay",
  "--popover-foreground": "--cf-text",
  "--primary": "--cf-accent",
  "--primary-foreground": "--cf-accent-foreground",
  "--secondary": "--cf-control",
  "--secondary-foreground": "--cf-text",
  "--muted": "--cf-surface-sunken",
  "--muted-foreground": "--cf-text-muted",
  "--accent": "--cf-control-hover",
  "--accent-foreground": "--cf-text",
  "--destructive": "--cf-error",
  "--destructive-foreground": "--cf-error-foreground",
  "--success": "--cf-success",
  "--success-foreground": "--cf-success-foreground",
  "--warning": "--cf-warning",
  "--warning-foreground": "--cf-warning-foreground",
  "--info": "--cf-info",
  "--info-foreground": "--cf-info-foreground",
  "--highlight": "--cf-highlight",
  "--highlight-foreground": "--cf-highlight-foreground",
  "--link": "--cf-link",
  "--border": "--cf-border",
  "--input": "--cf-input",
  "--ring": "--cf-focus",
  "--chart-1": "--cf-chart-1",
  "--chart-2": "--cf-chart-2",
  "--chart-3": "--cf-chart-3",
  "--chart-4": "--cf-chart-4",
  "--chart-5": "--cf-chart-5",
  "--sidebar": "--cf-sidebar",
  "--sidebar-foreground": "--cf-sidebar-foreground",
  "--sidebar-primary": "--cf-accent",
  "--sidebar-primary-foreground": "--cf-accent-foreground",
  "--sidebar-accent": "--cf-sidebar-row-selected",
  "--sidebar-accent-foreground": "--cf-sidebar-foreground",
  "--sidebar-border": "--cf-sidebar-border",
  "--sidebar-ring": "--cf-focus",
};

/** Every slot's value for a theme: the rules over its base, its overrides applied as each slot resolves. */
export function resolveSlots(theme: Pick<ThemeFile, "scheme" | "base" | "overrides">): Record<string, string> {
  const out: Record<string, string> = {};
  const ctx: RuleContext = {
    scheme: theme.scheme,
    dark: theme.scheme === "dark",
    base: theme.base,
    get(name) {
      const v = out[name];
      if (v === undefined) throw new Error(`slot ${name} read before it resolves`);
      return v;
    },
  };
  for (const slot of SLOTS) out[slot.name] = theme.overrides?.[slot.name] ?? slot.derive(ctx);
  return out;
}

/** The component names' values, from resolved slots (what index.css's aliases compute). */
export function componentValues(slots: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, slot] of Object.entries(COMPONENT_ALIASES)) {
    const v = slots[slot];
    if (v === undefined) throw new Error(`${name} aliases ${slot}, which is not resolved`);
    out[name] = v;
  }
  return out;
}

// ---------------------------------------------------------------- theme files

const OPAQUE = /^#[0-9a-f]{6}$/;
const ANY_HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/;
const BASE_COLOURS = ["canvas", "surface", "text", "accent", "success", "warning", "error", "info", "highlight"] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function opaque(v: unknown, where: string): string {
  if (typeof v !== "string") throw new Error(`${where}: not a colour`);
  const hex = v.trim().toLowerCase();
  if (!OPAQUE.test(hex)) throw new Error(`${where}: ${v} is not #rrggbb`);
  return hex;
}

/**
 * A theme file (JSON) checked and normalised (lowercase hex). Throws with the first
 * problem: a missing or malformed base colour, a scheme other than light/dark, or an
 * override of a name that is not a slot.
 */
export function parseThemeFile(json: unknown): ThemeFile {
  if (!isRecord(json)) throw new Error("theme: not an object");
  const str = (k: string) => {
    const v = json[k];
    if (typeof v !== "string" || !v) throw new Error(`theme: no ${k}`);
    return v;
  };
  const id = str("id");
  const scheme = json.scheme;
  if (scheme !== "light" && scheme !== "dark") throw new Error(`${id}: scheme must be light or dark`);
  const b = json.base;
  if (!isRecord(b)) throw new Error(`${id}: no base`);
  const t = b.terminal;
  if (!isRecord(t)) throw new Error(`${id}: no base.terminal`);
  if (!Array.isArray(t.ansi) || t.ansi.length !== 16) throw new Error(`${id}: base.terminal.ansi needs 16 colours`);
  const optional = (v: unknown, where: string) => (v === undefined ? undefined : opaque(v, where));
  const colours = Object.fromEntries(BASE_COLOURS.map((k) => [k, opaque(b[k], `${id}: base.${k}`)])) as Record<(typeof BASE_COLOURS)[number], string>;
  const link = optional(b.link, `${id}: base.link`);
  const cursor = optional(t.cursor, `${id}: base.terminal.cursor`);
  const cursorText = optional(t.cursorText, `${id}: base.terminal.cursorText`);
  const selection = optional(t.selection, `${id}: base.terminal.selection`);
  const base: ThemeBase = {
    ...colours,
    ...(link ? { link } : {}),
    terminal: {
      foreground: opaque(t.foreground, `${id}: base.terminal.foreground`),
      ...(cursor ? { cursor } : {}),
      ...(cursorText ? { cursorText } : {}),
      ...(selection ? { selection } : {}),
      ansi: t.ansi.map((c, i) => opaque(c, `${id}: base.terminal.ansi[${String(i)}]`)),
    },
  };
  let overrides: Record<string, string> | undefined;
  if (json.overrides !== undefined) {
    if (!isRecord(json.overrides)) throw new Error(`${id}: overrides is not an object`);
    overrides = {};
    for (const [k, v] of Object.entries(json.overrides)) {
      if (!isSlot(k)) throw new Error(`${id}: ${k} is not a slot`);
      const hex = typeof v === "string" ? v.trim().toLowerCase() : "";
      if (!ANY_HEX.test(hex)) throw new Error(`${id}: ${k} is not #rrggbb or #rrggbbaa`);
      overrides[k] = hex;
    }
  }
  const pair = json.pair;
  if (pair !== undefined && typeof pair !== "string") throw new Error(`${id}: pair is not a string`);
  return { id, name: str("name"), scheme, ...(pair ? { pair } : {}), source: str("source"), base, ...(overrides && Object.keys(overrides).length ? { overrides } : {}) };
}

/** `#rrggbb` lowercase (for literal inputs written in other forms). */
export const normaliseHex = (hex: string): string => toHex(parseHex(hex).rgb);
