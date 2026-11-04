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
  the subscription lock: every subscription of the thread, the wakes queued for it, the
  wakes held for it. Then its shells, each through `StopShell` (one note each, SIGTERM
  then SIGKILL). A wake being delivered at that moment is past stopping.
* **It confirms only when shells would stop**, naming them (`ConfirmIf`, `DynamicConfirm`);
  a shell is the one thing it ends. The words say child threads keep working: it stops
  listening, it does not stop them. Subagents run to their end (nothing can stop one
  run), so a thread with subagents stays Waiting and the result says so.
* **Wakes held about the thread stay.** They belong to its subscribers: stopping a lead's
  wait must not swallow its parent's wake. `forgetHeldLocked(id)` drops both directions,
  so `dropWakes` does not use it for the id.

## Gotchas

* A shell stopped at the prompt can still make Claude start a turn to report its end
  (`expectWake`, docs/notes/waiting-background-tasks.md), as `thread.shell.stop` does: after
  Stop waiting the thread may run one short turn. That is Claude's, not a wake.
* A shell that cannot be stopped is an error naming it, and the wakes are gone by then. A
  shell that ended meanwhile (`ErrNotFound`) is not an error.
* A reader of the strip's data must not clear the list on a WatchThread resync: the resync
  snapshot carries the list again.
