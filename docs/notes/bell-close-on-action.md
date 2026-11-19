# When the bell's list shuts

A user found the bell's popover staying open after they had acted on a card, and sitting on
"No notifications." after they had dismissed the last one. The rules agreed with them:

| Click in the list | The list |
| --- | --- |
| A card's action button (Open PR, Review in a thread, Send to thread, any plugin action) | shuts at the click, not waiting for the result |
| The card's thread link | shuts (as before) |
| Dismiss or Snooze while other shown notifications remain | stays open |
| Dismiss or Snooze of the last shown one | shuts |
| Clear all | shuts |
| Nothing: the source withdraws the last one | stays open on "No notifications." |

## Decisions

- **All in `stores/notificationActions.ts`**, beside the thread link's `setBellOpen(false)`. The
  card, the bell and the store's open state are unchanged, so the work on the bell's trigger
  rebases cleanly, and the row hover card and the arrival toasts run the same functions: with
  the bell shut there, shutting it is a no-op. A toast's button pressed while the bell happens
  to be open shuts it too, the same rule as the card's button.
- **An action shuts at once.** If it then fails, the error toast ("<button> failed") reports it
  and the notification is still in the bell when it is opened again; the bell is not reopened.
- **"Emptied the list" is decided from the click's list.** `notification.dismiss`'s result and
  the snapshot that drops the card arrive separately, in either order, so the result's moment
  cannot look at the store to see whether the list is empty. At the click the actions take the
  shown ids; after a successful result the bell shuts if the command took away all of them (a
  dismiss or snooze of the one card listed; any Clear all) and no id the click did not see is
  shown now.
- **A new arrival keeps it open.** An arrival does not toast while the bell is open, so shutting
  the bell after the user emptied it would hide one that came in meanwhile.
- **A failure keeps it open**: `runCommandForResult` gives null, and the generic error toast
  says why.
- **A withdrawal never shuts it**: only the user's dismiss, snooze and clear call the check, so
  the snapshot emptying by itself leaves the list open on "No notifications."
- **Shown only.** Snoozed and scheduled notifications are not in the list, so dismissing the
  last shown one shuts the bell with snoozed ones still waiting.
- **Snooze's menu** shuts on picking a preset (Radix, before the command runs); the list shuts
  after the result, only when that was the last card.

## Tests

vitest `components/notifications/NotificationBell.test.tsx` "when the list shuts": every row of
the table, the action shutting before its result and its failure, both orders of result and
snapshot, a failed dismiss and a failed Clear all, a snoozed and a scheduled one left behind,
an arrival meanwhile, the withdrawal. No e2e: no geometry or focus is involved.
