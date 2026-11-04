# Wait list, daemon side: what a thread waits on, and Stop waiting (2026-11-04)

A user asked to see what a thread is waiting on and to be able to end the wait. This is
the daemon half; the strip above the composer is docs/notes/waiting-strip.md. The status,
the sidebar's "Waiting" word and the reason grammar are unchanged.

## Decisions

* **The list rides on WatchThread.** `ThreadItemsSnapshot.subscriptions` carries it (only
  from WatchThread, not ListItems) and `ThreadEvent.subscriptions` replaces it, the whole
  list, with no seq. A visible thread view already holds that stream, so nothing off
  screen holds anything and there is no second stream per view. It is ListSubscriptions'
  list, with every target kind.
* **No new field on Thread.** A pending wake is a subscription that exists, so the list
  says it, for the one thread that can show it. A `--repeat` subscription stays pending
  while it exists. Only what `waitingLocked` counts changes the status, as before: a pull
  request or timer subscription wakes the thread while it reads plain idle.
* **What sends a frame** (`internal/api/thread_wakes.go`, `wakeFeed`): `SubscriptionsChanged`
  for this thread, covering added, removed, fired and noted, plus a read every 15 s
  (`wakeRefresh`) for what has no event: a pull request's checks, a plugin's state, a timer
  coming due. A frame goes out only when the list differs from the last one sent. The
  read takes one mutex for one visible thread, and the GitHub poll behind a pull request's
  words is slower than 15 s anyway, so a hook per target kind was not worth it. A thread
  target's `target_status` in the list is only as fresh as that read: the GUI reads
  thread targets from its own thread list, which is live.
* **A held wake is listed.** A one-shot goes when it fires, but a settled wake about a lead
  whose team still works is held (docs/notes/ember-fixes-1-wakes.md), and it will wake the
  thread. `Subscriptions` lists it until it goes out and Unsubscribe by id drops it, so
  `thread subscriptions` shows it too. Holding and releasing publish
  `SubscriptionsChanged`; a held wake dropped with its target's removal shows at the next
  read.
* **`thread.stop-waiting`** (palette and CLI come from the registry; left out of the guide
  like `thread.shell.stop`: it is the user's control and the guide is at its cap). One RPC,
  `ThreadService.StopWaiting`, not the client looping, so the wakes go in one step under
  the subscription lock: every subscription of the thread, the wakes on their way to it,
  the wakes held for it. Then its shells, each through `StopShell` (one note each, SIGTERM
  then SIGKILL).
* **A wake on its way can be taken back until its Send starts.** A thread wake is not just
  queued: the drain pops the first one and keeps it through the batch window (1 to 5 s) and
  while the message is built, where clearing the queue cannot reach it. Those are
  `wakeQueue.taken`, by subscription; a stop or an unsubscribe marks them `dropped`.
  `deliverThreadWakes` skips them, looks again just before the Send (building reads items
  off the locks), and `holdLocked` refuses them, or a lead's wake would be held after the
  stop and bring the row and the wake back hours later. `dropped` is per subscription, not
  per batch: a new subscription that fires after the stop joins the same open batch and
  goes. The same path serves Unsubscribe, by id and by target, including a one-shot that
  already fired: `delivery.of` keeps the subscription, the only record left of it, so the
  call answers it instead of NotFound. A queue with everything taken back does not count as
  a wake coming (`spentLocked`), so the thread stops reading waiting at once, not when the
  window ends. A wake limit slot comes back through the existing refund.
* **Ember's thread refuses it** (`ErrFailedPrecondition`, in the store, so palette and CLI
  both get it): its wakes and timers run its board and nothing would bring them back. The
  command skips the question there, so the refusal is what the user sees. Reversible: the
  check is one `if` in `StopWaiting`. One wake at a time still works, `thread unsubscribe
  <id>`, which the board's × uses.
* **It confirms only when shells would stop**, naming them (`ConfirmIf`, `DynamicConfirm`);
  a shell is the one thing it ends. The yes is tied to what it named (`BindConfirm`,
  `shown-digest`): a shell started while the question was open refuses and stops nothing.
  One that ended meanwhile is fine, and `--yes` names no list, so it stops what runs. The
  check is in the command, against a fresh Get, so a shell started in the milliseconds
  between that read and the stop is not covered. The words say child threads keep working: it stops
  listening, it does not stop them. Subagents run to their end (nothing can stop one
  run), so a thread with subagents stays Waiting and the result says so.
* **Wakes held about the thread stay.** They belong to its subscribers: stopping a lead's
  wait must not swallow its parent's wake. `forgetHeldLocked(id)` drops both directions,
  so `dropWakes` does not use it for the id.

## Gotchas

* The test env sets `WakeBatch: -1`, so a wake never sits in a batch window there. That hid
  the take-back gap; anything about wakes in flight needs a real window (`withBatchWindow`
  in stop_waiting_test.go), and a queue built by hand proves nothing.
* A shell stopped at the prompt can still make Claude start a turn to report its end
  (`expectWake`, docs/notes/waiting-background-tasks.md), as `thread.shell.stop` does: after
  Stop waiting the thread may run one short turn. That is Claude's, not a wake.
* A shell that cannot be stopped is an error naming it, and the wakes are gone by then. A
  shell that ended meanwhile (`ErrNotFound`) is not an error.
* A reader of the strip's data must not clear the list on a WatchThread resync: the resync
  snapshot carries the list again.
