# Project page polish (PR A of three)

Scope: the project page's title meta, Checkouts table, Worktrees without threads and Details,
the `whenTruncated` check in `components/ui/tooltip.tsx`, and the tooltip rule in CLAUDE.md
("never a tooltip that repeats what is on screen"). PR B is the workspace page; PR C the
thread crumb links.

## The tooltip misfire: the page zoom, not the text

The title meta and the Details values already used `Tip whenTruncated`, yet a user saw their
tooltips on text that fits. Reproduced in the live Wails app (isolated `CODE_FOUNDRY_HOME`, a
build that printed each trigger's metrics into its tooltip): at 100% every value read
`scrollWidth == clientWidth` and `scrollHeight == clientHeight`; at `appearance.zoom = 110`
every one read a pixel over both ways (Remote: `scrollWidth 436 / clientWidth 435`,
`scrollHeight 19 / clientHeight 18` on an 18px line, a 478.88 x 19.80 px box). The page zoom
is CSS `zoom` on `<html>` (lib/zoom.ts), and WebKit rounds `scroll*` and `client*` back to
CSS px separately, so they can land a pixel apart. Headless WebKit does the same at 110% and
125% (90% reads a pixel under, so it never misfired); the earlier mock check ran at 100%.
Not the cause: font ascent/descent (the line box is exactly the line-height at 100%),
fractional widths at 100% (both round the same way), density, the terminal font.

Fix in `truncated()`: an element counts only when it clips (computed `overflow-x`/`-y` not
`visible`: truncate, line-clamp, sr-only) and its content is wider or taller than its box by
more than one pixel. A cut under a pixel goes without its tooltip; a clamped line or an
ellipsis is far more. Unit-tested in tooltip.test.tsx (the 110% numbers, a real cut, a clamp,
an unclipped overflow); e2e projects.spec.ts hovers the title meta and every Details value at
110% and asserts the pixel trap is present and no tooltip opens.

## Tables

- `NavRow passive` now means "no click", and the row still tints on hover (only these two
  tables used it), so the pointer finds the row whose right-click menu holds its actions.
- Branch path tooltips are gone from both tables (the branch is on screen; the path is in the
  row's menu as Copy path / Open in Finder).
- Sync is `lib/projects.ts syncState`: up to date (success, Check), N to push (info, ArrowUp),
  N behind (warning, ArrowDown), not pushed (muted, no icon), and ahead and behind at once
  "diverged ↑2 ↓1" (warning, lucide `Split`; both counts visible, no tooltip). `syncCell`
  (the plain string) stays for the workspace page's member sentence. The colours and icons are
  one record (`SYNC_LOOK` in CheckoutsTable.tsx), easy to change.
- Worktrees without threads: one column set for the header and every row through CSS subgrid
  (`minmax(min(6rem,25%),max-content) minmax(min(10rem,35%),1fr) 3.25rem`). Every level between the table and the
  cells is a subgrid, including RowContextMenu's trigger wrapper (new optional `className`).
  The branch is as wide as the longest branch; Why it stayed takes the rest and truncates (its
  tooltip only when cut); only a table narrower than the longest branch plus 10rem cuts the
  branch. The two floors are shares of the table below about 23rem (25%, 35%): with plain
  6rem + 10rem the header overflowed the narrowest pane (live, 150% zoom in a 760px window).
  The section hint is gone.

## Gotchas

- A subgrid chain breaks silently at any plain wrapper: the rows then lay out alone and the
  columns go wrong without an error. The e2e test checks every Why it stayed starts at the
  header's x.
- The isolated live app shares WebKit localStorage with the real one, but zoom and density are
  daemon settings (`appearance.*`), so changing them in the isolated home is safe.
