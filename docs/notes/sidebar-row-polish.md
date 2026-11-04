# Sidebar row polish: a plain PR tag, text row actions, 8px between rows

GUI only. Feedback from a user, design settled with the owner before the build.

## What changed

| Path | What |
|---|---|
| `gui/frontend/src/components/sidebar/LinkedPrsBadge.tsx` | no background (`toneTint`, `rounded-sm`, `px-1` gone), `hover:underline`, no `data-quiet` |
| `gui/frontend/src/components/sidebar/SidebarRow.tsx` | row actions without `Tip`s or chip; Archive is a `Check` and the word; `QUIET` logic removed; a press anywhere in the row shuts the card; the actions' slot is 97px |
| `gui/frontend/src/components/sidebar/rowSizes.ts` | `ROW_GAP` 4 to 8 |
| `gui/frontend/e2e/sidebar.spec.ts` | the 8px gap; real pointer moves keeping the card open; the actions' geometry at 260px |

## Decisions

* This reverses #434 on purpose: the row's hover card now stays open over the linked PR tag
  (docs/notes/sidebar-pr-tag-plus.md said it stayed shut). The underline says the tag is
  clickable, and the card shows what the tag only hints at.
* No `Tip` is left inside a thread row: `NoGitBadge` is rendered with `tip={false}`, and the
  snooze menu's contents are portalled. So `QUIET`, `QUIET_HOVERED`, the `onPointerOver`
  branch and the trigger's `ref` all went. The `onFocus` preventDefault and the portal guard
  in `onPointerMove` stay.
* The actions' slot is `min-w-[97px]`: Snooze 20 + gap 4 + Archive 66.5 is 90.5px, plus the
  slot's own 6px left padding (`min-w` counts padding under border-box). Measured in WebKit
  at the 260px sidebar: a long project name ends 6.5px before the actions, on a selected row
  too. `SIDEBAR_DEFAULT` and `SIDEBAR_MIN` are both 260.
* Archive keeps `px-1`, so the word ends 4px inside the status's right edge, as in the sketch,
  and the focus ring has room.
* The status under the actions is `invisible`, so it paints nothing without the chip behind
  it. Checked in the browser for a time and for a status word.

## Gotchas

* Removing the snooze `Tip` exposed a bug it had been hiding: a click on Snooze left the card
  open behind the menu. The Radix menu trigger calls `preventDefault` on the press that opens
  it, and Radix's `composeEventHandlers` then skips the tooltip trigger's own close on that
  same event as it bubbles to the row; `RowActions` stops the click, so the close on click
  never runs either. The old `Tip` hid this, because the card was already shut over the
  button. `onPointerDownCapture` on the row's trigger now shuts the card first, for any press
  in the row. A vitest pins it and fails without the capture.
* `text-caption-sm` sets a colour of its own. On the Archive button `text-cf-icon-muted` and
  the hover colour still win; checked as computed styles in WebKit.
* Line 1's `textContent` now includes "Archive" even at rest (the actions are only
  transparent), so the row tests read it through `line1Text`.
* The mock's clock reorders rows, which moves coordinates under a slow `playwright cli`
  session. Hold the threads (`/__mock/thread/hold`) and run the whole flow in one `run-code`.
