# A setup stage ends with the commit that says so (2026-11-19)

`TestCleanupKeepsAWorktreeAnotherThreadHolds/discard` failed once in a worker's `make check`
and passed on the re-run. It was a real store race, not only a test one.

## What raced

A background setup's goroutine (`finishSetup`) published the stopped phase (`failSetup`,
`endCancelled`) in one commit and forgot the stage (`rec.setup = nil`, a deferred
`clearSetup`) only as it returned. Between the two, `DiscardSetup` answered "only a failed
or cancelled setup can be discarded; thread … has none" and `RetrySetup` "is still being set
up", to a caller that had just been shown the failure. The test's `finish` helper waits for
`SetupFailed` and discards at once, which is exactly what an agent watching the thread does.
On a loaded machine the goroutine was descheduled inside the window.

Reproduced with the `-race` test binary, 24 copies side by side, 40 runs each: 2 of 24
processes failed before, 0 of 24 after.

## Fix

- `failSetup` and `endCancelled` forget the stage in the commit that publishes the phase.
  Nothing the goroutine does afterwards touches the thread (it cancels its own context and
  closes `done`).
- `clearSetup` takes the job and forgets it only while it is still the record's: a retry
  may register the next stage before the ended one's goroutine returns, and the old
  `clearSetup(id)` would then have forgotten the new one.
- `CancelSetup` and `endSetup` hold the job itself and wait on its `done`, so they are
  unchanged.

`TestSetupThatEndedIsForgottenWithItsPhase` pins both halves without timing: it ends a
stage whose goroutine is still held in `CreateWorktree`.

## Looked into beside it: "Thread Info popover opening on selection"

Reported from a headless drive of the browser dev build. Not reproduced as a defect. The
overlay (`thread-info-overlay`) opens only from `toggleThreadInfo` (the header button, the
chord, the CLI's ShowView); selecting threads at 1280, 1000 and 800 px wide never opened it.
What shows at the top right of a thread on selection at 1280 px is the inline card, on by
default (`layout.thread_info`), which is drawn as a floating box and reads as a popover in a
screenshot.
