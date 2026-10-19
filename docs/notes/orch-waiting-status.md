# Waiting on child threads: no bell for a turn that only waits (2026-10-19)

From the orchestration battle test of 2026-10-19 (`/tmp/cf-exp2/results/REPORT.md`), A5:
a thread that ends its turn holding `--notify` subscriptions on busy children showed
"needs attention (finished)", rang the dock badge and bounce and sorted into the
attention group, so every review-loop round produced two bells that needed nothing (E2
§4 items 2-3, E5 friction 1, W2). Daemon status computation (`internal/store/thread`),
the sidebar row, its tooltip, and the CLI's status word.

## Decisions

* **No new proto status.** The thread is `IDLE` with the reason `waiting on N child
  threads` (`waiting on 1 child thread`; `waiting` alone while only a wake to it is
  queued). Idle is what it is to every reader that matters: `thread.Meets` (so
  `thread wait --until idle` returns for it, documented on `Meets` and here: a clause in
  `thread.wait`'s description put the guide 50 bytes over its 29,000-byte cap
  (`TestGuide`), so it was left out), `thread list --status idle`, the GUI's attention count (bell, window
  title, dock badge, bounce, sound: `attentionIds` counts status attention only, so the
  dock-alert gating needed no change), cmd+shift+a and the sidebar's idle group.
* **The rule** (`waiting.go`, `waitingLocked`): the thread's own status ("raw") is a
  plainly ended turn, needs attention `finished` or idle `at prompt`, and at least one
  target of its `settled`, `idle` or `attention` thread subscriptions is pending, or a
  wake to it is queued or being delivered. A target is pending while it is not settled
  (working, starting, being removed: its subscribers get a removed wake), or while it is
  itself waiting (a lead waiting on its workers keeps the orchestrator waiting), walked
  without returning to a thread already on the walk (a subscription cycle cannot keep
  itself waiting). An archived target's subscriptions are gone; a target asking a
  question or at a permission prompt is settled, so it is not waited on (the user owes
  it the answer, and the subscriber was woken for it). `error` and `disconnected`
  subscriptions are not waited on: a working thread does not reach them by finishing.
* **`at prompt` waits too.** The brief said "when the reason would be finished"; a
  viewed thread's finished turn becomes `at prompt` (Acknowledge), and without this the
  row would flip from Waiting to plain idle as soon as the user glanced at it, though it
  still waits. An interrupted turn (`at prompt` as well) that still holds subscriptions
  on working children waits for the same reason.
* **What wins**: a pending permission prompt or question, a turn error, the budget stop,
  the wake limit, "snooze ended", an interruption by the process's end: none is a
  plainly ended turn, so the overlay leaves them.
* **The normal flow takes over at the wake.** When the last child settles its wake is
  queued in the same commit, so the subscriber stays waiting (reason `waiting`) until
  the wake goes out; the wake's turn is busy, and its end is finished/attention as today
  (or waiting again, if it sent the child back to work). A wake to a running thread now
  publishes its busy at once instead of after the 100 ms status debounce (`stream.go`):
  the queue is gone when the delivery returns, and the busy must be there by then, or a
  commit in between would show "finished" for a moment, which is a bell. A stopped
  subscriber already went busy at once (`startStopped`).
* **An overlay, not a status the runner knows.** Every commit applies it
  (`commitLocked` -> `applyWaitingLocked`): the record keeps the raw status in
  `rec.wait` while the overlay shows, the snapshot, the bus and the database get the
  shown one. A commit of a thread re-evaluates its subscribers (`rewaitLocked`, with
  the subscriber list taken before the wake hook removes a one-shot that fired);
  Subscribe and Unsubscribe re-evaluate the subscriber. The shown status is a function
  of the raw ones and the wake queues, so one pass settles; a commit happens only when
  the shown status changes.
* **StatusChangedAt**: kept while the overlay shows the same reason (a raw change it
  hides, finished to at prompt, does not restamp it); the change's own stamp when the
  change set what is shown; now when waiting starts or ends.
