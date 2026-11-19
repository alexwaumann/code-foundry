# Notifications 3: the bell

The third of six steps of the notifications build: the GUI side of what step 1
(`notifications-1-store.md`) keeps. The bell in the top bar, its list of cards, the arrival
toast, and the dock badge and bounce for time-sensitive notifications. No daemon changes.

## What landed

| File | Holds |
| --- | --- |
| `src/api/notifications.ts` | the generated types mapped to view models (the only file that uses them) |
| `src/api/events.ts`, `src/stores/events.ts` | the event stream's `notification` source, one more registry entry |
| `src/lib/notifications.ts` | pure: the shown list, the count and its tone, a source's label, which arrivals toast (the cap and the burst), the time-sensitive arrivals |
| `src/stores/notifications.ts` | the snapshot, an event counter, the last event's time-sensitive arrivals, the bell's open state; narrow selectors |
| `src/stores/notificationActions.ts` | dismiss, snooze, act, clear (the `notification.*` commands) and the thread link |
| `src/stores/notificationToasts.ts` | the arrival toast through `notify` |
| `src/components/notifications/NotificationCard.tsx` | the card (`NotificationCard` takes a view, `NotificationItem` an id), for step 4's hover card too |
| `src/components/notifications/NotificationBell.tsx` | the bell, its popover and list |
| `src/lib/notify.ts` | `buttons` (a row of up to three, the first strong) and `closable` |
| `src/stores/dockAlerts.ts` | the badge adds the shown time-sensitive count; a time-sensitive arrival alerts |
| `mock/notifications.ts`, `mock/server.ts`, `mock/world.ts` | List, the source, the commands, `/__mock/notifications/*` |

## Decisions

- **No List on connect.** The source sends the whole snapshot on every connect, a reconnect and
  a resend after drops included, so a List would only race it. The store takes the source alone.
- **Baseline.** A connect's snapshot names no arrivals, so what is there on a connect or a
  reconnect never toasts or bounces; no epoch bookkeeping is needed on the GUI side.
- **Shown only.** The snapshot also holds snoozed and scheduled ones; the bell lists and counts
  `shown` ones, in the daemon's order (time-sensitive first, then the newest). The count takes
  the attention tone (the warning text slot, as Needs you's count) while a shown one is
  time-sensitive; with none the bell is the icon alone, its tooltip "Notifications".
- **Open state is a store value, not a command.** The Needs you popover's open is
  `setNeedsPopover`, not a registry command, and has no key; the bell matches it. No default
  keybinding: the neighbouring controls have none.
- **Clear all has no confirm.** It dismisses alerts, like Clear flags (`thread.flag.clear`),
  which does not ask; `memory.clear` and `search.clear` ask because they delete what the user
  made. Snoozed ones stay (step 1's rule), and a source posting changed content brings one back.
- **No success toasts** from the bell: the card leaving or the list emptying is the result
  (`toast-success-rule.md`). An action's run is quiet too, from the bell and from a toast: what it
  does shows by itself (a thread starts or gets the message, the browser comes forward, the card
  leaves when it resolves). A failure toasts at level error, "<button> failed" with the daemon's
  reason; dismiss, snooze and clear failures take the generic "<command> failed".
- **Snooze presets** are `lib/snooze.ts` `snoozePresets`, the thread snooze's four (1 hour,
  3 hours, Tomorrow, Next week, each with its time). `SnoozePresetItems` itself is the thread's
  (it runs `thread.snooze` and carries Save for later and the date dialog), so the card has its
  own small menu over the shared presets rather than bending that component. A notification has
  no Save for later (it needs a time to come back) and no date dialog in this version.
- **Source label**: a plugin's display name (the plugins store), "Code Foundry" for source
  `command` (what `notification.post` posts as: the CLI and agents), else the source as given (a
  plugin since removed).
- **The thread link** opens the thread's tab in its own space through the selection bridge
  (`thread.open --focus`), as a preview for an archived or snoozed thread (as the sidebar
  does), and shuts the bell. A thread the GUI does not know shows no link (the daemon withdraws
  a removed thread's notifications).
- **When the list shuts** (`bell-close-on-action.md`): at once for an action button or the
  thread link; after a dismiss, snooze or Clear all only when the user's own command emptied
  the list; never when a source withdraws the last one.
- **The list virtualizes past 40** (`VirtualStack`, measured rows, the list's own scroll box as
  its root): a source holds at most 100 active notifications and any number of plugins post.
- **Toast buttons.** sonner has one action and one cancel; a notification has up to three
  buttons. `notify` takes `buttons`, which it draws as one element on the card's button row
  (sonner draws an element given as the action as it is): the first in the strong style, the
  rest quiet, each running its onClick then closing the toast. Still the one toast function;
  the guard is unchanged.
- **Toast life.** A normal arrival stays 8 s (twice the default: it has buttons to reach;
  sonner pauses on hover), a time-sensitive one until closed. Both have the ×: closing a toast
  never dismisses the notification. A toast whose notification left the bell (acted on,
  dismissed, withdrawn, snoozed) is taken down, so no button acts on one that is gone.
- **The cap.** Within a burst (arrivals less than 2 s apart) the first two arrivals toast one
  by one and the rest count into one "N more notifications" toast (info, its count updated in
  place, Open opens the bell). A burst, not an event: a plugin posting five in a row sends five
  events. A time-sensitive arrival always gets its own toast, past the cap too, since it also
  bounces the dock. Nothing toasts while the bell is open; updated ids never toast.
- **Dock.** The badge is the attention threads plus the snapshot's `time_sensitive` count (0
  with the badge off). A notification event not looked at yet that brought a shown
  time-sensitive arrival alerts under the same settings, attended rule and shared cooldown as a
  thread entering attention. The threads' epoch baseline applies to threads only, so a thread
  snapshot in the same evaluation does not swallow an arrival. Normal arrivals never alert.

## Differences from the sketches (`bell.png`, `arrival-toast.png`)

- The header line is the source's name only: a notification has no kind field ("Failed",
  "Reminder" in the sketch), and the level is in the icon and the tone.
