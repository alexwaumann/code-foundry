# A thread putting itself away

A user told a thread to archive itself and it ended up Interrupted. Now the thread's archive
or snooze of itself waits for the end of its turn.

## The cause, measured

Reproduced on real Claude before any change. The thread ran `thread archive --id <own id>`
from its Bash tool:

    :45.700  closing thread
    :45.733  CommandService/Invoke status=499     the CLI's request is gone
    :46.018  thread disconnected, exit_code=1

The close makes Claude kill the Bash call that asked, so the request ends about 30 ms in and
the process some 300 ms later. `Close` returned `ctx.Err()`, the archive failed, its guard was
cleared, and `detach` then published error "interrupted". The trace was right, with one thing
the fake hides: it exits at once, so `Close` wins that race and a test needs
`CF_FAKE_CLAUDE_EXIT_DELAY` to fail the way real Claude does.

Snooze had no guard at all, so any snooze that cut off a turn stayed "interrupted", including
one the user confirmed.

## What it does

`thread.archive` and `thread.snooze` (`--until`, `--save`) send `by_thread_id` from the CLI, as
`thread.interrupt` does. When that is the target, the store's `PutAwaySelf` asks the runner:

- Mid-turn, it records `record.putAway` and returns at once ("will archive ... when this turn
  ends"; `--json` has `deferred: true`). No confirmation, as the turn itself is not cut off; background agents and shells still running at turn end do stop, as agreed for an explicit request.
- Otherwise it is the plain call, as before, but on the store's context (below).

At a turn's end (`putAwayAtTurnEnd`, a `Result` that leaves Claude at its prompt) the runner
acknowledges the turn, begins the close, and a goroutine runs the plain `Archive`, `Snooze` or
`SaveForLater`. The end state is idle "at prompt", not "archived": nothing was cut off.

Pending put-aways are in memory only: a daemon restart loses the turn they wait for anyway.

Dropped, leaving the thread live and the status honest: a message or steer during the turn
(anyone's but a wake's), an interrupt, an unarchive, `snooze --clear`, a turn that ended
interrupted or failed, a snooze time that passed (logged), the process ending, a restart. A
second self-call replaces the first. An explicit archive or snooze from the user just happens,
and the close drops what was pending.

## Decisions worth keeping

**The runner decides whether a turn runs.** The published status lags by the debounce, so the
check goes through a `threadCmd`: it is ordered exactly against the stream's events.

**The close begins on the runner goroutine, at the result.** Not in the goroutine that follows.
Nothing is published first, so no "finished" can escape, and a message sent from then on finds
the process closing, waits, and starts it again. The put-away then fails ("was started while
being archived") and the user's message wins; that failure is only logged. The put-away carries
the process the turn's end closed and only ever waits for that one, before an archive's cascade:
a thread below it can hold the archive up for CloseTimeout, and a plain `Close` after that would
shut the process the user's message started. Known limits when the message wins: the wakes went
before the close, so the thread's subscriptions stay gone. And a turn that ends with a background
agent's prompt pending is not at its prompt, so the put-away waits for the next turn's end.

**Wakes go before the close, on the runner too.** `Archive` unwatches a thread only after its
cascade, which can wait out hidden threads for up to CloseTimeout, past the debounce that
publishes idle. A slow thread below is the case that shows it.

**`readStatus` holds the close's status during a put-away.** Claude does not always exit when
stdin closes: with a background agent or shell it stayed the full 10 s CloseTimeout, then took
SIGTERM (exit 143). A turn it starts in that window must not publish "finished".
`CF_FAKE_CLAUDE_CLOSE_TURN` plays one.

**The plain self path runs on `m.ctx`.** A background shell calling after the turn is closed by
the very close it asked for. Deferring cannot help there, so the request must not own the work.

**Hidden children still ask.** The confirmation is dropped for the thread's own turn only.
Archiving cascades, so a thread with hidden children still working gets the usual question:
those turns are cut off, deferred or not.

**The guard is general, and records whether it acted.** `record.away` holds the reason and
whether `detach` used it, so a failure falls back to "interrupted" only for a turn this very
close cut off, not for an idle "snoozed" an earlier snooze left. Idle "snoozed" renders like
"archived": the GUI shows any idle reason as the row's place.

**No guide line.** The guide is at its budget and the CLI's reply tells the agent what happens
at the moment it matters. Each description got one short clause; no skill needed a change.

## Not changed

- A self-call from a background shell after the turn is point 4's "as today", and shows a quirk
  that predates this: the finished turn hides under "waiting on 1 shell", the close removes that
  overlay, and raw "finished" shows, and counts as attention, until the archive lands, up to
  CloseTimeout later.
- A child archiving its creator is cut off by the cascade the same way as the old self-archive.
  The target is not the caller, so nothing defers.
- `thread.archive --ids` with the caller in the list defers it and says so; the list's other
  threads go at once.
