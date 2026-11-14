# Shell 25b: audits of the direction keys, the drop highlight and full screen's Escape

The owner tested the `shell` branch and reported three problems: the pane focus and move keys
"sometimes skip, or cannot go left", the drop highlight is "sometimes a little off, especially
with rails", and full screen entered from a rail does not leave on Escape. Each was reproduced
before it was fixed; the tests below fail on the code before this PR.

## 1. Direction keys (ctrl+cmd+h/j/k/l, arrows; with shift, move)

A property test over random trees laid out as drawn (minimums, rails folded for focus and mru,
the frame drawn again after each key) found that the neighbour function itself never misses a
pane on a side and never skips one: on a tiling the nearest pane on a side always touches it.
The chords reach the keymap from every surface (prompt, terminal, diff, file, pages), checked in
WebKit. The causes were elsewhere:

- **The rule did not come back.** Of several panes touching a side, the GUI took the one sharing
  the longest stretch of edge, while the command's own description and the daemon's `Neighbour`
  say "the one focused last". From a short pane, h then l went to the taller pane beside the
  start, not back to it; in random walks most round trips went elsewhere. Fix: `neighbour(frame, pane, dir, {root, mru})` ranks the touching panes by
  recency (a pane is as recent as its most recently focused tab), then the longest shared edge,
  then the upper (left/right) or the left (up/down), then id. The daemon's `Layout.Neighbour`
  breaks ties the same way now (it broke them by id). `internal/layout/testdata/neighbour.json`
  (Go's `TestNeighbourCases`, 30 random trees with an mru) holds the two to the same answer for
  every pane and side.
- **The MRU does not always hold the pane a key left.** The daemon sets the focus without a
  touch in a few places (a closed pane hands the focus to its neighbour, `finish`'s fallback, a
  thread moved to another space), so the focused pane's tab may be missing from the MRU, and
  going back fell to the longest edge again. Making the daemon touch the focused tab after every
  op changed 61 op fixtures, too wide for this; instead the key presenter remembers the pane the
  last focus key left and counts it as the most recent while the MRU's head is still what that
  key left (a click elsewhere and back forgets it).
- **A stale frame.** The key read the frame the grid last drew, which lags a focus applied at
  once by a render; with rails the focus decides what folds, so a quick second key went from the
  old frame and could land elsewhere. The key now lays out the current layout itself
  (`shellFrame` of the store's tree for the current focus and mru, at the drawn size).
- **Moves are not optimistic.** A second move key before the daemon answered found the same
  neighbour in the old tree and swapped the pane back. A direction key now waits for a move on
  its way (at most `MOVE_HOLD_MS`, 3s, so a daemon that never answers cannot stop the keys).
  The mock answers between Playwright's key presses, so this is vitest's, not e2e's.

Rule written into the spec ("Keys"). Going back returns to the start whenever the start still
touches the pane reached; with rails a move can refold the panes so that it does not (focusing a
thread's linked terminal keeps the thread's pane open and another folds), and then the key goes
to what touches now, never past it.

## 2. Drop highlight

Go's `TestDropCases` writes `internal/layout/testdata/drops.json`: 18 random spaces (2 to 7 panes,
every tab kind, a focus and mru, areas from roomy to small enough to fold), 6 drags each (a tab, a
pane or a sidebar thread onto a pane's middle, an edge or the outer edge; drops the GUI refuses
left out), each with the space the daemon's real op leaves. The vitest compares the preview, laid
out as the drag layer lays it (`shellDropLayout`, moved out of `ShellDnd`), with the rectangle of
the result's pane in `shellFrame` of the daemon's result. Every edge and outer drop matched,
rails included. The misses:

- **A pane's middle (and a rail, which is one target as a whole) previewed the pane as it is
  now.** After the drop the pane's active tab is the dropped one (its kind's minimum), it takes
  the focus (a rail opens, another pane may fold), and a pane the drop empties leaves the tree,
  so the rest shifts. On a rail the highlight was the 36px rail; the pane landed hundreds of px
  wide. Fix: `treeAfterDrop` replays a middle drop too (a tab appended and active, a pane merged
  with its active tab active, a sidebar thread opened there) and `dropPreview` lays it out like
  the others.
- **The tab left active in the old pane** was the first, where the daemon's `detach` takes the
  one after the moved tab (or the last). It decides the old pane's minimum, so a rect beside it
  could be off. Fixed to match.

Not previewable: a sidebar thread's remembered linked tabs, which `thread.open` restores after
placing it, may add panes the preview does not know of.

## 3. Full screen from a rail, then Escape

The rail's full-screen button focuses the pane first, which moves the keyboard into its active
tab: a thread's or a composer's prompt, or a terminal. ProseMirror marks every Escape (and Enter)
handled in its own key handling (`captureKeyDown`), so the window's bubbling Escape listener saw
it `defaultPrevented` and full screen stayed. Not specific to the rail: cmd+shift+enter typed in a
prompt, then Escape, stayed too. The strip's button only looked fine because the keyboard was
usually elsewhere. Fix: a capture listener on the window takes a bare Escape typed in a prompt
before the editor (`promptEscapeLeaves`) unless the prompt has a use for it: a completion or
history card open (the editor's `aria-controls`), dictation running, or the floating composer's
prompt (which collapses first, as it already did in capture). An empty composer's Escape back to
its project's page waits until full screen is off (written into the spec). A terminal keeps
Escape for its shell, as agreed; cmd+shift+enter leaves from there (checked).

## Tests

- Go: `TestNeighbourTies`, `TestNeighbourCases`, `TestDropCases` (both fixtures regenerate with
  `-update`).
- vitest: `shell/geometry/neighbours.test.ts` (recency, the shared fixture, properties over 400
  random walks: reached when a pane is there, touches, comes back when the start touches, rails
  reached and drawn open once focused); `shell/keyPresenters.test.ts` (rule, a focus the MRU lacks,
  a stale frame, queued moves, the hold limit); `shell/drag/drop.test.ts` (every drop of the shared
  fixture, the middle of a rail, detach's active tab); `shell/fullscreen.test.ts`
  (`promptEscapeLeaves`).
- e2e (WebKit): `shell-grid.spec.ts` "ctrl+cmd+l goes back to the pane ctrl+cmd+h came from";
  `shell-rails.spec.ts` the rail drop compares the highlight's box with the pane it lands as;
  `shell-fullscreen.spec.ts` full screen from a rail and Escape in the prompt.

## Gotchas

- `focusPane`'s optimistic focus is dropped once the confirmed layout's rev reaches the rev its
  runner returned: a test that seeds a layout at rev 2 must not have the focus answer rev 2.
- Module state in a presenter (the remembered pane, the move queue) needs a reset for tests
  (`resetKeyPresenters`).
