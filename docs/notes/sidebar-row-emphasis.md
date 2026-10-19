# Sidebar row emphasis (2026-10-19)

Threads were hard to tell apart in the sidebar: every row's name was the row's own
`text-body-sm` (13px regular) right above a 12px status line, and rows touched. Signed-off
design: the name one type role up and semibold, and a real 4px gap between rows.

## What shipped

| Where | Change |
|---|---|
| `SidebarRow.tsx` `nameClass` | `thread-name` is `text-body font-semibold text-inherit` (15px/22px, 600). Provisional stays muted + italic, an unnamed thread's id stays muted (both replace `text-inherit` through `cn`) |
| `SidebarRow.tsx` `RenameField` | The inline rename input is `text-body`, 22px tall, so line 1 neither shrinks nor changes text size when renaming starts |
| `components/sidebar/rowSizes.ts` (new) | `rowSize(row, rowHeight)`, `SECOND_LINE`, `HEADER_HEIGHT` and `ROW_GAP` moved out of `Sidebar.tsx`, with a table test |
| `stores/settings.ts` `ROW_HEIGHTS` | compact 26 → 28, comfortable 30 → 32 |
| `Sidebar.tsx` `PanelRows` | The virtualizer gets `gap: ROW_GAP` (4) |

## Final sizes

| Row | Compact | Comfortable | Before (compact / comfortable) |
|---|---|---|---|
| Two-line thread row (main list, Working) | 46 | 50 | 41 / 45 |
| One-line row (Snoozed, Archived) | 28 | 32 | 26 / 30 |
| Footer header | 26 | 26 | unchanged |
| Gap between thread rows | 4 | 4 | 0 |
| Pitch of a two-line row (row + gap) | 50 | 54 | 41 / 45 |

## Decisions

* **Padding kept, not squeezed.** The name line is now 22px (text-body's line-height)
  instead of 18. `ROW_HEIGHTS` is the first line plus padding: 3px above and below in
  compact, 5px in comfortable. `SECOND_LINE` went from 15 to 18, which is exactly the
  status line (16px `text-caption-sm` + the 2px `gap-0.5`), so a two-line row has the same
  padding as a one-line row. Before, `SECOND_LINE` (15) was smaller than the real second
  line (18), so two-line rows had 1.5px less padding than one-line rows. Squeezing the
  bigger name into the old heights would have left compact two-line rows with 0.5px of
  padding.
* **The gap is the virtualizer's `gap`, not padding inside the row box.** TanStack
  Virtual (3.14) adds it between items in `getTotalSize`, item `start` and
  `scrollToIndex`, so total height, scroll-to-row (the keyboard cursor) and the footers'
  height caps all include it. `vi.size` stays the row's own size, so the absolutely
  positioned wrapper (and the `h-full` row inside it, with its selection, hover and focus
  ring) covers the row and never the gap. The gap only falls between thread rows: a
  panel never holds a header, because a footer's header renders above its own panel.
* **Archived and snoozed names get the same treatment.** They are `thread-name` too and
  share `nameClass`. One name style across the list reads as one list, and the one-line
  rows grew by 2px like the others.
* **`text-inherit` after the role.** A type role sets its own colour (`--color-foreground`),
  which would have overridden the row's `text-sidebar-foreground/90` and the selected
  row's `text-sidebar-accent-foreground`. `text-inherit` keeps the name on the row's
  sidebar tokens; `label.tsx` already uses this pattern.
* **Status line unchanged.**

## Gotchas

* `text-inherit` and `text-muted-foreground` are both colour utilities. With both on the
  element, the winner would be whichever Tailwind emits later. `cn` drops the earlier
  one, so the muted class has to come after `text-inherit` in `nameClass` (the unit test
  checks a muted name has no `text-inherit`).
* e2e `sidebar.spec.ts` "thread rows sit 4px apart at both densities" measures real
  boxes in the mock (main list, Working and Snoozed panels) and resets the density
  setting at the end.
