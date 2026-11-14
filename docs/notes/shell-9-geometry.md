# Shell PR 9: geometry (rectangles with minimums, rails, tab fitting, neighbours)

Ninth PR of the shell stack (`docs/notes/shell-plan.md`, section 4). It adds the pure functions
the pane grid draws with, under `gui/frontend/src/shell/geometry/`. No component, no store and
nothing wired: PR 10 maps the daemon's layout onto these types, PR 11 draws with them, PR 19 turns
the rails on.

## What is in it

| File | Holds |
| --- | --- |
| `types.ts` | `GeoNode` (`GeoPane`, `GeoSplit`), `GeoTab`, `Rect`, `PaneRect`, `GutterRect`, `Frame`; `panesOf`, `activeTab` |
| `rects.ts` | `plainRects` (the daemon's `Rects`), `frameRects` (minimums and rails), `minimumOf`, `paneMinimum` and its table, `tilingErrors` |
| `rails.ts` | `unfoldable`, `foldOrder`, `foldRails`, `shellFrame` (rails then rectangles) |
| `tabFit.ts` | `fitTabs`: each tab's drawn width and whether its label is whole, short or an icon |
| `neighbours.ts` | `neighbour(frame, pane, dir)` and `neighbours` for `left`, `down`, `up`, `right` |
| `src/test/shellTrees.ts` | tree builders, a seeded generator and random trees for the tests |

## Decisions

- **Types follow PR 1's JSON.** A pane is `{t: "pane", id, tabs?, active?}`, a split
  `{t: "split", id, dir, kids, sizes}`, a tab `{id, kind, thread?}`. A node of the daemon's
  layout (or of `internal/layout/testdata/rects.json`) is one as it stands; `tabs` is optional
  because the rect fixtures have none.
- **Two layouts.** `plainRects` is the toy's `lay` with `plain` set and equals Go's `Rects` to the
  px (the shared fixture proves it): proportions alone, what placement measures. `frameRects` is
  what the window draws. Both round edges with `Math.round` and run the last kid to the far edge.
- **Minimums by the active tab's kind** (the toy's `paneMin`, a table, not a switch): thread and
  compose 360x220, terminal 240x110, diff, file and pull request 260x150, anything else 300x160.
  The compose tab takes the thread's because it becomes the thread's tab. A caller can pass its
  own `MinimumOf`.
- **Holding minimums.** In each split, while the open kids' minimums fit, a kid whose share falls
  short is held at its minimum and the rest share again (the toy's loop). When they do not fit,
  the open kids share by their sizes alone; the rails then decide what folds.
- **Rails.** A rail is 36px thick: a kid that is all rails takes its minimum along the split. One
  change from the toy: when every kid of a split is all rails, the toy dropped the minimums and
  shared by sizes, so a row of two rails could be 50px and 22px wide. Here they share like open
  kids with their rail minimums, so a row of rails squeezed to its minimum is 36px each. A gutter
  beside an all-rails kid is `fixed` (not a resize handle).
- **Fold order** (spec, "Small windows"): panes without a thread tab, then panes with one; within
  each the least recently focused first. A pane is as recent as its most recently focused tab in
  the space's `mru`; a pane none of whose tabs is in `mru` is older than any that is. Among equals
  the later pane in layout order folds first, so a full row folds from the right. The focused pane
  never folds, nor the pane holding the `thread` tab of the focused tab's thread (the active tab's
  `thread`, which is the thread itself for a thread tab and the link for a linked surface).
- **Folding** is the toy's greedy loop: fold the next pane, keep it only when it shrinks a
  dimension that overflows. Added: once the tree fits, the folded panes are tried again in
  reverse order and each that still fits unfolds, so a fold that a later, larger one made
  unnecessary is undone (the result is minimal: no single rail can unfold and still fit). When
  nothing more can fold and the tree still does not fit, the unfoldable panes stay open and share
  by their sizes.
- **Rails are derived, never stored.** `foldRails` reads the tree and the area only; the tests run
  it on deep-frozen trees. Computing again on a larger area is how rails unfold.
- **Tab fitting** (the toy's `fitTabs`, made pure: the strip measures, this decides): icon-only
  goes farthest from the active tab first (the later of two as far), the active tab last; the
  active tab keeps its whole label when the others can still have their least width (84px, or a
  narrower tab's own width); the other labelled tabs share the rest by water-filling, so the
  longest labels shorten first, to whole px. A `short` or `icon` label is the one that gets a
  tooltip (`Tip whenTruncated`). When even all icons overflow, all are icons and the strip scrolls.
- **Neighbours** are on the drawn frame, rails included (a key can reach a folded pane, and
  focusing it unfolds it). A neighbour lies wholly on that side and shares some edge; nearest
  first, then the longest shared edge, then the upper (left and right) or the left (up and down),
  then id. On the plain frame this is the first of Go's `SideNeighbours` list for every fixture.
  The toy scored `gap * 1e4 - overlap`; the order is the same with an explicit tie-break.
- **`tilingErrors`** is exported, not test-only: PR 11 and PR 19 can run it as the toy's tiling
  self-check.

## Verification

- `make check` green.
- vitest, 75 tests: every case of `internal/layout/testdata/rects.json` (rectangles, gutters, and
  the first neighbour per side) read from the repo through `?raw` (`vite.config.ts` allows
  `internal/layout/testdata`); tables for minimums (held, already fitting, not fitting, columns,
  rails in rows and columns, columns and rows of rails, fixed gutters); the fold order and both
  never-fold rules; folding by width and by height, keeping only folds that help, unfolding a fold
  made unnecessary, unfolding when the area grows, the stored tree untouched; tab fitting cases and
  500 random strips; neighbours in all four directions, edges, ties, the nearest, and across rails.
- Every frame a test makes is checked to tile its area exactly, including 400 random trees
  (plain, held at minimums, and with rails) and 300 random small-window trees with rails.
- No end-to-end step: nothing draws these yet (PR 11).

## Gotchas

- A split shorter than its gutters cannot tile, here as in Go (a kid gets a negative size). The
  random tests give every split room for its gutters at its proportions; the window's own minimum
  size keeps real layouts out of that range.
- A pane held exactly at its minimum keeps it to the px when the minimums are whole numbers, but a
  pane on a proportional share just above its minimum may lose the rounding pixel.
- oxlint's type-aware rules refuse a number in a template literal: `String(n)`.

## For later PRs

- **PR 10**: map the layout slice's panes and tabs onto `GeoNode`; `mru` and `focus` come from the
  space.
- **PR 11**: draw `shellFrame` with rails off (an empty set) until PR 19; measure the strip and
  hand `fitTabs` the natural widths and the room left after the "+" button.
- **PR 4/11**: `ctrl+cmd+h/j/k/l` focus `neighbour(frame, focus, dir)` on the drawn frame; moving
  by direction is `swap_pane` with the same neighbour.
- **PR 19**: `shellFrame` per frame; a click on a rail focuses it, which unfolds it.
