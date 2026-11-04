# Quiet rows tighter: Snoozed and Archived rows 24px and dimmed

GUI only. PR #531 set a 2px gap but the rows stayed 32px, so the space between two lines of
text only went from 18px to 12px and a user barely saw it. They asked for tighter and slightly
dimmer.

## What changed

| Path | What |
|---|---|
| `gui/frontend/src/components/sidebar/rowSizes.ts` | `ONE_LINE_ROW` (24), at both densities; `rowSize` takes only the row |
| `gui/frontend/src/components/sidebar/Sidebar.tsx` | `PanelRows` calls `rowSize` itself; the `sizeOf` prop and `useRowHeight` are gone |
| `gui/frontend/src/stores/settings.ts` | `ROW_HEIGHTS` and `useRowHeight` removed; `densityOf` stays for `html[data-density]` |
| `gui/frontend/src/lib/quiet.ts` | `QUIET`, moved from `PrRows.tsx`, now also for a `group/row` row's content |
| `gui/frontend/src/components/sidebar/SidebarRow.tsx` | `SingleLineLabel` takes `QUIET`, except while renaming |

## Decisions

* 24px is the 22px text-body line with 1px above and below. With the 2px gap that leaves 4px
  between two names (26px from line to line, was 34px).
* The dim goes on the row's content, not its box, so the hover and selection backgrounds stay
  full strength. A child cannot use `hover:` or `aria-selected:` for its parent's state, so
  `QUIET` gained `group-*/row` variants. It stays one string: on a PRs row the self variants
  apply, on sidebar content the group ones. There is no `group/row` in the PRs tables.
* "Under the cursor" in the sidebar is `data-cursor` on the row, not `aria-selected`.
* A row being renamed is not dimmed: the field is being typed in.
* 60% was kept, as the app's existing style. Against the sidebar background the name's contrast
  is 3.28:1 in dark (7.46:1 undimmed) and 2.53:1 in light (5.71:1 undimmed), default themes.
  It reads in both, but light is under 3:1, because 60% stacks on the already muted colour.

## Density

Row height was the last thing `appearance.density` changed: no CSS reads `html[data-density]`.
So after this change Settings → Appearance → Density has no visible effect. The setting lives
in the daemon's schema, so removing it is a separate decision and is not done here.

## Checked in WebKit (mock), at 100% and 90%

* Name, age or alarm + time inside the row; nothing clips vertically, descenders included.
* A long name truncates with an ellipsis and leaves the time in place.
* The focus ring (inset) and selection radius show on all sides. The 22px rename field fits
  inside the row.
* Footer cap in a 520px window: the panel holds at the cap (113px), End scrolls the last row
  into view, and arrowing back keeps the cursor row in view.
* Quiet rows have no hover actions today (`SidebarRow.test.tsx` pins that). `ACTION_BUTTON`
  controls are 20px, so they would fit a 24px row if a later change adds them.

## Gotchas

* `src/components/prs/PullRequestsPage.test.tsx` hits vitest's 5s timeout at load average 130+
  (four failures, cascading from the first). It passes with a longer timeout.
