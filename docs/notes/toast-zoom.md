# Toasts under page zoom (2026-11-19)

> Superseded 2026-11-20 by `native-zoom.md`: zoom is the webview's page zoom now, and the
> CSS-zoom handling of toasts described here is gone. Kept for the history.

Bug a user reported: at a page zoom other than 100%, hovering a toast made its contents
shift, and its buttons could end up outside the card.

**This fix exists only because the page zoom is CSS `zoom` on `<html>`** (`lib/zoom.ts`,
`ui-zoom.md`). When the zoom becomes native (or free CSS zoom goes), delete it: see
"Removing it" below.

## Mechanism (measured in the mock app, WebKit)

sonner (2.0.8) measures each card with `getBoundingClientRect()`, which under the
standardized zoom model is **viewport px**, and writes the numbers into inline custom
properties. Its stylesheet then uses them as CSS lengths on elements inside the zoomed
page, where they are **layout px** and get scaled by the zoom a second time:

| property | set from | used by sonner's stylesheet for |
| --- | --- | --- |
| `--initial-height` (toast) | the card's measured height | an expanded card's `height`; a leaving card's `::before` hit area |
| `--front-toast-height` (toaster) | the front card's measured height | a collapsed card's `height` behind the front one |
| `--offset` (toast) | `index × gap` + the measured heights of the cards in front | an expanded card's `translateY`, and a leaving one's |
| `--swipe-amount-x/y` (toast) | pointer deltas, `clientX/Y` | the drag `transform` and the `swipe-out-*` keyframes |

`--gap`, `--width` and `--offset-top/right/bottom/left` come from props, so they are
already layout px. `--offset` is the odd one: half props, half measurement.

Before the fix, a card of natural height 114 layout px (hovered, so expanded) was 103 px at
90% (the buttons on or past the bottom edge) and 142 px at 125% (the contents shifted).
The collapsed cards behind the front one were zoom × the front's height, and the expanded
stack's gaps drifted by the zoom too. At 100% nothing moves, which is why it went unseen.

## Fix

Rules in `gui/frontend/src/index.css`, after the Radix popper rule, that restate each of
sonner's rules that consumes a measured length, with that length divided by `--cf-zoom`:

- expanded: `height: calc(var(--initial-height) / var(--cf-zoom))`, and
  `--y: translateY(calc(var(--lift) * var(--cf-toast-offset)))` (not on a removed card,
  which keeps sonner's exit `--y`);
- collapsed behind the front: `height: calc(var(--front-toast-height) / var(--cf-zoom))`;
- removed, expanded, behind the front: the exit `--y` with `--cf-toast-offset`; the
  leaving card's `::before` height;
- swiping: the drag `transform` with `--cf-toast-swipe-x/y`, and `animation-name` pointing
  at copies of `swipe-out-*` (`toast-zoom-swipe-out-*`) that read them.

`--cf-toast-offset` divides only the measured part of `--offset`:
`--offset / zoom + --toasts-before × --gap × (1 − 1/zoom)`. `--toasts-before` is the
card's index, which is sonner's `heightIndex` except for the 200 ms while a card in front
leaves (sonner drops its height first); the cards behind are moving then anyway.

Every rule is one attribute more specific than sonner's (`[data-sonner-toaster]` in
front), so none needs `!important`, and none depends on whether sonner's injected
`<style>` comes before or after `index.css`.

The keyframes are not named `cf-*` on purpose: the page library copies `index.css`'s
`cf-*` keyframes into pages (`pagelib/theme.ts`).

## Pages (@cf/ui)

Pages that use the same `Toaster` (`components/ui/sonner.tsx` through `@cf/ui`) need
nothing: a page renders in a frame that undoes the app's zoom (`frame-page-zoom.md`), its
document has no CSS zoom and `ui.css` sets `--cf-zoom: 1`, and these rules are not in the
page stylesheet (only `@theme`, the type roles and `cf-*` keyframes are taken from
`index.css`).

## Verified

`e2e/toast-zoom.spec.ts` at 90% and 125%: three toasts (the front one with a long
description and two buttons); at rest every collapsed card is the front's height; hovered,
every card is its natural height (sonner's own measurement), the front card's height and
buttons are where they were at rest, and the gaps are 14 × zoom. In `make drive` also at
100% (unchanged), a 30 px drag at 125% moving the card 30 px, a swipe-out starting where
the card was let go, and dismissing a middle card while hovered keeping 17.5 px gaps.

## Removing it

When the zoom stops being CSS `zoom` on `<html>`: delete the block headed "Toasts under page
zoom" in `index.css` (the rules and the four `toast-zoom-swipe-out-*` keyframes), this note
and its line in `ui-zoom.md`, and the mention in `lib/zoom.ts`. Keep
`e2e/toast-zoom.spec.ts` (drop the zoom from it if zoom goes entirely): it should pass
without the rules once sonner's measurements and the page's lengths are the same unit.
