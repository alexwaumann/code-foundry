# Code box scrollbar

A user with a mouse attached saw a code box with sideways scroll cover the text under it.
Only always-visible (classic) scrollbars show it, and only in the system WKWebView:
Playwright's WebKit has overlay scrollbars, so no e2e test here could fail.

## Cause

An `overflow: auto` box that gains a bar grows by the bar, but its parents keep the height
they read before, so the box covers what follows by about the bar's height.

The chain above a thread row is all flex. The behaviour fits WebKit settling such a box's
scrollbars only after the outermost flex layout ends, then laying out that box alone. That is
inferred from these results, not read in WebKit's source:

- `overflow-x: scroll`, where the bar exists before layout, has no overlap.
- Any later layout of the parents heals it.
- It depends on the window. The thread column has a max width: in a narrow window the
  thread's own vertical bar narrows the column, which lays everything out again and hides
  the bug. At 1500px the column is capped, nothing lays out again, and the overlap stays.
  Check wide windows: at 1100px this reproduces nothing.

## Decision

`lib/scrollbarFit.ts`: a ref with one shared ResizeObserver. When a box's bar starts or stops
taking height, it toggles the box's `min-height` (`1px` or nothing), a real style change, so
the next layout reads the true height all the way up, before paint. Overlay scrollbars never
take height, so nothing runs for them.

Tried on a fresh render, all still overlapping:

- Moving the scroller to a wrapper. It looks fixed if the CSS is injected after the first
  render, but on a fresh render the wrapper grows and its parent goes stale instead.
  `.cf-table` already had that shape and overlapped too.
- `overflow: overlay` (an alias of `auto` here) and `contain: strict` on the thread scroller.
- From the first report: `overflow-y: hidden`, a custom scrollbar, `height: fit-content`,
  `display: flow-root`, a wrapper with `overflow: hidden`.

`overflow-x: scroll` works but draws an empty track on boxes that fit, and CSS cannot tell
when a box overflows.

## Audit

| Box | Result | Now |
| --- | --- | --- |
| Code block `pre` (thread, plugin markdown, `.lnote .lbody`) | overlapped | fitted |
| `.cf-table` | overlapped | fitted |
| `.term .out` | overlapped | fitted |
| PR body `table` | overlapped | fitted |
| PR body `pre` | passed only in a narrow panel | fitted |
| `.diff-scroll`, Edit and Read rows | wrap in a thread, no sideways bar | unchanged |

`fitScrollbar` is for a sideways box with an automatic height. Add it to any new one.

## How it was checked

In WKWebView with `-AppleShowScrollBars Always` for that process only, 1500x900, against
`make drive`. Gap to the next element, before and after:

- Code block: -10.5, then 6.5. Table: -7.25, then 9.75. Bash output: -10, then 7.
  PR body table: -10.5, then 6.5.
- A line growing past the edge mid-stream: 6.5.
- A block narrowed and widened again: 52.38, 69.38, 52.38, gap 6.5 throughout.
- A block that fits: no bar, no `min-height`.
- Default scrollbars: heights as before, `min-height` never set.
- Copy did not move after scrolling sideways. The box keeps its border and corners.
- Zoom 90%, 125% and 150%: gaps scale and stay positive.

## Gotchas

- Inject test CSS before the row first renders. Injecting it afterwards relays out the page and
  passes things that fail for real.
- The mock's streaming text ends inside an open fence: start a delta with a closing fence.
