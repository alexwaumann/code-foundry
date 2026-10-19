# Wakes across a daemon restart (2026-10-19)

From the orchestration battle test of 2026-10-19 (`/tmp/cf-exp2/results/REPORT.md` A1;
E8 §4.1, §4.2, candidate improvements 1 and 2). A daemon stop (app update, quit, crash)
interrupted a busy child (`error (interrupted)`, "daemon stopped"), its settle wake was
dropped on purpose ("wake not fired: the daemon is stopping"), and the restarted daemon
armed the subscriptions with the targets as loaded, so nothing ever told the
orchestrator: its "I'll tell you when it's done" never came. Daemon wake engine
(`internal/store/thread/subscriptions_restart.go`), migration 0037, one call in the
daemon, the GUI's wake note. Follows `agents-4-wake.md`, `wake-detail.md` and
`orch-wakes-content.md`.

## What changed

* **Suppressed wakes are recorded.** A thread wake that fires while the Manager is
  closed (`fireLaterLocked`) sets `thread_subscriptions.suppressed_at` (migration 0037,
  `Subscription.SuppressedAt`) and is logged `wake not fired: the daemon is stopping; it
  goes at the next start`. Run, pull request and plugin wakes are still only logged
  (runs do not outlive the daemon; the others keep working after a start).
