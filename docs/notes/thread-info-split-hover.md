# Thread info card: split hover on rows with an ellipsis

Status: done on branch `cf/thread-info-split-hover` (GUI only). Supersedes two decisions in
`thread-info-row-menus.md`: the ellipsis button's own `hover:bg-cf-text/10` box over a
whole-row tint, and "every row with an ellipsis is tinted while its menu is up".

A user asked for this on 2026-11-01: with the whole row tinted and a lighter box on the
ellipsis, the ellipsis read as decoration on the row rather than a second target. Two
distinct hover zones make the second target obvious (T3-style).

## The rule

A row whose `trailing` is a `RowMore` (Open in Finder, Actions with a picked action, each
pull request, the Lineage label) lights as two blocks with a 2px seam between them:

* **Left block**: the row's `before:`, from its left edge to 26px short of its right edge
  (the 24px ellipsis zone plus the seam). `rounded-l-md`, square on the right.
* **Ellipsis block**: the `RowMoreButton`'s `after:`, the row's last 24px at its full
  height (both lines of a pull request). `rounded-r-md`, square on the left. The button is
  static, so the overlay's containing block is the row (`relative`); it is also the
  button's hit area, the same 24px by a row as before (taller on tall rows).
* **Pointer**: the block under it gets `bg-cf-control-hover`, the other
  `bg-cf-control-hover/50` (Tailwind's opacity modifier: one definition, a color-mix with
  transparent). Text hovered: left bright, ellipsis dim. Ellipsis hovered: flipped.
* **Menu open** (`aria-expanded`): the ellipsis block bright, the left block untinted,
  wherever the pointer is.
* **Keyboard**: focus on the row lights the left block only; focus on the ellipsis its
  block only.
* **Glyph**: `text-cf-text` while its block is bright (hover, focus-visible, expanded),
  muted otherwise.
* **The Lineage label** has no click of its own: hovering its text lights nothing.
  Hovering its ellipsis lights the ellipsis block alone, with no dim left block: the dim
  block marks a second target, and the label is not one (the prototype dimmed it; changed
  in review). Its menu follows the menu-open rule.
* Rows without a `RowMore` are unchanged: the whole-row tint.
* The card's Actions menu items follow the same rule with their gear (a 32px block, a
  34px left block; docs/notes/thread-info-action-menu-gear.md).

## Decisions

* Classes, no stylesheet: `SPLIT_ROW` (every row with a RowMore) and `SPLIT_ROW_ACTIVE`
  (one that also has a click) in `Row.tsx`. The button's dim state is
  `group-hover/split:after:…/50`; only a clickable split row is a `group/split`, so the
  Lineage label's text hover leaves its ellipsis alone.
* The row's own hover/focus background is dropped only on split rows; the row still has
  `cursor-default`.
* The menu-open rule uses `has-[[data-row-more][aria-expanded=true]]:before:bg-transparent!`.
  Without the `!` the row's bright hover rule (`hover:not-has-[[data-row-more]:hover]:before:…`,
  more specific) lit the left block when the pointer came back over the text while the
  menu was up. The e2e test hovers the text with the menu open and fails without it.

## Gotchas

* **The blocks paint over the text without `isolate`.** A `before:`/`after:` at
  `position: absolute` paints above the row's in-flow text and glyph. Both pseudos sit at
  `-z-1`, and the row is `isolate` (its own stacking context), so they paint above the
  row's (empty) background and under its content. Without `isolate` a negative z-index
  sinks under the card's background instead.
* Specificity, not source order, decides most of the pairs: `:has()` and `:not(:has())`
  count their argument. The bright button rules (`hover:after:`, `aria-expanded:after:`)
  tie with `group-hover/split:after:` (whose `:where` adds nothing) and win by Tailwind's
  variant order, which puts `group-*` first.
* jsdom has no pseudo-element styles: `Row.test.tsx` checks the class lists; the computed
  colours, sizes and the seam are checked in WebKit by `e2e/thread-info.spec.ts`.

## Tests

* `Row.test.tsx`: a split row has no background class of its own; its `before:` and the
  button's `after:` classes (24px, full height, z -1, radii, bright and half rules); the
  Lineage-like row without a click gets no `group/split` and no bright left rule; a chevron
  row keeps the whole-row tint and no `before:`.
* `e2e/thread-info.spec.ts` split rows: the `::after` is 24px wide, as tall as its row
  (Open in and a pull request), at the row's right edge; the `::before` ends 26px short;
  the row's own background stays transparent; text hovered gives full/half, ellipsis
  hovered half/full (Open in and a pull request); menu open gives none/full with the
  pointer on the ellipsis, on the text and away; Tab to the ellipsis lights its block,
  Shift+Tab to the row the left one; the Lineage label's text hover lights nothing and
  its open menu lights its ellipsis block only. The colours are probed from
  `--cf-control-hover` in the page and checked to be three distinct values.
