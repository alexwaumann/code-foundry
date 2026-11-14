# Shell PR 14: drag tabs and panes

Fourteenth PR of the shell stack (`docs/notes/shell-plan.md`, section 4). With the shell flag on, any
tab drags (active or not) and a whole pane drags by the empty part of its strip: to a place in a
strip, onto a pane, onto a pane's edge to split it, or onto the grid's outer edge. A drop is exactly
one `tab.move` or `pane.move`. With the flag off nothing changes. Dropping onto a space tab waits for
the top bar (PR 15).

## What is in it

| File | Holds |
| --- | --- |
| `src/shell/drag/targets.ts` | pure hit-testing: pointer + drawn frame + measured strips → one drop target; the insertion bar |
| `src/shell/drag/drop.ts` | the command a drop runs (`dropCommand`); the preview: the daemon's tree edit replayed on the drawn tree and laid out (`treeAfterDrop`, `dropPreview`) |
| `src/shell/drag/announce.ts` | the screen reader texts and the drag instructions |
| `src/shell/drag/state.ts` | the drag in progress (window-only zustand store): source, target, pointer, preview, bar |
| `src/shell/drag/draggable.ts` | `useTabDrag`, `usePaneDrag` (dnd-kit `useDraggable`), `sourceOf` |
| `components/shell/ShellDnd.tsx` | the `DndContext` around the grid (in `Shell.tsx`): measuring, retargeting, the drop, the shield, the preview, the ghost, announcements |
| `PaneTabStrip.tsx`, `PaneView.tsx`, `Shell.tsx` | small additions: the tab and strip draggables, the dragged tab and pane dimmed, the wrapper |
| `mock/layoutVerbs.ts` | `pane.move` (`--beside/--edge`, `--into/--index`, `--outer`, `--space`), as Go's |
| `e2e/shell-drag.spec.ts` | every drag in WebKit, tiling after each, Escape, over an iframe; SHOTS |

## Zones and their precedence (`targets.ts`)

All in layout px from the grid's top left (the frame's coordinates); the pointer is divided by the
page zoom first.

1. **Outer edges**: a band 10px inside the grid and up to 24px outside it on each side. In a corner
   the nearer side wins, left/right on a tie. The band wins over a strip and a pane edge under it:
   it is thin, and the outer edge is otherwise unreachable where a pane meets the grid's side.
2. **A strip** (the pane's top 44px): a place by the tabs' centres (before the first tab whose
   centre is right of the pointer).
3. **A pane's body**: four edge bands of 28% of the body, at most 150px across and 130px down;
   the nearest edge (relative to its band) wins. The middle is the pane: a tab joins the end of its
   strip, a pane merges into it. A body narrower than 240px has no left/right edges, one shorter than
   160px no top/bottom edges (a split there would leave panes too small to use).
4. **Anything else** (a gutter, farther outside): no target, and a drop puts things back.

What a drop could not do is not a target: a pane onto itself (strip, middle or edge), a pane's only
tab onto its own pane's edge or middle, the grid's only pane (or the only tab in it) onto an outer
edge. A tab over its own strip is always a target, so the bar shows where it sits; putting it back
in its own place sends nothing (`dropCommand` returns null).

## Decisions

- **Hit-testing is geometry, not droppables.** dnd-kit gives the sensor (4px activation, so a click,
  the × and a middle click stay what they are), Escape, the click swallowed after a drop and the
  live region. There are no `useDroppable`s and no collision detection: `ShellDnd` reads the pointer
  (the activator's client position plus dnd-kit's delta) on every move and asks `dropTarget`. The
  strips are measured from the DOM at the drag's start (and again if the frame redraws mid-drag).
- **The preview is the real result.** For an edge or the outer edge, `treeAfterDrop` replays the
  daemon's own edit (Go `MoveTab`/`MovePane`: `removeNode`, `insertBeside`, `norm`, the room going
  to the sibling before) on the drawn tree, and `frameRects` lays it out at the grid's size, so the
  preview is the rectangle the tab or pane will take, minimums included. Its vitest replays every
  edge and outer case of `internal/layout/testdata/ops` and compares the tree's shape with Go's
  `want`. A pane's middle previews the whole pane; a strip shows the insertion bar instead.