* **`Manager.DeliverRestartWakes`**, called once by the daemon after its servers listen
  (`internal/daemon/daemon.go`), plans from the subscriptions and threads at that moment
  (`planRestartWakes`, pure):
  * a suppressed fire goes when its target still meets the condition or was
    interrupted by the stop, at its recorded time (`fired_at`); else it is just
    cleared;
  * with nothing suppressed (a crash records nothing; New marks the lost rows
    `error (interrupted)`, "daemon restarted"), a settled, idle, attention or error
    subscription fires when its target was interrupted by a stop
    (`interruptedByStop`: stopped, error "interrupted", disconnect reason "daemon
    stopped" or "daemon restarted") after the subscription last fired
    (`StatusChangedAt > LastFiredAt`). So a child left interrupted is not announced
    again at every later restart. One-shots fire too (and go);
  * one fire per subscriber and target, the oldest subscription's (as the removed wake);
  * a subscriber gets a **restart notice** when it has one of those fires, or the stop
    cut its own turn.
* **One message per subscriber**, through the batch path: the notice is a `delivery`
  with `restart` set (batched like a thread wake, one wake limit slot), carrying its
  thread wakes; thread wakes queued in the window join it after them.

  ```
  [code-foundry wake] The app restarted at 10:45 CDT; 2 of your child threads were interrupted: "Tests" (s-1), "Docs" (s-2); their sessions resume on your next send. 2 threads interrupted: Thread "Tests" (s-1) was interrupted when the app stopped. Report: progress — halfway. Thread "Docs" (s-2) was interrupted when the app stopped.
  ```

  JSON: the notice alone is `{"kind": "restart", "restarted_at", "interrupted": [{id,
  name, reason}], "subscriptions": n}` (`own_turn_interrupted: true` when its own turn
  was cut: the line then says `; your own turn was interrupted`); with thread wakes it is
  `{"kind": "batch", "wakes": [<notice>, <thread payloads with "after_restart": true>]}`.
  `reason` is the disconnect reason ("daemon stopped", or "daemon restarted" after a
  crash). The batch header says `N threads interrupted:` when the stop interrupted every
  one, else the usual `N threads settled:`; the siblings sentence is left out after a
  restart line (every child is stopped then; the JSON still has the counts). A thread
  wake about an interrupted target reads `Thread "X" (id) was interrupted when the app
  stopped.` plus its current report.
* **Archived or removed meanwhile.** The plan only takes live threads (not archived,
  not being removed, not closing). At send time (`restartWakes.keepLive`) the thread
  wakes about targets archived or removed since, and their names in the notice, are
  dropped, and the whole message when nothing is left; the subscriber check of
  `deliverThreadWakes` applies as before.
* **GUI**: `wakeLines` draws the notice as its own "Woken by App restart: 2 interrupted ·
  Tests, Docs" line (attention tone when anything was interrupted), first in a batch.

## Decisions

* **No restart notice for a subscriber with nothing to hear.** The brief said every
  thread holding live subscriptions; but `--notify` subscriptions on children long done
  stay (repeat), so every app update (tip channel: often) would start a turn in every
  orchestrator that ever ran, on a cold cache after the restart. The notice goes when a
  watched thread was interrupted or a suppressed wake goes, or the subscriber's own turn
  was cut (an orchestrator mid-turn at the stop resumes by itself). Pull request and
  plugin subscriptions carry on through a restart and need no notice. Threads with no
  subscriptions get nothing, as asked.
* **Delivery waits for the daemon, not just the store.** `New` already has every row
  stopped and repaired, but the daemon sets spawn extras, plugin wakes and the skills
  after it, and a woken thread starts a Claude process that calls the CLI back; so the
  daemon calls `DeliverRestartWakes` once the API serves. There is no CLOSING snapshot
  at that point (the trap of `removed-thread-signal.md`): every runner of the old
  daemon is gone and nothing has started except what a CLI call started meanwhile, whose
  target then does not meet the condition and only has its suppression cleared.
* **"child threads"** in the notice are the subscription targets the stop interrupted,
  whoever created them; children created without `--notify` are not counted (the
  subscriber did not ask to hear about them).
* **No skill change.** Skill v3 (#240) already says "After the app restarts (a wake says
  so, or the user does) …".

## Gotchas

* The thread package's test env turns batching off; the notice and its thread wakes are
  one delivery, so they are one message either way.
* `fired_at` of a re-delivered wake is when the stop suppressed it (or when the target
  was interrupted); `LastFiredAt` is the delivery time, which is what keeps the fallback
  from firing again at the next restart.

## End to end (2026-10-19, isolated home, Haiku 5.5 medium)

`make build`; daemon `CODE_FOUNDRY_HOME=/tmp/cf-build-orw code-foundry daemon --dev`,
`threads.default_model 'claude-haiku-5-5[1m]'`, effort medium; scratch project
`~/cf-exp2-scratch/orw-todo` (from `todo-template`, bare origin). A Haiku orchestrator
(s-21f8f655911b) made two `--notify` children: Quick (reports done at once) and Slow
(`ping -c 120`, then reports done), and was told to resume an interrupted helper when
woken. Once Quick's wake turn had ended and Slow was about 30 s into its ping, the daemon got
SIGTERM and was started again by hand; the orchestrator got no user message after that.

Old daemon:

```
09:59:12.484 thread disconnected thread=s-4095ec346835 (Slow) reason="daemon stopped"
09:59:12.484 wake not fired: the daemon is stopping; it goes at the next start subscriber=s-21f8f655911b subscription=sub-f7383c4875f9 target=s-4095ec346835 condition=settled
```

New daemon:

```
09:59:12.668 daemon started
09:59:12.668 wake subscription fired after the restart subscription=sub-f7383c4875f9 target=s-4095ec346835 interrupted=true fired_count=1
09:59:12.668 restart wake queued thread=s-21f8f655911b interrupted=1 wakes=1 own_turn_interrupted=false subscriptions=2
09:59:13.679 woke thread thread=s-21f8f655911b wakes=1
```

`thread read s-21f8f655911b --full` (cut):

```
#12 wake: Thread "Quick" (s-e157d0a8ff48) needs attention: finished, said more after its report. Report: done — quick check ok. 1 of your 2 child threads settled; still working: "Slow" (s-4095ec346835).
#15 turn end: success, 1.4s
#16 wake: The app restarted at 09:59 CDT; 1 of your child threads was interrupted: "Slow" (s-4095ec346835); its session resumes on your next send. Thread "Slow" (s-4095ec346835) was interrupted when the app stopped.
#18 claude: Slow was interrupted when the app restarted, so I'm resuming it.
#19 tool Bash [done] code-foundry thread send --id s-4095ec346835 "Continue your task from where you stopped."
#21 turn end: success, 4.0s
#22 wake: Thread "Slow" (s-4095ec346835) needs attention: finished, said more after its report. Report: done — slow wait finished. All 2 of your child threads settled.
#23 claude: ALL DONE
```

The wake's JSON: `{"kind": "batch", "wakes": [{"kind": "restart", "restarted_at":
"2026-10-19T14:59:12.668Z", "interrupted": [{"id": "s-4095ec346835", "name": "Slow",
"reason": "daemon stopped"}], "subscriptions": 2}, {"kind": "thread", "subscription_id":
"sub-f7383c4875f9", "condition": "settled", "fired_at": "2026-10-19T14:59:12.484Z",
"after_restart": true, "thread": {… "status": "error", "status_reason": "interrupted",
"report": null, "report_stale": true, …}}]}`. Slow resumed its own session
(`--resume`), reran the ping (130 s) and reported done; its wake went through the same
pre-restart subscription. One wake for the restart, none before or after it; no ERROR
lines in either daemon log. Daemon stopped afterwards.

## Daemon restart

Needed: the wake engine and a migration are daemon code. The GUI change is the wake note
only.
