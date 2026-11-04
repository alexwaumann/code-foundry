# Quiet row gap: Snoozed and Archived rows 2px apart

GUI only. The one-line rows of Snoozed and Archived sat 8px apart, the gap meant for three-line
thread rows, so a short list looked loose.

## What changed

| Path | What |
|---|---|
| `gui/frontend/src/components/sidebar/rowSizes.ts` | `QUIET_ROW_GAP` (2) and `rowGap(section)`; `rowSize` and `rowGap` share one test for "one-line section" |
| `gui/frontend/src/components/sidebar/Sidebar.tsx` | `PanelRows` takes a `gap`: `ROW_GAP` for the main list, `rowGap(section)` for a footer |
| `gui/frontend/e2e/sidebar.spec.ts` | the measured snoozed gap is 2; a SHOTS block for the PR's screenshots |

## Decisions

* 2px as asked; checked in WebKit at both schemes. The rows' own padding (3px or 5px) already
  separates the names, and a hover or selection background still leaves a visible seam.
* Working stays at 8px: its rows are three lines.
* Nothing else needed changing. The footer's height is `min(virtualizer total, cap)` and
  scroll-to-row is the virtualizer's, so both follow the panel's `gap`. The caps
  (`FOOTER_CAPS`) are fractions of the sidebar body, not row counts.