- **Default share.** A drop takes the daemon's default (`frac` omitted: half). The prototype gave
  an outer drop the kind's default size (`kinds.json` `default_frac`); the daemon does not apply
  it for `move_tab`/`move_pane`, and the preview must match the commit, so half it is.
  (Superseded for the outer edge by `shell-14b-outer-edge-size.md`: it now takes the kind's size.)
- **A shield while dragging.** Once a drag starts, a transparent fixed layer over the window takes
  the pointer until it ends, so an xterm canvas or an iframe under the pointer never swallows the
  moves (the side panel solved iframes with `[data-dragging] iframe { pointer-events: none }`; the
  shield also covers terminals and the sidebar). The preview, the bar and the ghost are in the same
  `document.body` portal, fixed, never clipped by a pane.
- **No transform on the tab.** The lifted tab stays in its slot at 40% opacity, a dragged pane at
  60%; a ghost (the tab's icon and name, or the pane's active tab with "+N") follows the pointer.
  The ghost is not rotated (WebKit blurs rotated text, as the side panel found).
- **The strip no longer drags the window.** Its free space is now the pane's grip, so its
  `--wails-draggable` is `no-drag`. Until the top bar (PR 15), the window drags by the sidebar's
  band; with the sidebar hidden, nothing in the shell drags the window.
- **ShellDnd wraps the grid from `Shell.tsx`**, not inside `PaneGrid`, so the shared grid file did
  not change; it finds the grid inside its wrapper (`display: contents`).
- **Focus.** A press on a tab or strip focuses its pane as before (`pane.focus`); the drop's command
  runs from the user and takes the focus to the dropped tab or pane.
- **Drafts.** A composer tab moves like any tab: `move_tab` keeps its params, so a draft stays the
  same draft wherever it lands (Go's `move_tab-draft-to-space` pins the params).
- **Announcements** name the tab by its strip title and a pane by its active tab's title with its
  tab count: picked up, over each new target ("Tab Fix login is over the right edge of the pane of
  Diff."), dropped or put back, cancelled. Only the pointer drags; moving by keyboard is the
  existing `pane.move.<dir>` keys.

## Verification

- `make check` green.
- vitest `shell/drag/targets.test.ts`: every zone (four outer edges inside and outside, corners and
  the tie, strips by index, four pane edges, middles, both gutters), the precedence (band over strip
  and edge, strip over the body's top edge), the edge caps in a big pane, a pane too small for edge
  zones on each axis, what a pane and a tab may not drop on, the only pane, an empty frame, the bar,
  `sameTarget`. `drop.test.ts`: every source × target command, put-back reorders, the Go op fixtures,
  previews (split, a pane leaving its place, outer column and row, middle, strip, missing tab), and
  300 random trees and drops that tile and keep every tab once. `announce.test.ts`, and the mock's
  `pane.move` in `mock/layoutVerbs.test.ts`.
- e2e `shell-drag.spec.ts` (WebKit, mock): reorder in a strip with the bar; an inactive tab into
  another strip; a tab onto a pane's edge (the landed pane equals the preview); a pane onto an edge;
  a pane onto a strip (merge); a tab and a pane onto the outer edge; Escape; a drag across an
  iframe's body. The panes tile the grid with no gap after each.
- End to end with `make drive DAEMON=dev` (a scratch home under /tmp, removed after) and
  `?shell=1` at 1400x900: three threads made with `thread new --no-project` and opened with
  `thread open` (one pane, three tabs). In the window, by pointer: the inactive "Drag One" onto the
  pane's right edge, "Drag Two" onto the bottom edge of One's pane, then Three's pane by its strip
  onto the grid's outer bottom edge. `layout show` printed `col [0.25 0.25 0.50]` with One, Two and
  Three in that order, as dropped; after a reload the window drew the same three panes (220, 220
  and 412 px high in a 876 px grid: the threads held at their 220 px minimum).
- Flag off: `make gui-e2e`, including `panel-split-drag.spec.ts` and the panel's reorder tests.

## Gotchas

- `document.getAnimations()` is never empty in the app (a busy thread's spinner loops): an e2e wait
  for "settled" must ignore animations with infinite iterations.
- The preview glides between targets (75 ms); read its box, or screenshot it, after its own
  animations end.
- `src` has no Node types: a vitest there reads Go fixtures with `import.meta.glob(..., { query:
  "?raw" })`, not `node:fs` (the mock's tests can).
- oxlint's `react(refs)` flags `obj.listeners` when `obj` also holds a dnd-kit `setNodeRef`;
  destructure the hook's result.

## For later PRs

- **PR 15 (top bar, spaces)**: a space tab as a drop target. Add a zone kind `space` hit before the
  outer band (the top bar is outside the grid, so the band's 24px above the grid must stop at the
  top bar); a tab drops as `tab.move --space`, a pane as `pane.move --space`. A thread tab and a
  pane holding one are refused there by the daemon (a thread moves with `thread.space.move`), so
  the target should be refused up front, or the drop of a thread tab should run `thread.space.move`.
  The top bar takes back the window drag the strip gave up.
- **PR 16 (sidebar)**: thread rows as drag sources. A row is a `useDraggable` inside `ShellDnd`
  (move the context up to wrap the sidebar too) with a source kind `thread`; its drop is
  `thread.open --pane` for a strip or a pane's middle, and for an edge `thread.open` then
  `tab.move --split` (or a new op argument), since there is no verb that opens a thread straight
  into a new pane.
- **PR 19 (rails)**: a rail is a drop target as a whole (no strip places, no edges): in `zoneAt`,
  a rect with `rail` set returns `{ kind: "pane" }`. The preview's `frameRects` must then use the
  same rails as the grid (`shellFrame`), and a dropped pane may unfold a rail.
