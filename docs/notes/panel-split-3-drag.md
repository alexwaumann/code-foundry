# Side panel split, PR 3 of 3: dragging tabs between groups

Agreed with Alex on 2026-10-20 (design and a mockup built from the real app, reviewed
before PR 1). PR 1 (`panel-split-1-store.md`, #277) gave the panel store one or two tab
groups and `movePanelTabToGroup`; PR 2 (`panel-split-2-gui.md`, #278) rendered them. This
PR adds the drag gesture: a tab moves between the groups, and dragging one onto the far
edge of an unsplit panel splits it. Frontend only: no command, no Go or proto change.

## One drag context

`components/panel/PanelDnd.tsx` is the panel's one `DndContext`, around both groups (in
`Panel`, inside the split container). Each strip keeps its own `SortableContext`, so a
reorder inside a strip slides the neighbours as before. `PanelDnd` also provides the drag
state (`panelDrop.ts`: the dragged tab, the current target, the band's edge) to the
strips and bodies, which draw the feedback.

## The droppables (`dragDrop.ts`)

| Droppable | Id | Data | Registered by |
|---|---|---|---|
| Each tab (sortable) | the tab id | `{ kind: "tab", group }` | `TabButton` |
| Each group's header | `panel drop: header <g>` | `{ kind: "header", group }` | `GroupHeader` (TabGroup.tsx) |
| Each group's body, split only | `panel drop: body <g>` | `{ kind: "body", group }` | `GroupDropArea` (TabGroup.tsx) |
| The drop band, while dragging | `panel drop: band` | `{ kind: "band" }` | `DropBand` (TabGroup.tsx) |

Droppable ids have a space; tab ids (kind plus encoded params) never do, so they cannot
collide in the one context.

`panelCollision` (a custom collision detection) turns the pointer into one target, in this
order:

1. **The band** (pointer inside it): a new second group.
2. **The tab's own header**: a reorder. `closestCenter` among its own group's tabs by the
   lifted tab's rect, which is how the in-strip reorder always worked (the drop takes the
   index of the tab it is over: arrayMove, `movePanelTab`).
3. **The other group's header**: a slot in that strip by the pointer's x (before every tab
   whose centre is right of it; `insertionIndex`), `movePanelTabToGroup(key, id, g, slot)`.
   The collision's id is that strip's nearest tab (or its header when it has no tabs), so
   dnd-kit auto-scrolls that strip: it scrolls the ancestors of what the drag is over.
4. **The other group's body**: appended last, `movePanelTabToGroup(key, id, g)`.
5. Anything else (its own body outside the band, the divider, outside the panel): no
   target, and the drop puts the tab back.

The target rides in the collision's `data`, so `onDragEnd` reads it from the event's
collisions (`dropTargetOf`), and `dropMove` turns it into the store call. The drop reads
the store as it is then: a tab opened mid-drag counts, a dragged tab closed mid-drag
moves nothing, and a release after the panel unmounted (selection switched) moves nothing.

## The band rule

While a tab is dragged in an **unsplit** panel with **two or more tabs**, the body shows a
band over its far edge: the right 45% when `splitOrientation` (on the rendered width) is `side`,
the bottom 45% when `stack`, 8px in from the body's other edges (`left-[55%]` or
`top-[55%]`, the rest `2`). It is faint (`bg-accent/20`, `ring-ring/40`) while the pointer
is elsewhere and takes the mockup's look while over it: `bg-accent/55`, a 1px inset
`ring-ring`, `rounded-lg`. Dropping on it calls `movePanelTabToGroup(key, id, 1)`, which
splits the panel with that tab alone in group two, focused. A single-tab panel shows no
band: the store ignores the move and there is nothing to split from. The orientation is
the one `Panel` already holds (it holds still during a resize drag).

While split, a tab over the other group's body tints that whole body (`bg-accent/30`), and
over the other strip a 2px `bg-ring` marker shows the slot.

## Visuals

* **The lifted tab is a `DragOverlay` ghost**, portalled into `document.body`: the tab's
  icon and title on `bg-popover` with `shadow-md` and a `ring-border` hairline, `rounded-md`,
  `aria-hidden` (not a tab). A modifier (`restrictTo`, `clampTranslate`) keeps it inside the
  panel. Its slot in the source strip stays as a placeholder at `opacity-40`, and during a
  reorder it slides to where the drop would put it.
* **The drop animation is dnd-kit's own** (the overlay flies to the dragged tab's element
  in 250ms), so the in-place FLIP settle from `panel-tab-reorder.md` is gone.
* `@dnd-kit/modifiers` is no longer used (`restrictToHorizontalAxis` and
  `restrictToParentElement` went with the in-place drag) and was removed.

## Accessibility

* The tabs' `aria-describedby` reads: "To move this tab, press Option with Left Arrow or
  Right Arrow. Drag it onto the other group to move it there, or onto the far edge of the
  panel to split it."
* Announcements (`announcements.ts`) name the tab by title and say what the target is:
  "Tab Files is over position 2 of 3.", "... is over the second group's tabs, position 1 of
  2.", "... is over the second group.", "... is over the edge of the side panel: dropping it
  there splits the panel.", and after the drop where the tab is now ("... was moved to the
  second group, position 1 of 2.", "... was moved to a new second group."). dnd-kit only
  hands announcements the active and over ids, so `PanelDnd` gives the announcer the target
  from the collisions (`track`) before dnd-kit announces.