* **A waiting row loads as finished.** The raw status is not persisted; at startup
  nothing runs and no wake is queued, so nothing is waited on: `unwaitLoaded` turns it
  into needs attention `finished` (the GUI's reconnect is a new epoch: no bell).
* **The CLI**: `thread list` prints `waiting (on 2 children)`, `waiting (on 1 child)`,
  `waiting`; elsewhere the status reads `idle (waiting on 2 child threads)`.
* **The GUI**: `lib/waiting.ts` (pure), a `waiting` status-line kind (muted, "Waiting",
  then the place), a muted lucide `Hourglass` before the word on line 2, and
  `TipWaiting` in the tooltip: "Waiting on 2 child threads" and the names of the working
  ones, five then "+N more". The GUI does not see subscriptions: the names are the
  thread's own children that are working or waiting, which is what `--notify` subscribes
  to. The Threads panel (lineage) folds waiting into its "Idle" word; a word of its own
  there is a follow-up if wanted.

## Gotchas

* A thread a test marks connected without a process (`setStep`) never receives a wake:
  Send loops on `errNotStopped`. With the overlay that shows as a subscriber stuck in
  `waiting` (its wake queued forever); `TestWaitingRule` sets the subscribers' after
  steps disconnected, so a wake starts them for real.
* A held lead wake (`heldLeadWake`) is queued, then dropped by the drain: the parent is
  waiting on the lead anyway (the lead waits on its workers), so nothing shows. A lead
  that runs workers without subscribing to them is not waiting, and its parent can then
  stay `waiting` (on the dropped wake) until its next commit.
* Wake headers about a waiting thread read `is idle: waiting on 2 child threads` where
  they read `needs attention: finished`; an `attention` subscription on a lead no longer
  fires when the lead ends a turn only to wait (it fires when the lead's turn ends with
  nothing left to wait on), a `settled` one (`--notify`) still does.
* Haiku 5.5 blocks a foreground `sleep N` (the harness asks for Monitor) and runs it in
  the background, so a "slow child" built on `sleep` ends its turn at once. The live
  check's children ran `python3 -c 'import time; time.sleep(240)'` instead.
* A `make check` failure to remember: the guide (`TestGuide`) is within 50 bytes of its
  29,000-byte cap, so a clause added to any command description can break it.

## Verified

* `make check` green; table tests `TestWaitingRule` (busy child, two of three busy, at
  prompt, no subscriptions, settled child, a child asking a question, archived child,
  child being removed, `error` subscription, question / permission / turn error / budget
  win, busy, a lead waiting on its worker, worker archived, a cycle),
  `TestWaitingUntilWake` (running and stopped subscriber: waiting, then busy, then
  finished, never finished in between; restart loads finished; unsubscribe ends it),
  `TestThreadStatusWordWaiting`, GUI `waiting.test.ts`, `TipWaiting.test.tsx`, the
  sidebar sort (`tree.test.ts`), `threadGroup`, `statusLine`, the row, `attentionIds` and a
  review-loop round through `startDockAlerts` (no badge, no bounce until the last turn).
* Live, isolated daemon (`CODE_FOUNDRY_HOME=/tmp/cf-build-orch-waiting-status`), the
  built GUI, a Haiku 5.5 orchestrator creating Haiku 5.5 children with `--notify`.
  `thread list` every 0.5 s: round 1 `busy` -> `waiting (on 1 child)` -> (child
  settled) `waiting` for the 1 s batch window -> `busy` -> `attention (finished)`.
  Round 2 with two children sleeping 240 s: `waiting (on 2 children)` for four minutes,
  `waiting (on 1 child)` when the first settled, `waiting` while the batched wake waited,
  `busy`, `attention (finished)`. The orchestrator was never `attention` between. The
  Dock badge read 1 (the first child's finished turn) while the orchestrator waited
  (`lsappinfo` StatusLabel), the bell 1, and the row sat in the idle group reading
  "Waiting · waiting-todo @ main" with the hourglass; the tooltip said "Waiting on 2
  child threads" with both names (dark and light screenshots in the PR).
