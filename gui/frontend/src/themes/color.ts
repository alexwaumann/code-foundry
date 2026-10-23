/**
 * Colour maths for the theme resolver (src/themes/slots.ts, at runtime), the converter
 * (themes/convert.ts, at build time) and their tests: sRGB hex <-> OKLab/OKLCH, mixes,
 * lightness shifts, alpha and WCAG contrast. Hand-rolled (no dependency); every function
 * takes and returns `#rrggbb` unless it says otherwise. No DOM or Node APIs, so the app
 * bundles it and the Node converter imports it from here.
 */

export type Rgb = readonly [number, number, number];
export type Lab = readonly [number, number, number];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const delin = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** `#rgb`, `#rrggbb` or `#rrggbbaa` to sRGB 0..1 and alpha 0..1. */
export function parseHex(hex: string): { rgb: Rgb; alpha: number } {
  let h = hex.trim().replace(/^#/, "").toLowerCase();
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(h)) throw new Error(`not a hex colour: ${hex}`);
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { rgb: [n(0), n(2), n(4)], alpha: h.length === 8 ? n(6) : 1 };
}

export function toHex(rgb: Rgb): string {
  return "#" + rgb.map((c) => Math.round(clamp01(c) * 255).toString(16).padStart(2, "0")).join("");
}

function rgbToLab(rgb: Rgb): Lab {
  const [r, g, b] = rgb.map(lin) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Linear-light sRGB of an OKLab colour, unclamped (may be out of gamut). */
function labToLinear([L, a, b]: Lab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: Rgb) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

export function toLab(hex: string): Lab {
  return rgbToLab(parseHex(hex).rgb);
}

/**
 * OKLab to hex. Out-of-gamut colours keep their lightness and hue and lose chroma until
 * they fit (CSS Color 4's approach, without the ΔE shortcut), so a shifted colour never
 * changes hue by clipping.
 */
export function fromLab(lab: Lab): string {
  const [L, a, b] = lab;
  const Lc = clamp01(L);
  if (inGamut(labToLinear([Lc, a, b]))) return toHex(labToLinear([Lc, a, b]).map(delin) as unknown as Rgb);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const t = (lo + hi) / 2;
    if (inGamut(labToLinear([Lc, a * t, b * t]))) lo = t;
    else hi = t;
  }
  return toHex(labToLinear([Lc, a * lo, b * lo]).map((c) => delin(clamp01(c))) as unknown as Rgb);
}

/** OKLab lightness 0..1. */
export const lightness = (hex: string) => toLab(hex)[0];

/** OKLCH chroma. */
export function chroma(hex: string): number {
  const [, a, b] = toLab(hex);
  return Math.hypot(a, b);
}

/** OKLCH hue in degrees, 0..360. */
export function hue(hex: string): number {
  const [, a, b] = toLab(hex);
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
}

/** OKLCH of a colour: lightness 0..1, chroma (0 to about 0.37 in sRGB), hue in degrees 0..360. */
export function toOklch(hex: string): readonly [number, number, number] {
  return [lightness(hex), chroma(hex), hue(hex)];
}

const labOf = (L: number, C: number, H: number): Lab => [L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)];

/** OKLCH to hex, chroma reduced (lightness and hue kept) until it fits sRGB, as fromLab does. */
export function fromOklch(L: number, C: number, H: number): string {
  return fromLab(labOf(L, Math.max(0, C), H));
}

/** OKLCH as gamma-encoded sRGB 0..1, or null when it is outside sRGB (the editor's plane leaves those pixels empty). */
export function oklchRgb(L: number, C: number, H: number): Rgb | null {
  const lin = labToLinear(labOf(L, C, H));
  if (!inGamut(lin)) return null;
  return lin.map((c) => delin(clamp01(c))) as unknown as Rgb;
}

/** The alpha of a `#rrggbbaa` colour (1 for `#rrggbb`). */
export const alphaOf = (hex: string): number => parseHex(hex).alpha;

/** `color-mix(in oklab, a, b t)`: t = 0 is a, 1 is b. */
export function mix(a: string, b: string, t: number): string {
  const A = toLab(a);
  const B = toLab(b);
  return fromLab([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}

/** OKLCH lightness + d, hue and chroma kept (chroma drops only to stay in gamut). */
export function shiftL(hex: string, d: number): string {
  const [L, a, b] = toLab(hex);
  return fromLab([L + d, a, b]);
}

/**
 * A colour at `alpha` painted over an opaque `under`, as the browser composites it (in
 * gamma-encoded sRGB). Borders are the text at 8-18% painted over the surface this way.
 */
export function over(color: string, alpha: number, under: string): string {
  const c = parseHex(color).rgb;
  const u = parseHex(under).rgb;
  return toHex([c[0] * alpha + u[0] * (1 - alpha), c[1] * alpha + u[1] * (1 - alpha), c[2] * alpha + u[2] * (1 - alpha)]);
}

/** `hex` at `alpha` (0..1) as `#rrggbbaa`: a tint that composites over whatever it sits on. */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return toHex(parseHex(hex).rgb) + a.toString(16).padStart(2, "0");
}

/** A `#rrggbb` or `#rrggbbaa` colour painted over an opaque `under`, as opaque hex. */
export function flatten(color: string, under: string): string {
  const { rgb, alpha } = parseHex(color);
  return alpha >= 1 ? toHex(rgb) : over(toHex(rgb), alpha, under);
}

export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).rgb.map(lin) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio, 1..21. */
export function contrast(x: string, y: string): number {
  const a = luminance(x);
  const b = luminance(y);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Steps `color`'s lightness by `step` (keeping hue and chroma) until it reaches `ratio`
 * against every background, at most 100 steps. Returns the colour unchanged when it
 * already passes.
 */
export function ensureContrast(color: string, backgrounds: readonly string[], ratio: number, step: number): string {
  const [L, a, b] = toLab(color);
  let c = color;
  for (let i = 1; i <= 100 && backgrounds.some((bg) => contrast(c, bg) < ratio); i++) c = fromLab([L + i * step, a, b]);
  return c;
}