* Keyboard moves stay within a group (alt+arrows, clamped). A cross-group move is drag only,
  as agreed: no command and no context menu.

## Decisions and deviations

* **DragOverlay instead of the in-place transform.** A tab inside a scrolling strip is
  clipped by it, so it could never be dragged into the other group in place.
* **A drop in the tab's own body (outside the band) is a cancel**, not a reorder by x as
  before. The old drag could not leave the strip's row; now that the ghost moves freely,
  only the header reorders.
* **Slot by the pointer, reorder by the lifted rect.** In the other strip the slot is where
  the pointer is between centres, which is what the marker shows; the own strip keeps
  `closestCenter` so the existing reorder behaves exactly as before.
* **The band shows for the whole drag**, faint until hovered, so it can be found; the brief
  described its hovered look. A drag that only reorders shows it faintly too.
* **The ghost is not rotated** (the mockup tilts it 2°): WebKit blurs rotated text.
* **No auto-scroll outside strips**: `canScroll` limits dnd-kit to `role="tablist"`
  elements, which would otherwise scroll a body sideways while the pointer is over it.
* **Strip keys wait for any lifted tab in the panel**, not only one in their own strip.
* **Screenshots** sit on the `cf/panel-split-3-drag-shots` branch, not under `docs/notes/`
  (CLAUDE.md: notes are text only; the brief asked for `docs/notes/panel-split-3-drag/`).

## Gotchas

* **The overlay must not take the pointer** (`pointer-events-none` on the `DragOverlay`).
  After a drop the ghost flies back over the tab for 250ms; a press on the tab in that time
  landed on the ghost and started no drag. The full e2e run caught it as a flake.
* **dnd-kit renders two ghosts briefly**: a drag that starts while the previous drop's
  ghost is still flying (250ms) shows the new ghost first and the old one after it in
  `document.body`. Tests use `.first()`.
* **A tab pressed mid-slide is lifted from its final slot.** After a drop the strips'
  tabs slide into place for 200ms (sortable's layout animation), and dnd-kit measures the
  tab without its transform, so a press during that slide puts the ghost at the final
  slot. The e2e helper waits for the panel's animations before each drag.
* **The placeholder's CSS transition shows in `getAnimations()`** (a `CSSTransition`).
  The reorder spec's "picked up again mid-settle" check now ignores transitions and checks
  the ghost is under the pointer instead.
* **jsdom lays nothing out**: `clampTranslate` ignores bounds without area (the aside's
  zero rect there), and the SidePanel drag tests now give the header a rect, since a
  reorder needs the pointer inside its own header.
* `useDroppable`/`useSortable` data objects are memoized: dnd-kit re-registers a droppable
  when its data changes identity.

## Live check

Built app (`make gui-build`) with an isolated `CODE_FOUNDRY_HOME`, a scratch git project
under `~` with three changed files and a thread in it (never sent a message), the panel
holding MCP, worktree and README.md's diff, widened to side by side. In the WKWebView:
README.md dragged onto the right band showed the band and the ghost and split the panel
with it in group two; MCP dragged onto group two's strip landed after README.md; README.md
dragged onto group one's body tinted it and landed last there. A drag that leaves the
strip never moved the window. The theme went through `appearance.theme` in the isolated
settings file and was put back.

A held mid-drag in the real window needs synthetic pointer events (no cliclick here): a
20-line Swift tool posting `CGEvent` mouse down, dragged and up events (down, 30 steps,
hold, up) works, run in the background while `screencapture` takes the shot. The first
click on the window only activates it.

## Tests

* Vitest: `components/panel/dragDrop.test.ts` (the collision table: own header, other
  header slots and nearest tab, empty strip, bodies both ways, own body, outside, the band
  and beside it, no pointer, non-tab draggables, rects without area; `insertionIndex`,
  `dropMove`, `sameTarget`, `dropDataOf`/`dropTargetOf`, `clampTranslate`) and
  `components/panel/announcements.test.ts` (over and dropped texts per target, the
  announcer). `SidePanel.test.tsx`: the header rect in the layout stub, the new
  instructions text.
* Playwright `e2e/panel-split-drag.spec.ts` (WebKit, mock daemon, 1440x900): the band at
  420px (bottom, its rect, the ghost, the dimmed slot) and 760px (right) splits the panel
  with that tab in group two; a single-tab panel has no band, a drop beside the band and
  Escape over it change nothing; dragging into the other strip lands at the marked slot
  (before a tab, and after the last over the "+"), an in-strip reorder still works,
  alt+arrows stay in the group; a drop on the other body appends and tints it, the own
  body is no target, and moving a group's last tab out collapses the split. `SHOTS=<dir>`
  adds mid-drag shots. The existing `panel-tab-reorder` tests in `e2e/panel.spec.ts` pass
  unchanged except the settle check above.
* Whole suites: vitest 5402 tests in 255 files (was 5335 in 253); `make gui-e2e` 498
  passed, 30 skipped (the SHOTS-gated ones among them), no retries.
