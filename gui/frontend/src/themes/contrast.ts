/**
 * What the Themes page's editor reports on a theme (docs/notes/theme-editor.md), on top of
 * the one pair list (contrastPairs.ts): which pairs fall short (contrastReport), every pair
 * a slot is in (slotContrast), what a pinned slot would derive (derivedValue), which pins
 * the base has moved away from (staleOverrides), and the one-click fix for a failing pair
 * (fixContrast). Pure: no DOM, no store.
 */
import { contrast, flatten, lightness, parseHex, shiftL, toHex } from "./color";
import { CONTRAST_PAIRS, contrastFailures, pairBackground, pairLabel, pairRatio, type ContrastPair } from "./contrastPairs";
import { resolveSlots, type ThemeFile } from "./slots";

/** What the editor resolves: a theme's scheme, base and pins (overrides). */
export type EditableTheme = Pick<ThemeFile, "scheme" | "base" | "overrides">;

/** One pair, measured. */
export interface ContrastEntry {
  /** The slot drawn on top (the pair's fg). */
  readonly slot: string;
  /** The slot it sits on (the pair's bg). */
  readonly against: string;
  /** When `against` is a tint: the opaque slot it is painted over. */
  readonly over?: string;
  /** `slot on against (over X)`. */
  readonly label: string;
  /** Where the pair occurs, in words. */
  readonly why: string;
  readonly ratio: number;
  readonly required: number;
}

const entry = (pair: ContrastPair, ratio: number): ContrastEntry => ({
  slot: pair.fg,
  against: pair.bg,
  ...(pair.over ? { over: pair.over } : {}),
  label: pairLabel(pair),
  why: pair.why,
  ratio,
  required: pair.min,
});

/** Every pair the theme falls short on, in CONTRAST_PAIRS order (contrastFailures). Saving with some is allowed. */
export function contrastReport(theme: EditableTheme, slots: Readonly<Record<string, string>> = resolveSlots(theme)): ContrastEntry[] {
  return contrastFailures(slots).map((f) => entry(f.pair, f.ratio));
}

/** Every pair `slot` takes part in (drawn on top, as the background or under a tint), measured, with whether it passes. */
export function slotContrast(slots: Readonly<Record<string, string>>, slot: string): (ContrastEntry & { readonly pass: boolean })[] {
  return CONTRAST_PAIRS.filter((p) => p.fg === slot || p.bg === slot || p.over === slot).map((p) => {
    const ratio = pairRatio(slots, p);
    return { ...entry(p, ratio), pass: ratio >= p.min };
  });
}

/** The theme without its pin on `slot` (the others kept). */
export function withoutPin<T extends EditableTheme>(theme: T, slot: string): T {
  if (!theme.overrides || !(slot in theme.overrides)) return theme;
  const { [slot]: _gone, ...rest } = theme.overrides;
  return { ...theme, overrides: rest };
}

/**
 * What `slot` resolves to by its rule, with the theme's other pins kept (they feed the
 * rules after them): the value "Reset to derived" and "Unpin" go back to.
 */
export function derivedValue(theme: EditableTheme, slot: string): string {
  const v = resolveSlots(withoutPin(theme, slot))[slot];
  if (v === undefined) throw new Error(`${slot} is not a slot`);
  return v;
}

/** A pin whose slot now derives another value than it did when it was pinned. */
export interface StalePin {
  readonly slot: string;
  readonly pinned: string;
  /** What it derived when pinned (or when the editor opened the file). */
  readonly basis: string;
  /** What it would derive now. */
  readonly derived: string;
}

/**
 * The stale rule: a pin keeps its absolute value when a base colour changes, so it is
 * stale when its slot's derived value (derivedValue: the theme resolved with that pin
 * removed) differs from `basis[slot]`, what it derived when it was pinned. A pin with no
 * basis (the editor records one for every pin, at open and at pinning) is never stale.
 * "Re-derive" unpins it; "Reset to derived" pins the new value.
 */
export function staleOverrides(theme: EditableTheme, basis: Readonly<Record<string, string>>): StalePin[] {
  const out: StalePin[] = [];
  for (const [slot, pinned] of Object.entries(theme.overrides ?? {})) {
    const was = basis[slot];
    if (was === undefined) continue;
    const derived = derivedValue(theme, slot);
    if (derived !== was) out.push({ slot, pinned, basis: was, derived });
  }
  return out;
}

/** The basis for staleOverrides: what each pinned slot derives now. */
export function pinBasis(theme: EditableTheme): Record<string, string> {
  return Object.fromEntries(Object.keys(theme.overrides ?? {}).map((slot) => [slot, derivedValue(theme, slot)]));
}

/**
 * The save modal's Fix for a slot with a failing pair: if the slot is pinned and its
 * derived value passes every pair it is drawn in, the pin goes (`unpin`); otherwise the
 * guard step the rules use runs on its current value (lightness stepped away from the
 * failing pair's background, hue and chroma kept, until every pair it is drawn in holds)
 * and the result is pinned (`pin`). null when the slot fails no pair.
 */
export function fixContrast(theme: EditableTheme, slot: string): { readonly kind: "unpin" } | { readonly kind: "pin"; readonly value: string } | null {
  const pairs = CONTRAST_PAIRS.filter((p) => p.fg === slot);
  const slots = resolveSlots(theme);
  const failing = pairs.find((p) => pairRatio(slots, p) < p.min);
  if (!failing) return null;
  if (theme.overrides && slot in theme.overrides) {
    const derived = resolveSlots(withoutPin(theme, slot));
    if (pairs.every((p) => pairRatio(derived, p) >= p.min)) return { kind: "unpin" };
  }
  const current = slots[slot];
  if (current === undefined) return null;
  const { alpha } = parseHex(current);
  const opaque = toHex(parseHex(current).rgb);
  const backgrounds = pairs.map((p) => ({ bg: pairBackground(slots, p), min: p.min }));
  const passes = (c: string) => backgrounds.every(({ bg, min }) => contrast(flatten(c, bg), bg) >= min);
  const target = pairBackground(slots, failing);
  const away = lightness(opaque) >= lightness(target) ? 0.005 : -0.005;
  // ensureContrast's step, with one ratio per background: until all of them hold, then the other way if that runs out.
  const step = (dir: number) => {
    let c = opaque;
    for (let i = 1; i <= 200 && !passes(c); i++) c = shiftL(opaque, i * dir);
    return c;
  };
  let value = step(away);
  if (!passes(value)) value = step(-away);
  if (alpha < 1) value += Math.round(alpha * 255).toString(16).padStart(2, "0");
  return { kind: "pin", value };
}
