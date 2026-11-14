# Shell PR 14b: an outer-edge drop takes its kind's default size

A follow-up to `shell-14-drag.md`, which decided "every split takes half" because the daemon's
`move_tab` and `move_pane` split in half and the drop preview must show what lands. The owner
decided instead: a tab or a pane dropped on the outer edge of the whole grid takes the default size
of its surface kind (the dropped tab's kind; for a pane, its active tab's), as a share of the grid
along that axis, raised to the kind's pixel floor when the pane area is known. A drop on a pane's
own edge still splits that pane in half, and a pane that is joined is never resized.

## What changed

| Where | What |
| --- | --- |
| `internal/layout/ops_tree.go` | `outerFrac`: the share for an outer edge; `toOuter` uses it when the op gives no `frac`. `MoveTab` and `MovePane` take the pane area (`w`, `h`, set by `WithArea` like the placement ops) |
| `internal/layout/place.go` | `Kind.sizeIn`: the kind's share of a room raised to its floor, now shared by rule 5 (`roomBeside`) and the outer edge |
| `internal/layout/testdata/ops` | `move_pane-outer` now lands at 0.45 (a diff), not half; new `move_tab-outer-kind-size`, `move_pane-outer-floor`, `move_pane-outer-floor-no-room`, `move_pane-beside-half` |
| `gui/frontend/src/shell/drag/outerFrac.ts` | the port of `outerFrac` with the kinds' sizes (pinned to `testdata/kinds.json`) |
| `drop.ts` | `treeAfterDrop` takes the frame's size and uses `outerFrac` for an outer target; half beside a pane |
| `mock/layout.ts` | `toOuter` uses `outerFrac`; `MockLayout.apply` gives `move_tab`/`move_pane` the reported viewport, as the daemon's `WithArea` does |

## Decisions

- **The rule.** With no `frac` given: `px = default_frac × room`, where room is the area's length
  along the edge's axis (width for left/right, height for top/bottom) less the gutters of the split
  the pane ends up in (it joins a root split that runs the same way, so a root row of two panes
  dropped on the left counts two gutters). When `px` is under the kind's `floor_px` and the rest
  would still keep `KeepPx` (480), `px` becomes the floor. The share is `px / room`. This is rule 5's
  arithmetic (`roomBeside`), except that the outer edge never refuses: it has no "no room" case.
- **Counting the gutters of the split it joins** makes the floor exact in px: a diff raised to its
  floor on the bottom of a two-row column is drawn 480px high, not 474.
- **No area, no floor.** When the op has no pane area (a CLI call with no window ever reported, a
  case without `w`/`h`), the kind's share is used as it is. The store's `WithArea` gives the move ops
  the window's area, so a drag and a CLI call land the same.
- **An explicit `frac` wins**, outer edge or not (`--frac` on `tab.move` and `pane.move`).
- **Unknown kind or a pane with no active tab**: half, as before.
- **The preview uses the frame's size** (`frame.w`, `frame.h`), which is the box the pane grid
  reports as the viewport. Its own pane minimums still apply when the frame is laid out, so the
  preview is the drawn rectangle; the stored share is the one above.

## Verification

- `make check` green.
- Go: `TestOpCases` (the new and updated cases), `TestOuterFrac` (each branch), the property test
  with random pane areas on the move ops, `TestWithArea` listing `move_tab` and `move_pane`.
- vitest: `drop.test.ts` replays every edge and outer case of `testdata/ops` (with their `w`/`h`)
  and compares the tree with Go's `want`; the preview of a thread, a file tab and a diff (raised to
  its floor) on an outer edge, and half beside a pane. `outerFrac.test.ts` repeats Go's table and
  pins `KIND_SIZES` to `kinds.json`. `mock/layout.test.ts` runs the same cases on the mock;
  `layoutVerbs.test.ts` checks the mock's viewport reaches `pane.move --outer`.
- e2e `shell-drag.spec.ts`: the outer-edge test now checks the stored shares (a thread: half; a
  diff pane on the bottom: 0.45, under its floor at 1400x900) besides the landed pane matching the
  preview.
- End to end with the real daemon (`daemon --dev` on a scratch home under /tmp, removed after) and
  the CLI: a terminal tab `tab.move --outer right` landed as `row [0.70 0.30]`; its pane
  `pane.move --outer top` as `col [0.30 0.70]`; a second terminal `tab.move --split <prs pane>
  --edge right` split that pane `[0.50 0.50]`.

## Gotchas

- `src/shell/drag/outerFrac.ts` is imported by the mock, so it imports `../geometry/rects`
  relatively, not through `@/`.
- A new surface kind adds its size to `KIND_SIZES` too; `outerFrac.test.ts` fails until it does.
