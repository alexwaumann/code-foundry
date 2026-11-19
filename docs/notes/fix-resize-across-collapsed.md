# Resizing across collapsed panes

A user with `[A][collapsed][B]` could not resize A against B at all: every gutter touching a
rail was `fixed` (inert, `not-allowed`, no handle, no keyboard), so the only way to move the
edge was to open the collapsed pane, drag, and collapse it again.

## The rule

A run of rails between two open kids of a split acts as one divider.

- `gutterPair(open, i)` (`shell/geometry/rects.ts`): for the gutter after kid `i`, `a` is the
  nearest kid at or before `i` that is not all rails and `b` the nearest at or after `i + 1`.
  Null when either side has none: that gutter is `fixed`, as before. So a collapsed pane (or a
  run of them) at the edge of its split is unchanged.
- Every gutter in the run (beside a rail, or between two rails) pairs the same `a` and `b`, so
  each drags the same edge. The rail body is not a handle: a click still opens its pane and its
  icons still drag tabs.
- `GutterDrag` carries `a` and `b` beside the gutter's own `i` (`i` still names the gutter for the
  cursor during a drag). `startDrag` takes `lens` and `mins` from the pair; `dragSizes` trades
  `sizes[a]` and `sizes[b]` and keeps every other size. Keys (arrows, Home/End), the double click
  (`evenSizes`) and the cursor's reach (`gutterReach`) all go through the drag, so they follow the
  pair without changes of their own.
- Why the rails ride along: a kid that is all rails is drawn at its fixed rail length, and the open
  kids share what is left by their sizes. With `sizes[a] + sizes[b]` unchanged, A and B together
  keep their length, so moving room between them moves the rails between them by the same amount.
- The rails' stored sizes are untouched, so a collapsed pane opened again takes its stored share
  of what the open panes share (held at its minimum when that share is less, as any open pane).
  Checked in the driven app: 0.4/0.2/0.4 dragged to 0.26/0.2/0.54 at 1548 px, then opened, gave
  480/480/552 (the first pane and the opened one at their minimums).
- A nested split of the other direction whose panes are all rails is one all-rail kid of its
  parent, so it is part of the run. A same-direction nested split does not exist (the daemon
  splices it), so a run is always siblings of one split.

## Auto-folded rails

`rails.ts` folds panes by the minimums and the focus order, never by sizes, so a pane the window
folded is an all-rail kid like a collapsed one and gets the same pairing: with a folded pane
between two open ones both gutters drag the open pair. Dragging never changes what folds (each
open kid stays at or above its minimum). When the window grows and the folded pane opens again,
it takes its stored share, as a collapsed pane does. A pane folded at the split's edge leaves its
gutter fixed, as before.

## Daemon

No change. `pane.resize` → `SetSizes` (`internal/layout/ops_tree.go`) checks only that there is
one size per kid and that each is positive (then scales them to sum to 1). The pair's sizes stay
positive: each is at least its minimum's share.

## Tests

- `shell/geometry/rects.test.ts`: `gutterPair` table (open/rail patterns), and which gutters are
  fixed in a frame, a column of rails inside a row included.
- `shell/resize.test.ts`: a drag from each gutter of a run (one rail, two rails, a column, a
  column of rails in a row) gives the same sizes, keeps the rails' sizes, moves the rails with the
  edge; minimums and Home/End; double click; reopening after a drag; no drag at the edge; a pane
  the window folded.
- `components/shell/PaneGrid.collapse.test.tsx`: both gutters beside a middle collapsed pane are
  draggable separators and an arrow key on either sends `pane.resize` with the rail's size kept; a
  collapsed pane at the edge keeps its fixed gutter.
- `e2e/shell-collapse.spec.ts`: one real pointer drag on the gutter between two collapsed panes.
  The part of the old test that dragged a fixed gutter beside a middle collapsed pane is gone (that
  gutter now moves).
