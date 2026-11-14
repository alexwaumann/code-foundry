# Shell 25h: the caret "1 px off" at 175%, and a dropped click after a resize

`file-edit.spec.ts` "at 175% the caret sits on its text on every row of a wrapped ASCII line"
failed at some window widths (2450, 2500) and passed at others (2305, 2350); shell 25f pinned it
to 2305. The editor places the caret correctly at every width and zoom. The test measured the
text with a `Range`, and WebKit rounds a Range's rect. Making the test cover many widths then
exposed a real editor bug, fixed here: a click just after a pane resize was dropped.

## Measured (WebKit through Playwright, mock daemon, DPR 2)

- **Where the editor puts the caret.** `@pierre/diffs` sets the caret's `translateX` to
  `gutter + ch + col * ch - 1` layout px (ch 7.2 from canvas `measureText`, the gutter's
  fractional width from the zoom patch, `file-edit-zoom.md`). The caret's rect is exactly that
  times the zoom: 0.000 px of snapping at 175%.
- **Where the text is laid out.** Each grapheme wrapped in a `<span>` in a copy of the row
  (beside the row, removed in the same task). Its left was within 0.013 viewport px of the
  editor's arithmetic on every grapheme of every row, at 100, 125, 150, 175 and 200%, at window
  widths 2305, 2450 and 2500. The wrap points agree too: the editor's hidden measuring div and
  the real row broke at the same graphemes at all 80 widths tried (2305 to 2500 by 5, at 150
  and 175%).
- **Where the text is painted.** A device-pixel screenshot of a row of `█ ` blocks: every
  block's left edge (from its antialiased coverage) within 0.44 viewport px of the arithmetic
  at 175% and 0.23 at 100%, under one device pixel (0.5 px), on wrapped and unwrapped rows.
- **What the test read.** `Range.getBoundingClientRect()` over one grapheme. Inside a text run
  WebKit floors its left to a whole px of the zoomed text (an exact whole number comes back
  one lower), relative to the run's start. With an advance of 12.6 viewport px (7.2 × 1.75)
  the error cycles with the column: 0.6, 0.2, 0.8, 0.4, 1.0 px. It is 0 at a token's first
  grapheme (a new text box), and 0 at 125% (9 px advance, a whole number). At 100% (7.2 px) it
  also reaches 1.0. The test rounded the distance to 0.1 and asked for less than 1, so a
  grapheme in a column ≡ 4 (mod 5) of its row failed. The window width moved the wrap points,
  so the same grapheme fell on such a column at some widths and not at others: at 175%,
  grapheme 291 is column 17 of its row at 2305 (0.8, passes) and column 34 at 2450 (1.0, fails).
  Before: 175% failed at 2400, 2450 and 2500; 150% at 2500; 100% and 200% at 1800.

## Fix for the pixel: the test's ruler, not the editor

- `glyph()` measures a span around the grapheme in a copy of the row, not a Range over the
  row's own text. The copy keeps the row's attributes and ancestors, so it wraps and lays out
  the same, and it is removed before the task ends, so the editor never sees it.
- The test runs at 150% and 175%, over window widths 2305, 2350, 2400, 2425, 2450, 2475 and
  2500, on four graphemes from the first row to the last, and asks for less than 0.1 px (it
  asked for less than 1). It catches a real sub-pixel error: with the gutter's width read from
  `offsetWidth` again (rounded, the zoom patch's earlier bug) it fails at 0.3 px. Run once at
  100, 125, 150, 175 and 200%: all pass.
- The emoji test shares `glyph()`; it passes unchanged.

## Found on the way, fixed: a click just after a resize was dropped

With the ruler fixed, the new test failed now and then (about one run in two, always the first
click after a width change): the caret stayed where the previous click put it, 648 px off.
Traced in the page (ResizeObserver callbacks, pointer events, `selectionchange`, mutations):

- When its content resizes, the editor's ResizeObserver handler (`#handleLayoutResize`)
  re-applies the selection it holds: `#updateSelections(this.#selections)`, then `focus()`.
- `#focus(position)` sets the DOM selection and `#shouldIgnoreSelectionChange = true`, and
  clears that flag two `queueRender` frames later.
- The editor reads a click's caret from `selectionchange`, which it skips while that flag is
  set. A click in those two frames moved the DOM selection (the trace shows the
  `selectionchange` with the clicked offset, 38 ms after the resize) and the editor ignored it.

Not a test artefact: any pane resize (window, divider, sidebar, zoom) followed by a click within
two frames dropped the click. Fix, in `patches/@pierre__diffs@1.5.2.patch`: a mouse
`pointerdown` on the content clears the flag (not during IME composition, which sets it too).
The library already clears it at the end of every mouse gesture (`#resetSelectionGesture`); a
press is the person's own selection gesture, so the editor's re-apply no longer outranks it.
Probe: 2 failures in 10 runs before, 0 in 16 after; also 0 in 16 with the test's wait removed.

One ordering is still the library's: a click in the same frame as the resize, landing before
the editor's ResizeObserver callback while the click's `selectionchange` is still queued. The
handler then puts the old selection back before the editor reads it. The test does not race
this: `editorSawResize` waits for a ResizeObserver made after the editor's, and observers are
called in the order they were made, so the editor has handled the resize first. That waits for
the thing it raced, not for a time.