- The level icons are the toasts' own (info circle, triangle, octagon) rather than the sketch's
  per-plugin icons, which the model does not carry.
- The thread link underlines on hover (the `text-link` role) rather than always.
- The toast's buttons use the toast card's own neutral button styles (the first filled with the
  text colour) rather than outlined ones, so every toast's buttons look alike.
- The bell has no resting background; it takes the hover tint on hover and while open.

## Tests

- vitest: `api/notifications.test.ts` (every field, levels, statuses, action kinds, the event),
  `lib/notifications.test.ts` (order kept, count and tone, labels, baseline, update, open bell,
  the cap per event and per burst, a new burst, time-sensitive priority, time-sensitive
  arrivals), `stores/notificationToasts.test.ts` (the notice's level, title, body, buttons,
  life; a button runs `notification.act` with its number; a failure's toast; "N more" opens the
  bell; a toast goes with its notification), `components/notifications/NotificationBell.test.tsx`
  (the bell quiet, counted, urgent; the list's order, tint, empty state; Clear all, Dismiss,
  Snooze's presets and time, each action's number, the primary, the failure toast, the thread
  link and its preview, tooltips on the icon-only buttons), `lib/notify.test.tsx` (the button
  row, closable), `stores/dockAlerts.test.ts` (badge sum, bounce on a time-sensitive arrival
  only, attended, shared cooldown, epoch independence, through the real store).
- e2e `notifications.spec.ts`: the popover under the bell inside a 900 × 600 window, scrolling,
  holding the keyboard and handing it back on Escape; an arrival toast whose button runs the act
  and whose × leaves the notification shown; the thread link moving to another space.
  `SHOTS=<dir>` saves the PR's screenshots.

## Verified by hand

- Mock (`make drive`): each level, a time-sensitive one (tinted, first, the count in the
  attention tone), two naming a thread, snooze (the presets with their times), dismiss, act from
  a card (a send reached the thread) and from a toast, a failing act (the error toast), clear
  all (the empty line), the burst cap, the thread link into another space.
- Dev daemon (`make drive DAEMON=dev`) with the real CLI: `notification post` toasted and
  counted at once; posting the same key with `--time-sensitive` updated it in place (no second
  toast) and turned the count to the attention tone; a card's Dismiss, a 3-hour Snooze and
  Clear all showed in `notification list --all` as dismissed, snoozed until the time picked, and
  dismissed with the snoozed one kept.

## Gotchas

- WebKit's Tab skips buttons (Safari's default), so the e2e test checks the focus on the popover
  itself, not by tabbing into a card.
- A mocked `runCommandForResult` in a test needs a typed `vi.fn<…>` to read its call args under
  the type-aware lint.
