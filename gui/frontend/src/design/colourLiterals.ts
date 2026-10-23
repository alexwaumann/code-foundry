import { stringLiterals } from "./scan";

/**
 * Raw colours the palette guard (lib/palette.test.ts) finds beyond its line patterns
 * (docs/notes/theme-slots-3-hardening.md): CSS named colours and hex inside string and
 * template literals (a style value, an SVG attribute, a `<style>` string, a template that
 * builds CSS), and any literal colour inside a Tailwind arbitrary value or property: a
 * name, a hex, a colour function (hwb(), color() included), or a color-mix() with one
 * literal argument. palette.test.ts has the cases. A colour comes from a slot
 * (`var(--cf-…)`, `bg-cf-…`), so a theme recolours it.
 *
 * Not catchable statically, and so a rule rather than a guard: a colour utility is never
 * built from strings (`bg-${tone}/10`, `"text-cf-" + tone`): Tailwind only generates the
 * classes it sees whole, and neither guard can read the name. Map a tone to whole class
 * strings instead (`{ ok: "bg-cf-success", failed: "bg-cf-error" }`).
 */

/** CSS Color 4's named colours (transparent and currentcolor are not colours of their own). */
export const NAMED_COLOURS: readonly string[] = [
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black", "blanchedalmond", "blue", "blueviolet", "brown",
  "burlywood", "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue", "cornsilk", "crimson", "cyan", "darkblue", "darkcyan",
  "darkgoldenrod", "darkgray", "darkgreen", "darkgrey", "darkkhaki", "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred",
  "darksalmon", "darkseagreen", "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise", "darkviolet", "deeppink", "deepskyblue",
  "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite", "forestgreen", "fuchsia", "gainsboro", "ghostwhite", "gold", "goldenrod",
  "gray", "green", "greenyellow", "grey", "honeydew", "hotpink", "indianred", "indigo", "ivory", "khaki", "lavender", "lavenderblush",
  "lawngreen", "lemonchiffon", "lightblue", "lightcoral", "lightcyan", "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey",
  "lightpink", "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue", "lightyellow", "lime",
  "limegreen", "linen", "magenta", "maroon", "mediumaquamarine", "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen",
  "mediumslateblue", "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue", "mintcream", "mistyrose", "moccasin",
  "navajowhite", "navy", "oldlace", "olive", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod", "palegreen", "paleturquoise",
  "palevioletred", "papayawhip", "peachpuff", "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple", "red", "rosybrown",
  "royalblue", "saddlebrown", "salmon", "sandybrown", "seagreen", "seashell", "sienna", "silver", "skyblue", "slateblue", "slategray",
  "slategrey", "snow", "springgreen", "steelblue", "tan", "teal", "thistle", "tomato", "turquoise", "violet", "wheat", "white", "whitesmoke",
  "yellow", "yellowgreen",
];

const NAMED_SET = new Set(NAMED_COLOURS);
const NAMED_ALT = NAMED_COLOURS.join("|");
/** A named colour as a word in a CSS value (Tailwind's `_` is a space there, so it separates). */
const NAMED_WORD = new RegExp(String.raw`(?<![a-z0-9-])(?:${NAMED_ALT})(?![a-z0-9-])`, "i");
/** A colour function: always a literal colour (color-mix only mixes, so it is read for its arguments). */
const COLOUR_FN = /(?<![\w-])(?:oklch|oklab|lch|lab|rgba?|hsla?|hwb|color)\(/i;
/** A hex token. Three or four digits only count after a CSS separator (`: #000`), so "PR #142" is not a colour. */
const HEX = /(?<![\w&#/])#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?![a-z0-9-])/gi;

function hasHex(s: string): boolean {
  for (const m of s.matchAll(HEX)) {
    const digits = m[0].slice(1);
    if (/[a-f]/i.test(digits) || digits.length >= 6) return true;
    if (/(?:^|[:(,_[]\s*)$/.test(s.slice(0, m.index))) return true;
  }
  return false;
}

/** Whether a CSS value (a declaration's right side, an arbitrary value's content) holds a literal colour. */
export function valueHasColour(value: string): boolean {
  return COLOUR_FN.test(value) || NAMED_WORD.test(value) || hasHex(value);
}

/** Tailwind arbitrary values and properties in a class string: the content of each `[…]` that is not a selector. */
function arbitraries(s: string): string[] {
  return [...s.matchAll(/(?<![\w-])(?:[\w-]+-)?\[([^\]\s"'`]+)\]/g)].map((m) => m[1] ?? "").filter((c) => !c.startsWith("&") && !/^[\w-]+=/.test(c));
}

/** CSS declarations inside a literal (`color: tomato`, `background:#fff`), values only. */
function declarationValues(s: string): string[] {
  return [...s.matchAll(/(?:^|[;{\s"'`[])(-{0,2}[a-z][a-z-]*)\s*:\s*([^;{}"'`\]]+)/gi)].map((m) => m[2] ?? "");
}

/** Where a whole-literal named colour is a colour: an SVG/JSX colour attribute, a style property, a setProperty argument. */
const COLOUR_OWNER = /^(?:fill|stroke|color|stopColor|stop-color|floodColor|flood-color|lightingColor|background|backgroundColor|bgcolor|borderColor|outlineColor|caretColor|accentColor|textDecorationColor|setProperty)$/i;

export interface LiteralColourHit {
  line: number;
  /** What was found, for the message: the literal, or the arbitrary value or declaration. */
  match: string;
}

/**
 * The literal colours in a TS/TSX source's string and template literals: a named colour
 * where a colour goes (`fill="tomato"`, `{ color: "white" }`, `setProperty("--x", "red")`;
 * a tone key such as `tone: "red"` elsewhere is a name, not a colour), a CSS declaration
 * with a colour value in a literal that holds CSS (`;` or `{`: a `<style>` string, a
 * template building `border: 1px solid #abc;`), a hex token anywhere in a literal, and a
 * colour inside a Tailwind arbitrary value or property. Object keys are skipped.
 */
export function scanLiteralColours(fileName: string, source: string): LiteralColourHit[] {
  const hits: LiteralColourHit[] = [];
  for (const l of stringLiterals(fileName, source)) {
    if (l.key) continue;
    const body = l.raw.replace(/^["'`}]|["'`]$|\$\{$/g, "");
    const css = /[;{]/.test(body);
    const found =
      (l.owner !== undefined && COLOUR_OWNER.test(l.owner) && NAMED_SET.has(body.trim().toLowerCase()) && body.trim()) ||
      arbitraries(body).find(valueHasColour) ||
      (css && declarationValues(body).find(valueHasColour)) ||
      (hasHex(body) && body.trim());
    if (found) hits.push({ line: l.line, match: found.slice(0, 120) });
  }
  return hits;
}

/** Declaration values in a stylesheet (comments already blanked) that name a colour; one hit per line. */
export function scanCssNamedColours(css: string): LiteralColourHit[] {
  const hits: LiteralColourHit[] = [];
  css.split("\n").forEach((text, i) => {
    for (const m of text.matchAll(/(?<![\w-])(-{0,2}[a-z][a-z-]*)\s*:\s*([^;{}]+)/gi)) {
      const value = m[2] ?? "";
      if (NAMED_WORD.test(value)) {
        hits.push({ line: i + 1, match: `${m[1] ?? ""}: ${value.trim()}` });
        return;
      }
    }
  });
  return hits;
}
