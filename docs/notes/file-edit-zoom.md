# The File tab's editor under page zoom

Bug (reported by a user): in the File tab's edit mode the selection and the caret were drawn
off the text on some lines. It showed at any page zoom other than 100% (`appearance.zoom`,
CSS `zoom` on `<html>`, `ui-zoom.md`), on lines with emoji, ZWJ sequences, variation
selectors or combining marks. The error grew with the text before the caret, and stayed
after the zoom went back to 100%.

## Mechanism (probe-verified in WebKit, `make drive`)

`@pierre/diffs`' editor draws its own caret and selection rectangles in layout px, from
measured text widths (`dist/editor/textMeasure.js`, `Metrics`). ASCII, tabs, CJK, accents
and arrows go through canvas `measureText` (layout px). Text with a surrogate pair, U+200D,
U+FE0E/FE0F or a combining mark goes through `domMeasureTextWidth`, which reads
`getBoundingClientRect().width`: viewport px, the layout width times the zoom. So at 125%
those widths came out 25% too wide. They are memoized by text + font, not zoom, so after a
zoom change a width measured at the old zoom was reused.

The memo also has to be per zoom for another reason: an emoji's *layout* width is not the
same at every zoom (😀 is 17.78 layout px at 90%, 17.00 at 100%, 16.80 at 125%; a line of
26 of them differs by 25 px between 90% and 125%), so a correct width at one zoom is a wrong
one at another.

Measured on `const emoji = "😀 smile 👨‍👩‍👧 family after";` at 125%: the select-all
rectangle ended 102 px past the text (9 px at 100%), a click before the second `"` put the caret 87 px right of
it; the e2e test measures 80.5 px without the fix.

## Fix: a `bun patch` of the library

`gui/frontend/patches/@pierre__diffs@1.5.2.patch`, like the Wails runtime's zoom patch
(`ui-zoom.md`). Our side cannot reach it: `Metrics` and the editor's caches are private and
not exported, the editor has no public "re-measure" call, and undoing the zoom on the
editor's host (the terminal's trick) would change how every line renders next to the
read-only view. 1.6.4, the newest release, still reads `getBoundingClientRect()` there.

* `getLayoutZoom(el)`: `el.currentCSSZoom`, or 1 without it (engines from before zoom was
  standardized, whose rects are already layout px). `currentCSSZoom` is a style read, so a
  memo hit costs no reflow.
* `domMeasureTextWidth` divides by it and keys its memo by it.
* The editor notices a zoom change (`#syncLayoutZoom`, from `#updateSelections` and its
  resize handler) and drops its wrap points, row tops and gutter/content widths. Nothing it
  observed resized on a zoom change when the panel keeps its layout width (a wide window),
  so it also observes `<html>`, whose box in its own px does change; then the overlay
  redraws on the zoom change with no click. Without this half, in a 2400 px window, carets
  on the rows of a wrapped emoji line were 15 to 44 px off after 125% → 90%. The e2e test
  does not catch this half: its panel's layout width moves by 1 px between zooms, which
  clears those caches anyway.
* A second bug, no emoji needed: the Safari wrap-start check in `#wrapLineText` compares
  `left - (divRect.left + ch)` (viewport px, so `(zoom - 1) * ch` at a true row start) with
  `ch / 2`. From 175% every row start counts as "past the line start" and the wrap point
  moves back one grapheme, so on every wrapped row of a plain ASCII line the caret was one
  character right (12.3 px at 175%, 15.2 px at 200%). Now in layout px; the second e2e test
  fails without it.
* The alt-drag column count (pointer `clientX` delta over `ch`), fixed the same way.
  Alt-drag over 10 columns at 125% now selects 10 columns (checked at 100, 125 and 200%;
  before, by the arithmetic, 12 or 13: the unpatched drag was not driven).
* The gutter width was `offsetWidth`, rounded to whole px, while the text starts at the
  gutter's fractional width (30.78 at 100%, 30.4 at 125%): every caret was 0.2–0.5 layout px
  off. It now reads the rect divided by the zoom.

The patch is pinned to 1.5.2: an upgrade fails install until it is re-applied or upstream
has the fix.

## Checked and fine

Caret clicked before 85–92 graphemes per zoom (90, 100, 110, 125, 150, 175, 200%), wrap and
no-wrap, on emoji, ZWJ family, ❤️/✔️ with VS16, ☺︎ with VS15, combining accents, a tab before
an emoji, CJK, Nerd Font private-use glyphs (U+E0A0, U+F113, U+F0219) and a 26-emoji line:
every caret at the library's spot (boundary − 1 layout px, a 2 px caret centred) within
0.2 layout px. The probe's first line is an italic comment: same advance as the canvas
`ch`. No theme here draws bold tokens, so bold was not seen. The font is measured with the canvas attached since 1.5.2 and
re-measured on `document.fonts.ready`, so load order did not show. Very long lines
measure per wrap segment. In a 420-line file (the virtualized path), carets line up
wherever rows are rendered. Search matches, bracket matches and selections use the same
`#getCharX` as the caret. Popovers (markers, selection actions, edit predictions) and the
ghost-text row count also mix units; they are left unpatched, and the File tab uses none of
them.

