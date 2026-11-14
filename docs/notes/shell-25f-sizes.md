# Shell 25f: one pane minimum, room for panes, the sidebar's width

The owner tested the `shell` branch at many sizes and decided three changes. Each changed agreed
behaviour, so `shell-model.md` was edited first ("Small windows", the new "Room for panes", the
drag rules, the "+" menu, reopening, placement rule 5, where a thread's tab opens, collapsing,
the sidebar's width), then each was built.

## 1. One minimum for every pane

- Every pane's minimum is 480 x 400 layout px, whatever its tabs are; a pane all of whose tabs
  are terminals has 300 x 220. A terminal with anything else takes 480 x 400. The minimum reads
  every tab of the pane, not the active one, so switching tabs never changes a pane's size.
- One rule on each side: Go's `internal/layout/fit.go` (`PaneMinimum`, `MinimumOf`, `Fits`) and
  the window's `shell/geometry/rects.ts` (`PANE_MINIMUM`, `TERMINAL_MINIMUM`, `paneMinimum`,
  `minimumOf`, `treeFits`). The daemon had no minimums before this: it lays out by proportions
  (`Rects`) and only needed them now, to refuse what does not fit.
- `KeepPx` (rule 5's floor for the rest, `outerFrac`'s) is the pane minimum's width, in Go and
  in `drag/outerFrac.ts`.
- Automatic folding is unchanged (`rails.ts`), only with the new numbers.
- The shared fixtures stay true: `neighbour.json` lays out plainly and did not change;
  `drops.json` was regenerated (see part 2); a new `fits.json` (Go's `TestFitCases`, 60 random
  trees with panes of terminals and collapsed panes, areas around their minimums) holds
  `minimumOf` and `treeFits` to Go's answers (`geometry/fit.test.ts`).
- **The window's minimum** stays 940 x 500. With the sidebar at its new minimum (240) the pane
  area is 676 x 432: one pane at 480 x 400 fits, with a folded column beside it
  (480 + 12 + 36 = 528). Its comment in `gui/windowframe.go` says so now.

## 2. A space holds only as many open panes as fit

### The fit rule

A tree fits a w x h pane area when `MinimumOf(tree) <= (w, h)`: each open pane at its minimum,
each collapsed pane a 36 px rail (both ways), 12 px gaps, summed along each split and the
largest across it. The proportions play no part. A tree of at most one pane always fits (a
space's first pane is never refused). "Fits" is exactly "needs no automatic fold": `foldRails`
then folds only the collapsed panes (checked on every `fits.json` case). The daemon's area is
the viewport the window reported (`LayoutService.SetViewport`, default 1180 x 820 before any);
the window's is the grid's drawn size, the same numbers after the 200 ms debounce.

An action that would add an open pane, or raise a pane's minimum (a tab other than a terminal
joining a pane of terminals), goes ahead only when the tree after it fits.

### The daemon (`internal/layout`)

- `ErrNoRoom` (a failed precondition) with the reason `NoRoom`: "no room for another pane here:
  collapse or close one first". `internal/api` and the commands answer with the reason alone.
