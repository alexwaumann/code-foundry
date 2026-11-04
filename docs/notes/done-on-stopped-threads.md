# Done on stopped threads

A user reported sidebar rows that kept "Done" after being opened. Status: fixed on
`cf/done-stopped-threads`.

## The bug

Only a runner acknowledged a thread. `addViewer` called `viewersChanged` and
`AttendedChanged` called `attendedRose` only when `rec.run != nil`, and `runner.finish`
keeps the status it had at the stop. So a stopped thread kept NeedsAttention "finished"
until the next message. This happens after an idle stop at prompt cache expiry and after
every daemon restart or update, which stops all running threads.

## The rule

A thread with no runner, with a viewer, while presence is attended, is seen exactly as a
running one would be. `Manager.seenStoppedLocked` (attended.go) turns what
`streamStatus.Acknowledge` clears into Idle "at prompt": "finished", "error: <code>",
`ReasonBudgetReached` and `ReasonWakeLimit`. The budget stop has no "once its turn ended"
condition here because a stopped thread's turn has ended.

It is an allow list (`clearedWhenSeen`), so everything else stays: permission and
question reasons (a plan prompt is a permission), `ReasonSnoozeEnded`, StatusError
interrupted or crashed, and any archived thread's status.

Not attended, nothing changes, so the Dock badge and alerts work. With no viewer, nothing
changes (`TestIdleStopAtCacheExpiry`).

## Triggers

All three go through the one helper, under m.mu:

1. A viewer opens while attended: `addViewer`, through `seenLocked`.
2. Presence rises with a viewer open: `AttendedChanged`, through `seenLocked`.
3. The runner detaches: `detach`. Without this the status is lost two ways: the
   `viewersChanged` signal reaches a runner that no longer reads it, or the viewer's
   acknowledge is undone because `finish` restores `closeStatus`.

`seenLocked` persists only when the status changed; flags have their own table and keep
their unpersisted commit. `detach`'s update persists already.

## Decisions and gotchas

- The helper reads `rec.rawStatus()`, not `rec.s.Status`. A stopped thread can show the
  waiting overlay over a raw "finished". The raw status is what is seen, the row keeps
  showing waiting with its `StatusChangedAt` (`applyWaitingLocked` keeps the stamp), and
  it falls back to "at prompt" rather than "finished". Same as a running thread.
- A reminder turn (`rec.wait.reminder`) shows "finished" over the overlay. Once seen it
  waits again, which is what waiting_reminder.go already says.
- Detach also covers `reportedAtStop`: a shutdown that cut a turn with a final report
  ends "finished", and a viewer there while attended sees it at once.
- `rec.archiving` is checked as well as `ArchivedAt`: the archive's close detaches the
  runner before `ArchivedAt` is set.

## Wakes and subscriptions

Read subscriptions.go, subscriptions_fire.go and subscriptions_hold.go. The status change
cannot fire anything, with or without a runner:

- `observeLocked` fires only on a transition into a condition. All four cleared reasons
  meet `CondIdle` and `CondSettled` (`idleNow` counts NeedsAttention that is not a
  permission or question), and so does Idle: no rise. `CondAttention` goes true to false.
  `CondError` looks at StatusError, which none of them is. `CondDisconnected` looks at
  the state. `requestKey` is empty, so no new-request fire.
- The attention subscription is left unsatisfied, so the thread's next real attention
  fires it. Same as finished to idle on a running thread.
- Held lead wakes: `quietLocked` is settled before and after, and every commit already
  calls `releaseHeldLocked`, so nothing new is released.
- One real effect: "error:", budget and wake limit do not `canWait`, and "at prompt" does.
  Seeing such a thread with pending targets makes it show waiting, and a thread
  subscribed to it can follow (`rewaitLocked`). That is the running thread's behaviour
  and the right one: it will be woken. `TestStoppedSeenRewaitsSubscribers` pins it.

`TestStoppedSeenFiresNoWake` covers all five conditions against all four reasons.

## Left as is

- A viewer opening in the moment a start is reserved, whose start is then refused for a
  missing transcript: `refuseStart` restores the status from before the reservation, so
  "finished" comes back until the thread is next opened.
- A restart turns a waiting row back into "finished" (`unwaitLoaded`) even if its raw
  status was seen, because the raw status is not saved. Running threads do the same.
- A wake-limit note set on a stopped thread that is already viewed stays until the view
  reopens or presence rises; none of the three triggers fires, as on a running thread.

## Verified

Table tests in attended_test.go and attended_stopped_test.go; disabling the helper, the
detach call, the raw status read or the archive checks each fails them. End to end with
`make drive DAEMON=dev` on a scratch home and a scratch `CLAUDE_CONFIG_DIR`, the fake
claude behind `advanced.claude_path`: a thread finished unviewed, a daemon restart left it
disconnected "finished" and the sidebar showed Done; opening it in WebKit, attended, gave
Idle "at prompt" and the tag went; after another restart with no GUI it stayed so. There
is no CLI verb to stop a thread, so the daemon restart was the stop. The idle stop and the
rise were exercised only in the tests.