## The virtualizer under zoom (files over 400 lines)

Bug (reported by a user): a long file went blank near the end at any zoom but 100%. Worse
than first seen, measured in WebKit on a 1200-line file scrolled to the end (rows rendered
against the scroller): at 90% three rows of 57 on screen, at 110% and up none, read-only or
editing, wrap or not; mid-file at 125–200% blank too. The Diff tab (CodeScroll) the same; the
PR code tab (CodeView) only in wrap mode (blank strips of 60–400 px at 110–200%).

Mechanism, confirmed by measuring before patching: in WebKit `scrollTop`, `scrollHeight`,
`clientHeight` and `offsetHeight` are layout px; rects are viewport px (layout × zoom). The
library mixed them:

* `Virtualizer.getRelativeBoundingTop` (a rect distance) is added to `scrollTop` to place a
  file in the scroller (`getOffsetInScrollContainer`, the file's `top`) and in `scrollFix`.
  Scrolled by S, the file's top came out S·(1 − zoom) off: +2300 px at 90% at the end of the
  file, −5800 px at 125%. The render window (scrollTop ± 1000) then missed the rows.
* `getHeight` (Virtualizer and CodeView) took the scroller's rect height as its height, and
  CodeView its header/footer.
* In wrap mode (and with annotations) `reconcileHeights` (VirtualizedFile,
  VirtualizedFileDiff) stored each rendered row's rect height: 23.75 for a 19 px row at
  125%, so the computed content height, the scrollbar, and where every later row was
  thought to be grew with the zoom.

Fix, in the same patch file, one helper module (`dist/utils/getLayoutZoom.js`; the
editor's `getLayoutZoom` moved there and `textMeasure.js` re-exports it):

* `getRelativeBoundingTop` divides by the scroll container's zoom; `getHeight`, scrollFix's
  file height and CodeView's header/footer read `getLayoutHeight` (rect over zoom).
* Row heights read `getLayoutRowHeight`: rect over zoom, rounded to a whole px when the
  zoom is not 1. The browser snaps zoomed heights to its 1/64 px grid, so 19 px rows measure
  18.99 at 90%; unrounded, every row would count as resized. At 100% the rect is used as is.
* The simple Virtualizer sets `overflow-anchor: none` on its scroller, as CodeView already
  does: it anchors with `scrollFix`, and WebKit's own anchoring then moved it again on a zoom
  change in edit mode (14700 → 15122 px at 100% → 125%, 23 lines; 740 → 875 after a cycle
  of zooms). No script scrolled: a setter trap on `scrollTop` saw nothing.

Ours: `CodeBody`'s scroll to a line (a File tab opened at a line) added a rect distance to
`scrollTop` too; at 200% line 900 landed 1.87 screens above the view. It divides by the
zoom now. Find in file (`useFileFind.ts`) already did.

Checked (WebKit, mock): at 90, 110, 125, 150 and 200%, read-only and edit, wrap and no-wrap,
File tab, Diff tab and PR code tab: no blank strip mid-file or at the end, the last line on
screen at the end (under it at most the file's bottom padding, as at 100%), the scroll
height within 100 px of 100%'s (23,836) in no-wrap; a File tab opened at line 900 puts
it a third down; a zoom cycle (90 → 125 → 200 → 110 → 150 → 100) keeps the first line
within one; find in file steps to all 12 matches of a 600-line file, both ways, at 90, 125
and 200%, view and edit. 100% unchanged (same rows rendered, same scroll positions).

`e2e/file-zoom-scroll.spec.ts`: the end at 90/125%, wrap and not; edit mode at 125% plus the
zoom-change jump; line 900 at 200%. Each of the three parts of the fix fails its own test
when taken out. The file is 1200 short lines: the error grows with the scroll (0.1 × S at 90%),
and at 600 lines it would be about the render window's 1000 px margin, too close to fail. The mock writes files from a URL,
so spaces go as `+` to stay under Node's 16 KB header limit.

Not patched: `window` scrolling (a Document root: `window.scrollY` under a zoomed `<html>`
was not measured, and the app never uses it) and the annotation height sync
(`ResizeManager`, `lineAnnotations.js`), unused here.

## Not fixed here

* **A click at the start of a wrapped row** puts the caret at the end of the row above (the
  library resolves the shared offset to the earlier row). At 100% too; a library choice,
  not zoom.
* **The real Wails window.** WebKit through Playwright only; WKWebView should behave the
  same (`currentCSSZoom` is in both).