- Refused when the result does not fit: `split_pane`; `move_tab` onto a pane's edge or the
  outer edge; `move_tab` into a pane of terminals it raises; `move_pane` onto an edge, the
  outer edge or into another space; `merge_pane` into a pane of terminals it raises;
  `open_thread` on an edge (a sidebar row dropped there) or into a named pane of terminals;
  `add_tab` and `open_surface` into a named pane of terminals (a pane's "+"). A collapsed pane
  takes anything: the op opens it, which is always allowed.
- Placement: rule 5 is tried only when the tree with the new pane fits (`fitsBeside`), else
  rule 6. Rules 2 to 4 leave out a pane of terminals the tab would not fit in (`canTake`).
  `roomBeside` now only sizes the new pane; whether there is room is the fit's question.
- A tab that goes to the focused pane (a thread's own tab, a tab of no thread, a composer, a
  tab moved to another space) goes, when the focused pane is a pane of terminals that cannot
  take it, to the most recently focused open pane that can (by the space's MRU, then layout
  order), and to the focused pane all the same when none can (`hostPane`). Chosen over refusing:
  a sidebar click must open the thread somewhere.
- The remembered set coming back (`restore`): a tab goes back into its old pane only when that
  pane can take it, and a rebuilt pane only when the tree still fits; otherwise it is placed by
  the rules, which already respect the room.
- `reopen_closed`: a pane rebuilt (a pane's entry, or a tab that was its pane's only tab) that
  would not fit open comes back collapsed and keeps the focus (focus may rest on a collapsed
  pane); `Result.Collapsed` says so and `tab.reopen` adds "collapsed: there is no room to open
  it here". A thread's remembered set coming back with it is placed with that pane collapsed.
  A tab whose old pane can no longer take it is placed as it would open now.
- Always allowed, folding copes: `set_collapsed` opening a pane, a drop onto a collapsed pane, a
  window made smaller, a stored layout from before this rule, the first-load import.
- Ops that measure now also include `add_tab`, `split_pane`, `merge_pane`, `new_thread` and
  `open_draft` (`WithArea`), so a CLI call and a window agree. No proto change: the area is set
  by the daemon from the viewport.
- A pane that grows to its minimum (a pane of terminals that took another kind of tab where it
  fits, a mixed pane drawn shorter before) is held at its minimum by the existing drawing; the
  stored proportions are not rewritten.

### The window

- `shell/drag/room.ts`: `dropFits(tree, source, target, area)` replays the daemon's edit
  (`treeAfterDrop`) and asks `treeFits`; a pane's middle or strip is checked only when the drop
  raises a pane of terminals' minimum; a collapsed pane takes anything.
- `targets.ts`: the scene carries the space's tree. An outer edge whose result would not fit is
  no band (the pane under the pointer answers instead); an edge of a pane's body whose split
  would not fit is no zone and its part of the body is the pane's middle, with the middle's
  highlight ("Add to this pane"), per edge (left and right may be gone while top and bottom
  stay); a pane of terminals that the dragged tabs would raise past the room is no target at
  all, neither its strip nor its body nor its rail.
- A pane dropped on a space tab: the tab is not a target when the pane would not fit right of
  that space's focused pane (`paneFitsInSpace`).
- The pane's "+" lists only Terminal (and the running terminals with no tab) in a pane of
  terminals while anything else would not fit there (`paneTakesAnyTab`); the one agreed
  exception to "+ always opens in that pane".
- The mock daemon (`mock/layout.ts`) ports the refusals, `canTake` and `hostPane`, and its
  simplified placement skips a new pane that would not fit (the thread's pane instead), so the
  shared op cases agree and e2e drags and verbs see the daemon's answers.

## 3. The sidebar's width

- Measured in WebKit at 1440 x 900: the traffic-light gutter 80, the app name (17 px semibold
  "Code Foundry") 107.1 px wide from x 92, the bar's 4 px gap and the toggle's 8 px margin, the
  toggle 28 px: its right edge at 239.1. The app name's box is now fixed at 108 px
  (`APP_NAME_WIDTH`), so the toggle's right edge is a constant: `sidebarToggleEnd(zoom)` =
  gutter + 12 + 108 + 12 + 28 = **240** at 100% (`components/window/titleBand.ts`).
- `SIDEBAR_MIN` and `SIDEBAR_DEFAULT` are 240 (were 260 and 260). The browser dev frontend draws
  the same 80 px gutter as the desktop window (the top bar always draws it), so the width is the
  same there; nothing is a separate magic number.
- The gutter keeps 80 screen px at any page zoom, so in layout px the toggle's edge moves with
  the zoom: a sidebar at its minimum follows it (`sidebarWidthAt`: a stored width at or under
  240 draws at the toggle's edge for the zoom; a wider one is kept and never drawn narrower than
  the edge). The resize handle drags from the width as drawn.
- A width stored earlier that is at least 240 is kept, the old default 260 included (the brief's
  rule; nothing tells the old default apart from a chosen 260). A smaller one (from before the
  260 minimum) is raised to 240.
- The rows at 240 (the sidebar's rows run 228 px after its 12 px left gap): titles still take two
  lines, the project line and its status or time fit, the branch line keeps its tag and counts
  right-aligned (checked in WebKit; see the PR's screenshots).

## Tests

- Go: `TestPaneMinimum`, `TestFits`, `TestCanTake`, `TestFitCases` (writes `fits.json`); 24 new
  op cases (refusals, fits, the host pane, rule 5 and 6, a pane of terminals skipped, a reopened
  pane collapsed, a reopened tab placed fresh), eight cases given a larger area where their
  point is not room, and `move_pane-outer-floor-no-room` turned into the refusal
  `move_pane-outer-no-room` (the floor's own rule stays in `TestOuterFrac`); `TestDropCases`
  records the drops the daemon refuses (`refused`); the command tests'
  `TestLayoutVerbsRefuseWithoutRoom` (the reason, nothing changed, a split below fits,
  collapsing makes room) and `TestTabReopenCollapsedWithoutRoom`.
- vitest: `geometry/fit.test.ts` (Go's cases, "fits" equals "nothing folds"),
  `drag/room.test.ts`, `drag/targets.test.ts` (the body at the limit, per edge, the outer band,
  a pane of terminals, a folded and a collapsed rail), `drag/drop.test.ts` (every drop of
  `drops.json`: offered exactly when the daemon takes it), `linkedTabs.test.tsx` (the "+" menu),
  `stores/ui.test.ts` (240, the zoom, the old 260 kept), the mock's shared cases.
- e2e (`shell-sizes.spec.ts`, WebKit, real pointer drags): a tab over a pane's body at the limit
  adds to the pane near its right and bottom edges; in a taller window the bottom edge splits
  and the right edge still adds; a pane of terminals under a thread shows no highlight for a
  thread's tab and takes a terminal's; the sidebar's edge on the toggle's at 100% and zoomed
  out. SHOTS for the PR.
- Existing tests that built layouts below the new minimums or with more panes than now fit were
  given larger areas (or a collapsed pane) where their point is not room; their numbers were
  recomputed, not loosened. The op fuzz checks a new invariant (`checkRoom`): no op takes a space
  that fit to one that does not, except opening a collapsed pane, a reopened pane (it may not fit
  even collapsed: its 36 px), or the focused pane taking a tab when no open pane could; 60 s of
  `FuzzOps` found nothing else.
- e2e helpers: `setPaneSize` and `sizePane` set proportions as before, and when the minimums do
  not allow the width asked in this window (under 480, or more than the others' minimums leave)
  they resize the window instead by a binary search (`windowFor`), first focusing the pane when it
  must be drawn under its minimum (only the focused pane and its thread's are, the others fold);
  `dragGutterBeside` gives the window its size back before it drags. The specs that sized surfaces
  to 280 to 420 px (Pull Requests, plugins, gallery, diff) keep their widths this way.
- Specs changed: `shell-drag`, `shell-collapse`, `shell-rails`, `shell-grid`, `shell-spaces` (a
  pane is not dropped on a space tab without room; then with room), `shell-feedback` (the minimum
  grid is 676, the two panes that never fold share it 1:1), `layout` and `sidebar` (240),
  `file-edit` (a wider window for three panes, a taller one for a split below), `plugin-menu`
  (the demo's row sized narrow first: it opens at 480 now, so its buttons showed), `diff-viewer`:
  the list-on-top cases at 1280x800 and 1024x640 in a stacked split are gone (a stacked pane is
  400 px tall at the least, and at those sizes the column folds beside the focused thread); the
  shortest stacked pane now met, 410 px at 1280x900, keeps the case.
- `file-edit.spec.ts` "at 175% the caret sits on its text": the narrower sidebar at 175% (206
  layout px, the toggle's edge) widened the panes, and at some pane widths the caret lands 1 px
  off on a wrapped row (2305 and 2350 wide windows pass, 2450 and 2500 fail). The spec keeps its
  old grid (2305, what 2400 was with the 260 sidebar); the caret issue is the editor's, left for a
  separate look. (It was the test's ruler, not the editor: `shell-25h-caret.md`.)
- Full e2e run (WebKit, 4 workers): 563 passed, 167 skipped (SHOTS and opt-in), 3 failed: the
  three red on `shell` that #715 fixed; on the tree rebased onto it they pass.

## Gotchas

- `go test -run TestOpCases -update` rewrites every case in its own formatting: the changed
  cases were kept, the rest restored to their text when only the formatting differed.
- The mock's rule 5 first probed by restoring a cloned tree, which detached the thread's pane
  object the fallback then wrote to: probe on a copy of the space instead.
- macOS has no `timeout`; a command wrapped in it fails at once and prints nothing.
