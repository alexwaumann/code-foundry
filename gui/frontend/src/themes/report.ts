/**
 * The contrast report the GUI publishes on each saved user theme (docs/notes/theme-followups.md),
 * so `theme save` and `theme check` can print it: the daemon derives no colour. The pairs
 * come from contrastReport; the stale pins from staleOverrides, against a basis carried
 * from save to save (carryPinBasis), since a file alone cannot say what a pin was made
 * against. Pure: no DOM, no store.
 */
import { contrastReport, derivedValue, staleOverrides, type EditableTheme, type StalePin } from "./contrast";
import { resolveSlots } from "./slots";

/** Each pin of a theme: its value and what its slot derived when it was pinned (or first seen). */
export type PinBasis = Readonly<Record<string, { readonly pinned: string; readonly basis: string }>>;

/**
 * The basis for `theme`'s pins, given the last version's: a pin kept at the same value keeps
 * its basis, so a base change since then shows it stale; a new or changed pin is measured
 * now (pinned against what its slot derives today: not stale). With no last version every
 * pin is measured now, as the editor does when it opens a file (pinBasis).
 */
export function carryPinBasis(theme: EditableTheme, prev: PinBasis | undefined): PinBasis {
  const out: Record<string, { pinned: string; basis: string }> = {};
  for (const [slot, pinned] of Object.entries(theme.overrides ?? {})) {
    const was = prev?.[slot];
    out[slot] = was && was.pinned === pinned ? was : { pinned, basis: derivedValue(theme, slot) };
  }
  return out;
}

/** One failing pair, as the daemon keeps it. */
export interface ReportIssue {
  readonly slot: string;
  readonly against: string;
  readonly label: string;
  readonly ratio: number;
  readonly required: number;
}

export interface ThemeFileReport {
  readonly issues: readonly ReportIssue[];
  readonly stale: readonly StalePin[];
}

/** The report on a theme: its failing pairs (CONTRAST_PAIRS order) and its stale pins against `basis`. */
export function reportOn(theme: EditableTheme, basis: PinBasis, slots: Readonly<Record<string, string>> = resolveSlots(theme)): ThemeFileReport {
  return {
    issues: contrastReport(theme, slots).map(({ slot, against, label, ratio, required }) => ({ slot, against, label, ratio, required })),
    stale: staleOverrides(theme, Object.fromEntries(Object.entries(basis).map(([slot, b]) => [slot, b.basis]))),
  };
}
