# Side panel split, PR 2 of 3: the groups on screen

Agreed with Alex on 2026-10-20 (design and a mockup built from the real app, reviewed
before PR 1). PR 1 (`panel-split-1-store.md`, #277) gave the panel store one or two tab
groups, a ratio and a focused group. This PR renders them and adds `view.panel.split`.
PR 3 adds dragging a tab between groups and the drop-to-split band.

## Layout

* **Orientation is derived, never stored.** `splitOrientation(width)`
  (`components/panel/splitLayout.ts`): side by side (`flex-row`, a vertical divider) when
  the rendered panel width is at least `PANEL_SIDE_BY_SIDE_MIN`, stacked (`flex-col`, a
  horizontal divider) below it, expanded or not. The rendered width is
  `min(stored width, panelMax)`, the same number the wrapper's style uses; expanded, it is
  `expandedPanelWidth(windowWidth, sidebar)` (`stores/ui.ts`: the row beside the sidebar
  less the wrapper's two shell-gap margins). No measuring is involved, so a window or
  sidebar resize flips it at once.
* **The threshold** is `PANEL_SIDE_BY_SIDE_MIN = 2 * PANEL_GROUP_SIDE_MIN + 1 = 721` px
  (`stores/ui.ts`): two groups of `CONTENT_MIN` (360px, the least a pane is worth reading
  at) and the 1px divider. The default 420px panel stacks; 721px and up sits side by side.
  Changed from 585px (two `PANEL_MIN` groups and 24px) and from "always side by side while
  expanded", which clipped the second group off the right edge of a narrow window
  (`panel-split-threshold.md`).
* **Held during a resize drag.** While the panel's resize handle is dragged
  (`PanelResizeHandle`'s new `onDragChange`), `Panel` keeps the orientation it had at
  pointerdown and catches up on pointerup or lost capture. Keyboard resizing flips at once.
* **The ratio** is group 0's share of whichever axis is in use: each group is
  `flex: <share> 1 0px`, with `minWidth: PANEL_MIN` side by side and
  `minHeight: PANEL_GROUP_MIN_HEIGHT` (160px) stacked. The CSS minimum wins when a ratio
  stored at a wider size would squeeze a group, so a ratio saved while expanded is safe
  in a narrow panel.
* **The buttons** (expand, toggle) stay in the panel's top-right corner: group 0's header
  when unsplit or stacked, group 1's when side by side (`panel-controls`).
* **One split container either way** (`panel-split`): group 0 is its first child split
  or not, so it stays mounted across a split and an unsplit (its surface keeps its state).
  The tab that moves into group 1 remounts, as any tab body does when it moves.
* Each group has its own 44px header (strip, "+", maybe the buttons) and body. An unsplit
  panel with no tabs still has no strip; a split panel's empty group shows its "+",
  highlighted, as its strip (the `empty-stack` mockup state).

## The divider

`SplitDivider.tsx`: a 1px `bg-pane-border` line with a hit area 4px either side (an
`::after`), `z-10` over the groups, `no-drag` for Wails, `cursor-col-resize` or
`cursor-row-resize`. It tints `bg-ring` when hovered, focused or dragged
(`data-dragging`), like the panel's resize handle. Dragging measures the split container
(its parent) at pointerdown and sets `setPanelRatio`, clamped by `clampSplitRatio` to
the store's 0.2..0.8 and to each group's pixel minimum, rounded to three places. It is a
focusable `role="separator"`: `aria-orientation` is the line's (vertical side by side),
`aria-valuenow` the ratio in percent, min/max the store's 20/80. Left/Up and Right/Down
move it 16px (Shift: 64px) in either orientation, Home and End go to the bounds, and a
double-click resets it (drops the stored ratio: the middle).

## Per-group state

* `TabGroup.tsx` is one group: `data-panel-group` (0 or 1), `data-focused` (the focused
  group of a split panel), `data-picking` (that group shows its surface list). The
  aside keeps `data-picking` for the focused group too (see Decisions).
* **Focus.** `onPointerDownCapture` and `onFocusCapture` on a split group call
  `focusPanelGroup`, so a press or focus anywhere in it (tabs, body, the "+", its list)
  makes it the focused group before the event does anything. A split group is
  `tabIndex=-1`, so the keyboard can be moved into it whatever it shows.
* **Tints.** The focused group's active tab (and its "+" while picking) keeps
  `bg-accent text-accent-foreground dark:bg-accent/50`; the other group's uses
  `bg-accent/40 text-foreground dark:bg-accent/25`, as in the mockup. Unsplit, the one
  group is always "focused".
* **The "+" stays a `CommandButton` for `view.panel.new-tab`.** The command picks in the
  focused group, and a press on a group's "+" focuses that group first (the group's
  pointerdown capture, plus an `onClickCapture` on the "+"'s wrapper for clicks without
  a pointerdown). So the palette, CLI and chord pick in the focused group, and each "+"
  in its own group, without a group argument on the command. This answers PR 1's open
  question.
* **Lists and letters.** `SurfaceRow` and `PluginSurfaceRows` take a `group` and call
  `openSurface(..., { group })`. `panelKeyAction`'s `open` carries the focused group, and
  `Panel` passes it on.
* The strip and body moved out of `SidePanel.tsx` into `TabStrip.tsx` (tabs, "+", dnd-kit,
  alt+arrows) and `GroupBody.tsx` (the active surface or the list); shared helpers
  (`closeTab`, `hidePanel`, `liftedTab`, ids) are in `actions.ts`. The surface list now
  scrolls (`overflow-auto`, its column centred with `m-auto`) so a 160px stacked group
  does not clip its top.

## Keyboard

* The panel's keys act on the focused group: cmd+w, the surface letters, Escape while
  picking, and alt+arrows (on the strip that has focus).
* **cmd+alt+\\ focuses the other group** (`FOCUS_OTHER_GROUP_CHORD`, `panel/keys.ts`),
  whichever way the groups sit. It moves DOM focus into the other group's element, whose
  focus handler makes it the focused group. It works in text fields (like cmd+w) and is
  never offered to a surface. It sits next to the split chord, and it is free: no command,
  view action or menu item used it. Reserved like cmd+shift+c because the panel takes it
  before the registry: `ReservedChords` (chord.go), `menuChords` (settings/validate.ts)
  and the mock's list. The Help overlay lists it.
* **cmd+w on an empty picking group** (a split from a single tab) stops picking, which
  collapses the split (the store's `stopPicking`); focus stays on the aside.
* **Closing a group's last tab** collapses the split too; `closeTab` now asks the aside to
  take focus back when a split collapsed while the panel had it (the closed tab's ×, or
  the group, had it).

## The command

`view.panel.split` ("Split Side Panel", View, "Split or unsplit the side panel of the
selected thread or page into two tab groups.", default chord **cmd+\\**, free in Go, the
GUI and the mock). It emits `ShowView{"panel.split"}` like `view.panel.expand`; nothing
is generated from the registry (the CLI lists commands at run time, the mock's world lists
its own copy). The GUI runs it locally (`commandPresenters` in keys/bindings.ts) through
`splitPanelCommand` (stores/views.ts):

* unsplit panel: `splitPanel` (shows a hidden panel; a panel without tabs is only shown);
* split, open panel: `unsplitPanel`, and focus back to the aside if the panel had it;
* split, hidden panel: shown, still split (joining groups the user cannot see would be a
  surprise; the same reasoning as `view.panel.expand` on a hidden panel);
* no-op while the settings, usage or themes page is up, and with nothing selected.

Splitting focuses the panel (or the palette's return target moves there), like
`view.panel.new-tab`.

CLI: `code-foundry view panel split` (or `view.panel.split`) delivers the ShowView to every
window; `code-foundry help view` lists it as "Split Side Panel".

## Live check

Built app (`make gui-build`) with an isolated `CODE_FOUNDRY_HOME`, a scratch git project
under `~` with three changed files, and a thread in it (never sent a message). With the
worktree tab and README.md's diff open, `code-foundry view panel split` split the panel
(stacked at 420px), dragging the resize handle to the 776px maximum flipped it side by
side on release, `view panel expand` kept it side by side, cmd+\ joined and split it
again, and cmd+alt+\ moved the full tint to the other group, all in the WKWebView. The
PR body's shots come from that run. Theme switches went through `appearance.theme` in
the isolated settings file and were put back to `system`.

## Decisions and deviations from the brief

* **`data-picking` stays on the aside too**, for the focused group, besides moving onto
  each group. Existing tests and anything reading the panel's picking state keep working;
  the groups carry the per-group truth.
* **The chord for the other group is cmd+alt+\\**, panel-local and reserved, not a
  registry command: it only means something with focus in a split panel, and a CLI verb
  for it would do nothing useful.
* **Divider arrows accept both pairs** (Left/Up, Right/Down) in either orientation,
  rather than only the pair matching the axis, so the key does not depend on a width the
  user cannot see change.
* **aria-valuemin/max are the store's 20/80**, not the pixel bounds, to avoid measuring
  during render; the drag and keys clamp to the pixel bounds.
* The group-1 tabpanel id is `side-panel-body-1`; group 0 keeps `side-panel-body`.

## For PR 3 (drag between groups)

* Per-group strip: `TabStrip` in `components/panel/TabStrip.tsx`, the `role="tablist"`
  element with `data-testid="panel-tabs"` inside the group's `panel-header`. **Each strip
  has its own `DndContext`** today; dragging across groups needs one context around both
  groups (in `Panel`) with a sortable container per group, and the drop calling
  `movePanelTabToGroup`.
* Per-group body: `GroupBody` in `GroupBody.tsx`, `data-testid="panel-body"` with
  `data-scroll-root`, `data-surface` and `data-tab-id` (or `panel-empty` with
  `data-surface-list` while picking). The drop band belongs over it.
* Group element: `TabGroup` in `TabGroup.tsx`, `data-panel-group`, `data-focused`,
  `data-picking`, `data-testid="panel-group"`. The split container is `panel-split`
  (`data-split`, `data-orientation` = `side` | `stack`) in `SidePanel.tsx`; the drop band
  side for an unsplit panel can reuse `splitOrientation` on the rendered width.
* Tab wrappers keep `role="presentation"`, `data-tab-id` and `data-dragging`.

## Gotchas

* `exactOptionalPropertyTypes` is off, so `openSurface(key, tab, { group })` with an
  undefined group is fine (it means the focused one).
* In jsdom, a split group's tabindex makes `focus()` work, and `onFocusCapture` fires for
  it; the unit test for cmd+alt+\\ relies on that.
* `setRatio` drops 0.5, so a drag that lands exactly in the middle stores nothing.
* Playwright: tab wrappers and the body share `data-tab-id`; scope tab locators with
  `[role="presentation"]`.

## Tests

* Vitest: `components/panel/splitLayout.test.ts` (threshold, orientation table, bounds,
  clamp, divider keys), `components/panel/SidePanel.split.test.tsx` (17: unsplit shape,
  orientation table with button placement, window resize, held during a resize drag,
  group sizes and minimums, tints, focus by press and by focus, the "+" and Escape per
  group, cmd+alt+\\, cmd+w collapsing, divider drag both axes, keys, double-click,
  modified keys), `stores/views.split.test.ts` (9), new rows in `panel/keys.test.ts` and
  `settings/validate.test.ts`. Whole suite: 5335 tests in 253 files.
* Go: `TestViewCommandsEmitShowView` and the registered list cover `view.panel.split`;
  `TestValidateBinding` has cmd+alt+\\ reserved and cmd+\\ bindable.
* Playwright (`e2e/panel-split.spec.ts`, WebKit, 1440x900): split from the palette
  (stacked, focus, no daemon call, tints, buttons), 584 vs 585px, 760px side by side,
  expanded; cmd+\\ joins and splits, the CLI's Invoke twice; the orientation held
  mid-drag and flipped on release both ways; the divider drag (persisted ratio, the 280px
  minimum, keys, double-click, the stacked axis, a reload); per-group "+", picker,
  letters and list, focus by click and cmd+alt+\\, cmd+w per group and collapsing.
  Every test fails without the feature (none of the elements or the command exist).
  `SHOTS=<dir>` adds mock screenshots (stacked, side by side, expanded).
