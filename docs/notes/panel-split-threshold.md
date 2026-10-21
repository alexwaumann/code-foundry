# Side panel split: stack longer, side by side from 721px

Agreed with Alex on 2026-10-21, after the split shipped (#277, #278, #279). Two problems:
a split panel went side by side too early (585px: two 280px groups are too narrow to
read a diff or a thread list in), and an expanded split panel was forced side by side
whatever its width, which in a narrow window pushed the second group past the panel's
right edge (each group keeps its 280px CSS minimum, so two of them did not fit).

## The rule

* `PANEL_GROUP_SIDE_MIN = 360` (`stores/ui.ts`): a group side by side is only worth
  reading at `CONTENT_MIN`, the least the content pane ever gets. A separate constant,
  not `CONTENT_MIN` itself, so the two can move apart.
* `PANEL_SIDE_BY_SIDE_MIN = 2 * PANEL_GROUP_SIDE_MIN + 1 = 721`: two such groups and the
  1px divider. 720px stacks, 721px sits side by side. No extra "room" term any more.
* `PANEL_MIN` (280) stays the CSS minimum of a side-by-side group (`groupMin`), which the
  divider's ratio can squeeze a group down to, and `PANEL_GROUP_MIN_HEIGHT` (160) stacked.
* `splitOrientation(width)` takes the rendered width only; the `expanded` argument is gone.
* **Expanded follows its real width.** `expandedPanelWidth(windowWidth, sidebarWidth)`
  (`stores/ui.ts`) is `windowWidth - sidebar - 2 * SHELL_GAP`: the expanded wrapper is
  `m-shell flex-1` in the row after the sidebar, with the content column hidden. `Panel`
  reads it from the ui store, so the orientation still follows a derived number, never a
  measurement. The e2e test checks the derived number against the wrapper's real
  `getBoundingClientRect().width` at 1440px and 900px.
* The resize drag still holds the orientation until release. An expanded panel has no
  resize handle, so nothing holds there: a window resize flips it at once.

## What it means in practice

* At the default 280px sidebar, an expanded split panel stacks below a 1025px window and
  sits side by side from there; with the sidebar hidden, from 745px.
* An unexpanded panel can be 721px wide only when `panelMax` allows it: 60% of the
  window and `CONTENT_MIN` left for the content pane, so from about a 1397px window at the
  default sidebar. Below that a split panel is always stacked unless expanded.
* The drop band (`panel-split-3-drag.md`) follows the same orientation, so a narrow
  expanded panel now offers the bottom band.

## Live check

Built app (`make gui-build`) with an isolated `CODE_FOUNDRY_HOME`, one no-project thread
with its Usage and MCP tabs, split with `code-foundry view panel split`. In a 1700px
window, the panel dragged to about 830px (a CGEvent drag on its resize handle) sat side
by side; the window shrunk to 1300px (`panelMax` 624) stacked it; expanded in the
smallest window stacked it, both groups inside the panel. Dark and light, the system
appearance put back afterwards. The PR body's shots come from that run.

## Gotchas

* The window's minimum width is 900px (`gui/main.go` `MinWidth`), so "expanded in an
  800px window" cannot happen; System Events' `set size` to 800 gives 900. At 900 with
  the default sidebar the expanded panel is 596px: stacked.
* The vitest hold-during-drag test mocks the handle's `getBoundingClientRect` width,
  which is where the drag starts from, so its mock had to move with the stored width.

## Tests

* Vitest: `splitLayout.test.ts` (threshold, orientation table at 585/720/721),
  `stores/ui.test.ts` (`expandedPanelWidth` table), `SidePanel.split.test.tsx` (an
  expanded panel stacked at 900px, side by side with the sidebar hidden, 745 vs 744px;
  the held-drag test moved to 640 to 740px).
* Playwright: `panel-split.spec.ts` (585 and 720 stack, 721 side with a 721px wrapper;
  expanded side at 1440 and 1400, stacked at 900 with both groups inside the panel and
  the wrapper at the derived width; the resize-drag hold from 620 to 740 and back),
  `panel-split-drag.spec.ts` (the band's edge at 720 vs 721, and an expanded panel at 900
  offering the bottom band and splitting stacked).
