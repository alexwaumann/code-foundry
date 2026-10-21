# Side panel: tab drags keep moving over an HTML render (2026-10-21)

Alex: dragging a side-panel tab over a group whose body shows an HTML render froze the
drag. The ghost stopped following the pointer, and nothing under the frame could be a
target.

## Cause

dnd-kit's `PointerSensor` (`components/panel/PanelDnd.tsx`) listens for `pointermove` and
`pointerup` on the app's document. Once the pointer is over an `<iframe>` (the File tab's
interactive preview, `files/HtmlPreview.tsx`, served by the daemon since
`html-preview-interactive.md`), WebKit sends the pointer's events to the frame's document,
so the sensor hears nothing until the pointer leaves the frame again. The ghost stayed where
the pointer entered the frame, and so did the drop target. The divider and the resize handle
are not affected because they capture the pointer.

## Fix

* `PanelDnd` takes an `onDragChange` callback (lifted tab: true; drop or cancel: false),
  the same shape as `PanelResizeHandle`'s. `Panel` (SidePanel.tsx) keeps it in state and
  puts `data-dragging` on the aside (`data-testid="side-panel"`) while a tab is lifted. Data
  flows one way: `Panel` is `PanelDnd`'s parent, so it cannot read `PanelDropContext`, and
  the callback avoids writing to the aside's DOM from inside `PanelDnd`.
* One rule in `index.css`: `[data-dragging] iframe { pointer-events: none; }`. It applies to
  every frame in the panel (the HTML render now, plugin frames later). It is not in
  `@layer base`, so no utility on a frame can override it.
* With the frame ignoring the pointer, the app's document gets the events again.
  `panelCollision` works from the pointer's coordinates and the droppables' measured rects,
  not from hit testing, so the group body's `useDroppable` under the frame is found with no
  further change. The e2e test checks for the body tint and the landed tab.
* `HtmlPreview`'s sandbox, the divider and the resize handles are unchanged.

## Gotchas

* `data-dragging` was already used by the lifted tab's wrapper (TabStrip) and the split
  divider. `liftedTab(root)` uses `root.querySelector`, which never matches `root` itself,
  so the aside's new attribute changes nothing there. When a tab is lifted the two mean the
  same thing anyway. Neither the tab wrapper nor the divider contains a frame, so the CSS
  rule only ever takes effect through the aside.
* Playwright's `page.mouse` in WebKit reproduces the freeze. With the rule switched off,
  the new e2e test fails because the ghost stays at the frame's top edge (y ≈ 540) while the
  pointer is at y ≈ 657.
* Another worktree's `make gui-e2e` was holding the default mock and Vite ports (7799+,
  9255). `E2E_MOCK_PORT=8611 E2E_VITE_PORT=9611` moved this run's ports
  (playwright.config.ts).

## Verified

* Vitest (`SidePanel.test.tsx`): the aside has no `data-dragging` under the 4px threshold,
  gets it once the tab lifts, and loses it on a drop and on Escape.
* Playwright (`e2e/panel-split-drag.spec.ts`): the panel is split and stacked, with the
  mock's `docs/preview.html` rendered in group two (its script ran). The frame takes the
  pointer before a drag. A tab dragged from group one is followed by the ghost at two points
  across the frame, the frame's computed `pointer-events` is `none` while the tab is lifted,
  group two's body is tinted, and the drop puts the tab last in group two.
* `make check` passes. `make gui-e2e` passes: 508 passed, 30 skipped (the SHOTS-gated
  tests), no retries.
* Live, in the built app (`make gui-build`) with an isolated `CODE_FOUNDRY_HOME`: a scratch
  git project under `~` held an `index.html` with a gradient and a click-counter button.
  A thread in it replied with path chips, which opened `README.md` and `index.html` as File
  tabs. `view.panel.split` stacked them (index.html rendered in group two). A compiled Swift
  helper posted `CGEvent` mouse events: a press on README.md's tab, 25 drag steps 30ms
  apart into the frame, 15 more across it, a hold, then the release. Mid-drag, the ghost
  sat at the second point deep inside the frame and group two's body (frame included) was
  tinted. After the release README.md was in group two after index.html, and the split
  collapsed because README.md had been group one's last tab. The same run in light mode
  gave the same result. Afterwards two clicks on the page's button read "2 clicks", so the
  frame takes the pointer again once the drag ends. The system appearance was put back to
  dark.
