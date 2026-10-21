# Ember fixes 2: daemon wakes and restart (2026-10-21)

PR B of the Ember battle test round 2 (`/tmp/ember-r2/results/SYNTHESIS.md`). Findings:
e4-2 and e5-3 (crashed vs interrupted), e10-1 (restart notice for a cut turn), e10-2
(first prompt lost), e10-7 (reported, then stopped), e12-2 (archive's own settle wake),
e2-4 (sibling counts), e2-5 ("said more after its report"), e13-1 (timer turn while
waiting). Daemon (`internal/store/thread`), migration 0043, the GUI's status words, one
line of the orchestrate skill. Follows `orch-restart-wakes.md`, `orch-wakes-content.md`,
`orch-waiting-status.md`, `orch-child-context.md` and `ember-fixes-1-wakes.md`.

## Decisions

### Crashed, not interrupted (e4-2, e5-3)

* A busy thread whose process ends on its own (not a close, not the daemon's stop, not
  an effort restart) is error **`crashed`** (`ReasonCrashed`, the same word as the
  disconnect reason), not `interrupted`: `maybeExited` sets `runner.crashed` when it was
  mid-turn and had answered its handshake, and `disconnectedStatus` takes it. Any exit
  code counts, 0 included: no one asked it to stop. A process that ends at its prompt
  keeps its status as before; one that never answered its handshake is still "did not
  start".
* The wake: `Thread "X" (s-…) crashed: its process died (not stopped by anyone).` for
  every condition (`status_reason: "crashed"` in the JSON), then the report as usual.
* The resume note (`ResumeCrash`): `[code-foundry] Your previous turn ended because its
  process died (not stopped by anyone); your last tool call may have run partially, so
  check its effects before repeating it.`
* CLI: `error (crashed)` (the generic `status (reason)`, no code change; a test row).
  GUI: a `crashed` status kind and line ("Crashed while working · 2 min ago", red),
  folded into "error" by the lineage and Ember words like `interrupted`.
* `reference/wakes.md` (Interrupted): a `crashed` child is resumed without asking the
  user; check its worktree, `thread send`, ask only if it crashes again.
* `interruptedByStop` still means `interrupted` with a daemon disconnect reason; a crash
  is not a stop, so the restart engine does not treat it as one.

### The restart notice for a cut turn (e10-1)

* `planRestartWakes` takes a `restartInput`: the subscriptions, the live threads, the
  threads cut after their final report (below), and the live threads the stop cut
  (`interruptedByStop`). A cut thread gets a notice of its own (`selfOnly`) when no other
  plan covers it (it holds no subscription that fired), no subscription fires about it
  (whoever hears about it resumes it: a worker is its orchestrator's to resume, or it
  would get two "continue"s), and its first message went out (no `PendingFirst`).
* It is sent only when the cut turn was the user's: when the wake is sent, the
  thread's last top-level user message must not be a wake (`restartWakes.ownTurn`). A
  turn a wake started, with no subscription left to explain it, gets nothing.
* Every notice about a cut turn now quotes the message, 200 runes on one line:
  `The app restarted at 01:24 CDT; your own turn was interrupted while handling the
  user's message: "Add a streak freeze to the stats page".` JSON: `own_turn_message`. A
  thread with no subscriptions hears nothing about child threads (the sentence ends
  there). The wake carries the restart resume note like any message after the stop.
* "Nothing on the board came from it" (e10-1's text) is Ember's board, which the thread
  store does not see; left to the Ember PRs.
* This applies to any thread, not only residents: a user's own thread busy at an app
  update now resumes after the restart, its turn quoted back to it.

### The first message is persisted (e10-2)

* `threads.pending_first` (migration 0043, JSON: text, composer text, prompt,
  attachments, item id) is set by `Create` on the row before claude starts
  (`Thread.PendingFirst`, not on the API) and cleared once the message went out
  (`sendMessage`).
* Every spawn delivers a pending first message before anything else
  (`firstMessages`): the next send, wake or reconnect after a stop starts the thread and
  Claude gets the first message, then the one that started it. A message queued behind
  it records the first message's item id on the row, and a start for a message writes
  the first message's item before its own, so the timeline keeps the order and nothing
  is written twice.
* Only the daemon's stop or death keeps it: `shutdown` logs `first message not
  delivered: the daemon stopped; it goes at the next start` (WARN), `New` logs `… the
  daemon died …`. A start that failed or a close while starting clears it, as before
  (the prompt went with it).
* Such a thread gets no resume note (it never had a turn) and no notice of its own; its
  subscribers hear it was interrupted, and their send delivers its prompt first.

### Reported, then stopped (e10-7)

* A turn the stop cuts after the thread filed its final report (done, failed or
  blocked) at or after its last top-level user message (`reportCoversTurn`) ends needs
  attention `finished`, with no resume note: `shutdown` (`runner.reportedAtStop`) for a
  clean stop, `New` (`reportedAtLoad`, reading the items only when the report could
  qualify) for a daemon that died.
* A clean stop's settle is suppressed and the restart sends it (`Meets(settled)`): the
  subscriber reads `needs attention: finished. Report: done — …`, not "interrupted".
  After a death nothing was suppressed, so `New` hands the ids to the restart
  (`subscriptions.reportedAtStop`), and a subscription fires for them when they meet its
  condition and it has not fired since.

### Archive forgets its wakes first (e12-2)

* `archiveOne` calls `unwatchForArchiveLocked` before the close: the thread's
  subscriptions and those to it go (`forgetLocked`, held wakes included), and thread
  wakes about it queued for other subscribers are dropped (their wake limit slots
  refunded). The close's settle then fires nothing.
* A thread wake whose target is archived by the time it is sent is dropped
  (`archivedTargets`): the one a batch window already holds.
* The subscribers that waited on it are re-evaluated (waiting.go), and a drain that ends
  with nothing sent re-evaluates its subscriber: a thread waiting only on a dropped
  wake no longer stays "waiting" (the gotcha in `orch-waiting-status.md`).
* Dropped whatever the archiver: an orchestrator that archives its worker, or the user
  archiving it in the GUI. The finding's "word it as archived" option was not needed.

### Sibling counts are the current batch (e2-4)

* The siblings sentence and JSON count the subscriber's children in the current
  request: those working, those a wake is about, and those that settled after the
  subscriber's last top-level message from the user (not a wake; `requestStart`), by
  `LastActivityAt` or `CreatedAt`. A child that settled before that message belongs to
  an earlier request and is left out. No such message: every child, as before.
* So "All 3 of your child threads settled" after three requests of one worker each is
  now no sentence at all (an only child).

### "Said more after its report" (e2-5)

* Only when the ended turn, after the report, ran a tool call or wrote more than 300
  runes of assistant text (`maxClosingWords`), and its last text is after the report. A
  closing paragraph is the normal end of a turn and says nothing; `last_message` follows
  the same rule.

### A timer's turn needs attention (e13-1)

* `sendMessage` notes on the record whether the turn is a timer's (`noteTurnMessage`):
  a message that starts a turn sets it to whether it is a timer wake; one that joins a
  running turn can only set it. The waiting overlay leaves the unseen end of such a
  turn alone (`reminderShows`): needs attention `finished`, so the bell, badge and row
  say so while the thread still waits on children. Once seen ("at prompt") it waits
  again; the next turn the user or a child starts waits as before.
* No "reminder" reason: the GUI words and sort stay "Finished".

## Live evidence (2026-10-21, isolated home, Haiku 5.5 medium)

`make build`; `CODE_FOUNDRY_HOME=/tmp/ember-fix-b bin/code-foundry daemon --dev`, models
`claude-haiku-5-5[1m]` medium (naming too), scratch project `~/ember-fix-b-scratch/todo`
with a local bare origin. Home and scratch deleted afterwards; no ERROR lines in the
three daemon logs.

**Crash.** "Orchestrator" (s-8ac3315b5377, told to describe each wake and run nothing)
created "Sleeper" (`--created-by … --notify`), which ran a foreground
`python3 -c 'import time; time.sleep(240)'`. `kill -KILL` on Sleeper's claude:

```
thread disconnected thread=s-93b36f5c0965 reason=crashed exit_code=-1
woke thread thread=s-8ac3315b5377 wake="Thread \"Sleeper\" (s-93b36f5c0965) crashed: its process died (not stopped by anyone)."
```

`thread get` said `status: error (crashed), disconnected`; the wake's JSON had
`"status": "error", "status_reason": "crashed"`. A `thread send` to Sleeper carried
`[code-foundry] Your previous turn ended because its process died (not stopped by
anyone); your last tool call may have run partially, …`, and Haiku answered that the
sleep's outcome was unknown and the report not yet filed.

**Cut turn, no subscriptions.** "Lone" (no creator, no subscriptions) was asked to count
calc.py's lines after a 60 s foreground sleep; SIGTERM to the daemon during the sleep,
then a start:

```
restart wake queued thread=s-62a95fb065e7 interrupted=0 wakes=0 own_turn_interrupted=true subscriptions=0 own_turn_only=true
woke thread … wake="The app restarted at 09:39 CDT; your own turn was interrupted while handling the user's message: \"Count the lines of calc.py. …\""
```

The message carried the restart resume note; Lone said the run was cut by the restart,
reran the sleep and answered `2`. The Orchestrator and Sleeper, at their prompts, got
nothing.

**First prompt.** The Orchestrator's child "Quick" (`--notify`) was created and the
daemon got SIGTERM 6 ms after its spawn:

```
thread spawned thread=s-1126b1995809 pid=35674
WARN first message not delivered: the daemon stopped; it goes at the next start thread=s-1126b1995809
```

The row had `pending_first` set, status error "interrupted", no resume note. After the
start the Orchestrator got `The app restarted at 09:40 CDT; 1 of your child threads was
interrupted: "Quick" (…); its session resumes on your next send.` A `thread send
"the app restarted; continue"` (what an orchestrator does) started Quick: its timeline
reads `#2 you: Reply with the number of lines in README.md …`, then the send, and Claude
counted 3 lines and reported done; `pending_first` was cleared.

## Gotchas

* The thread package's fake claude answers the handshake at once; the first-message
  tests hold it with `CF_FAKE_CLAUDE_INIT_GATE`. A thread that is "busy" may not have
  sent its first message yet (spawn says busy before the handshake): tests that need
  the message in the timeline wait for `StateConnected`.
* With a batch window the send-time filter alone hid the archive bug in a test; the
  test runs without batching too, where the close's own fire would go at once.
* Migration 0043 may collide with PR A (ember tasks' branch column); the one that
  merges second renumbers.
