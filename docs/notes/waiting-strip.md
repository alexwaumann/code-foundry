# The waiting strip: see what a thread waits on, and end the wait (2026-11-04)

A user asked to see what will wake a thread and to be able to kill the wait. GUI half; the
list and `thread.stop-waiting` are docs/notes/wait-list-daemon.md. Option A of the renders:
a strip above the composer, collapsed by default, one row per thing when expanded.

## Decisions

* **It shows whenever anything will wake the thread**, whatever its status: a subscription
  of any kind, a background shell, a background subagent. A pull request or timer wake on a
  thread that reads plain idle shows it; so does a busy thread holding `--notify`
  subscriptions, and a `--repeat` subscription while it exists. Status, the sidebar's word
  and the reason grammar are untouched.
* **It takes AgentsStrip's place in a thread's pane, always.** A running background subagent
  is itself a wake, so the two would show together; the strip's subagent rows keep the
  run's name as the link into the subagent view, and its activity. Collapsed, the runs are
  a count until the chevron is pressed. AgentsStrip stays in Ember's chat, which has no
  waiting strip: its wakes are the board's, and Stop waiting there would take them away. The
  daemon refuses the command on its thread too, for the palette and CLI.
* **Nothing shows until the Watch has said what is current** (`useWaitListCurrent`). A closed
  Watch keeps its log for the next visit, so a return would otherwise show the rows from
  when the thread was left, with a live Stop waiting. The strip needs this Watch's snapshot,
  and hides while the stream is `retrying` or `stopped`, so a Watch that cannot open leaves
  no stale rows. `connecting` with a snapshot in hand stays up: that is the resync on return
  to a visible window, and hiding there would blink it. Expanded state survives the gap.
* **A row gone under the press is not a failure.** NotFound from the × or a shell's Stop
  means the wake went or the shell ended, which is what was pressed for: no toast, the row
  leaves with the list. Any other failure toasts as before. `stopShell` is shared with the
  thread info card, which gets the same.
* **Where each row's status comes from.** A thread target reads the thread list (live,
  the sidebar's words, "Working · Bash make check"); only a thread gone from the list falls
  back to the daemon's `target_status`. Every other kind shows `target_status`, a pull
  request's without "open · ". A timer is named by its note. A note on anything else is
  hidden information, so it is the name's tooltip; otherwise the tooltip is the name, only
  when cut off.
* **Counts are of targets, rows are of subscriptions.** Two subscriptions to one pull
  request are "1 PR" and two rows, each with its condition so the two can be told apart;
  each × is one `thread.unsubscribe` by id.
* **Stop waiting is hidden with only subagents left**: there is nothing it could do, and the
  strip stays up with those rows until they end. `thread.stop-waiting` asks the question
  (ConfirmationRequired); the GUI has no words of its own for it.
* **No sidebar item** for it: the strip is the only surface, with the palette and CLI the
  registry gives every command.
* **TipWaiting left alone.** It still reads correctly: it only speaks for a thread whose
  reason says waiting, and names busy children. It says nothing of pull requests or timers,
  which the reason does not count either, so it does not contradict the strip.
* **The log's `wakes` is optional** (absent: none) so the many `ThreadLog` literals in tests
  and timeline fixtures did not all change for a field they do not read.

## Gotchas

* The chevron turns over 150ms. A screenshot right after the click catches it mid-turn; the
  shots wait for `rotate: 90deg`.
* `WakeView` is already the "Woken by" timeline item (`api/thread.ts`), hence
  `WakeSubscriptionView`.
* A `subscriptions` event has no seq: `applyThreadEvent` takes it before the seq check, or
  every frame after the first would be dropped.
* The strip is keyed by thread in ThreadPane, so another thread starts collapsed without an
  effect resetting state. Its key is `wait:<id>`: the composer beside it is keyed by the bare
  id, and two siblings sharing a key is a React error on every render, which vitest did not
  see (it does not render ThreadPane) and only a spec watching the console did.
* The mock's `seen()` turns a finished turn into "at prompt"; a thread with wakes skips that,
  or state=waiting would read plain idle once opened.
* e2e/agents-panel.spec.ts held only a SHOTS test of the strip in a thread's pane, which no
  longer exists there; it went. e2e/waiting-strip.spec.ts has the new shots.
