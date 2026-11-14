/**
 * Fitting a pane's tabs into its strip (docs/notes/shell-model.md, "The tab is the title"). The
 * strip measures each tab's natural width (icon, whole label, padding) and the room it has; this
 * says how wide each tab is drawn:
 *
 * 1. While even shortened tabs do not fit, tabs go icon-only, the farthest from the active tab
 *    first (the later one of two as far), the active tab last.
 * 2. The active tab keeps its whole label when the others still get their least width.
 * 3. The other labelled tabs share what is left: the longest labels shorten first, none below
 *    TAB_MIN_LABEL (a tab narrower than that by nature keeps its width).
 *
 * A tab whose label does not show whole (`short` or `icon`) is the one that gets a tooltip.
 * See docs/notes/shell-9-geometry.md.
 */

/** An icon-only tab's width, in px. */
export const TAB_ICON_WIDTH = 26;

/** The least width a shortened labelled tab keeps, in px. */
export const TAB_MIN_LABEL = 84;

export type TabLabel = "full" | "short" | "icon";

export interface TabFit {
  label: TabLabel;
  width: number;
}

export interface TabFitInput {
  /** Each tab's natural width, in strip order. */
  widths: readonly number[];
  /** The active tab's index; -1 for none. */
  active: number;
  /** The width the tabs may take together. */
  avail: number;
  iconWidth?: number;
  minLabel?: number;
}

/** How wide each tab is drawn. When even every tab icon-only overflows, they all are. */
export function fitTabs({
  widths,
  active,
  avail,
  iconWidth = TAB_ICON_WIDTH,
  minLabel = TAB_MIN_LABEL,
}: TabFitInput): TabFit[] {
  const n = widths.length;
  const nat = (i: number) => widths[i] ?? 0;
  const icon: boolean[] = widths.map(() => false);
  const least = (i: number) => (icon[i] ? iconWidth : Math.min(nat(i), minLabel));
  const need = () => widths.reduce((s, _, i) => s + least(i), 0);

  const order = widths
    .map((_, i) => i)
    .filter((i) => i !== active)
    .sort((a, b) => Math.abs(b - active) - Math.abs(a - active) || b - a);
  if (active >= 0 && active < n) order.push(active);
  for (const i of order) {
    if (need() <= avail) break;
    icon[i] = true;
  }

  const width: number[] = widths.map((_, i) => least(i));
  const others = widths.map((_, i) => i).filter((i) => i !== active && !icon[i]);
  let left = avail - widths.reduce((s, _, i) => s + (others.includes(i) ? 0 : least(i)), 0);
  if (active >= 0 && active < n && !icon[active]) {
    const restForActive = left - others.reduce((s, i) => s + least(i), 0) + least(active);
    width[active] = Math.max(least(active), Math.min(nat(active), restForActive));
    left -= width[active] - least(active);
  }

  // Water-fill: the largest whole cap c with every other labelled tab at max(least, min(nat, c)).
  const at = (c: number) => others.reduce((s, i) => s + Math.max(least(i), Math.min(nat(i), c)), 0);
  if (at(Infinity) <= left) {
    for (const i of others) width[i] = nat(i);
  } else {
    let lo = 0;
    let hi = Math.ceil(Math.max(0, ...others.map(nat)));
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (at(mid) <= left) lo = mid;
      else hi = mid - 1;
    }
    for (const i of others) width[i] = Math.max(least(i), Math.min(nat(i), lo));
  }

  return widths.map((_, i) => ({
    label: icon[i] ? "icon" : (width[i] ?? 0) < nat(i) ? "short" : "full",
    width: width[i] ?? 0,
  }));
}
