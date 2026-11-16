# Notifications 4: the row mark

The fourth of six steps of the notifications build. A thread that shown notifications name gets a
small bell and count on its sidebar row, the row's hover card lists those notifications with their
buttons, and the GUI's display of plugins' flags goes, since step 6 reroutes `thread/setFlag` to
a notification naming the thread. Frontend and mock only.

## What landed

| File | Holds |
| --- | --- |
| `src/lib/notifications.ts` | `threadNotifications` (a thread's shown ones, daemon order) and `threadMark` (count and tone; one shared `NO_MARK`) |
| `src/stores/notifications.ts` | `useThreadMark`, `useThreadNotificationIds`: narrow selectors per thread |
| `src/components/sidebar/NotificationMark.tsx` | the mark, drawn by `RowCounts` before the PR tag |
| `src/components/sidebar/TipNotifications.tsx` | the card's Notifications section |
| `src/components/sidebar/SidebarRow.tsx` | `ThreadTooltip`: hoverable while the thread has notifications, held open over its own tooltips and menus, presses kept in the card |
| `src/components/notifications/NotificationCard.tsx` | `hideThread` and `onMenuOpenChange` options |
| `src/stores/openThread.ts` | what `selectThreadAndFlag` did, without the flag surface |

## Decisions

- **Where it shows.** On line 3 with the counts (agents, shells, mark, PR tag, 8px apart), so on
  every row that draws that line: Active, pinned, Working. A thread without a project gets line 3
  for the mark alone, as it does for a PR tag or counts. Not on a Needs you row or the top bar's
  popover rows: they have no counts line (no PR tag either), their card is the ask's, and Needs
  you is about the thread's own requests; once answered the thread is back in Active with its
  mark. Not on Snoozed or Archived rows: one quiet line with no badges, by design
  (`sidebar-quiet-rows.md`). Their hover card is the same `ThreadTooltip`, so it still lists the
  notifications.
- **Tone.** Error when one is an error; else the attention (warning) tone when one is
  time-sensitive or a warning; else the row's muted tone. Shown ones only: snoozed and scheduled
  ones wait outside the mark as they do outside the bell.
- **No tooltip on the mark.** It is not a control and hides nothing the card does not show: the
  row's hover card lists the notifications themselves. Its `aria-label` ("2 notifications") is for
  screen readers, like the agent and shell counts beside it.
- **Narrow selectors.** `threadMark` returns the one `NO_MARK` for a thread nothing names and
  `useShallow` compares `{count, tone}`, so a row re-renders only when its own count or tone
  changes (`TipNotifications.test.tsx` counts renders with a `Profiler`).
- **The card stays a Radix tooltip.** Radix 1.2 puts `role="tooltip"` on the content itself (no
  visually hidden copy), so its buttons are not doubled. With notifications it is hoverable
  (`disableHoverableContent` off: Radix's grace area lets the pointer cross the 12px gap); without
  them it is the plain card it was and shuts as the pointer leaves the row. Whether it is hoverable
  is fixed while it is open: switching modes remounts Radix's content, and a card whose last
  notification was dismissed from inside it would be left open with no leave event to shut it.
- **Holding it open.** Radix shuts every open tooltip when another opens (a card's Snooze or
  Dismiss tooltip) and shuts a hoverable one when the pointer leaves it for a portalled menu. The
  card ignores a close while the pointer is in it (React's enter and leave, which count its
  portalled menus as inside) or while a card's snooze menu is up (`onMenuOpenChange`). When the
  pointer leaves or the menu shuts it checks `:hover` on the row and the card, and shuts if
  neither. Escape always shuts it.
- **Presses stay in the card.** React brings events from the portalled card to the row: the
  content stops click, pointerdown, double click, context menu and keydown, and the row's
  close-on-press ignores presses outside its own DOM. Otherwise a card button would open the
  thread, start a drag or shut the card.
- **Width.** 340px with notifications (the card's cards need the room for three buttons), 260px
  without, as before. The section is last, runs to the card's edges and foot, and scrolls past
  320px (`max-h-80`).
- **Order** is the daemon's, as in the bell: time-sensitive first, then the newest.
- **Keyboard.** The card stays pointer only, as before; the bell is the keyboard's way to the same
  notifications.

## Flags removed

After step 6 `Thread.flags` is always empty. Gone from the GUI: the `flagAttention` and
`flagError` status kinds (registry entries, the plugin name as the status word, the reason as a
detail, their cases in Ember's and the lineage's status), `topFlag` and flags in `threadGroup`
(sorting) and `isAttention` (window title, dock, space counts), `ThreadFlagView` and its mapping
(`toThreadView` ignores the field, tested in `api/threadFlagsIgnored.test.ts`), `sameFlags`, the
thread info card's flag notes and mark on the project row (the old header chip's place), the
title and row menus' Clear flag(s) (the GUI's only `thread.flag.clear` call; the daemon's verb
stays), `stores/flagSurface.ts` (a row click opening the flagging plugin's surface), and in the
mock the flags world state, `POST /__mock/thread/flag`, the until-seen clearing and the mock's
`thread.flag.clear`. The Needs you card's branch for an ask with no request stays: a woken
snooze still takes it. `e2e/plugin-gaps.spec.ts` had only the flag test left and went with it.

## Mock

Nothing added: `POST /__mock/notifications/post?…&thread=s-3` names a thread.

## Tests

- vitest: `lib/notifications.test.ts` (a thread's list: shown only, order, none; the mark's count
  and tone precedence, `NO_MARK`), `shell/ShellSidebarList.test.tsx` (the mark on Active, pinned
  and Working rows, none on Needs you, Snoozed or Archived, no section or status change, the
  counts line for a thread without a project, gone when snoozed), `TipNotifications.test.tsx` (the
  section's cards and order, last in the card, no thread link, the scroll cap, width and
  hoverable only with notifications, `notification.act` with the id and number, Dismiss kept from
  the row, the hold over another tooltip and the snooze menu, a plain card still shutting, the
  narrow selector), `api/threadFlagsIgnored.test.ts`.
- e2e `sidebar-notifications.spec.ts`: the mark on the PR tag's line, before it, 8px apart, at
  the 240px sidebar; the pointer from the row across the gap onto a card's button, a corner
  tooltip not shutting the card, Dismiss twice until the mark goes, the card shutting as the
  pointer leaves. It fails with the card made non-hoverable. `SHOTS=<dir>` saves the PR's shots.

## Gotchas

- Radix's tooltip listens for `tooltip.open` on the document; a unit test dispatches it to stand
  for a corner button's tooltip opening.
- jsdom never matches `:hover`, so in a unit test the card shuts on the content's pointer leave;
  in WebKit moving back to the row keeps it.
