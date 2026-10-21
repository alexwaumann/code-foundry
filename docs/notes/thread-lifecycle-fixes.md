# Thread lifecycle fixes (fuzz pass, 2026-10-21)

Fixes from the thread-lifecycle fuzz report (findings 1, 2, 3, 4, 5, 8) and the API
report's WatchThread finding. Each was reproduced first, with a fake `claude` (the
package's `cmd/fakeclaude`, or a wrapper script on a scratch daemon's PATH), then fixed
with a regression test.

## What changed

* **A failed start keeps the new thread's first prompt.** `spawn` records the first
  prompt's user item before the runner starts (after the row is committed: items
  reference the threads table), so `recordUser` sets `itemID` and `sendMessage` delivers
  it under that id. A claude that exits at once or never answers `initialize` now leaves
  "you: <prompt>", the error, and the daemon's turn end, as a message to a stopped
  thread already did. Test: `TestCreateStartFailureKeepsThePrompt`.
* **Removing a thread hands its children to the user** (`orphans.go`). `Remove` sets the
  sidebar override on each child that is not archived (nothing is stopped); `New` does
  the same at load for any thread whose creator is gone (data from before this, or a
  crash between the delete and the children's commit). `thread.remove`'s confirmation
  names the hidden children still working ("they keep running and are shown in the
  sidebar"), from the same `archive_cascade_of` list archive uses, direct children only.
* **WatchThread ends when its thread is removed.** It also follows `thread.Event` and,
  on `Removed` for its id (or a missed event and the thread gone), ends with the store's
  NOT_FOUND (the tombstone's when kept). The GUI's `runStream` treats NOT_FOUND as
  permanent: the watch stops and frees its stream slot. No GUI change was needed.
* **Control calls a caller waits on are bounded.** Interrupt, SetModel and
  SetPermissionMode give Claude `Options.ControlTimeout` (10s); MCP reconnect 60s (Claude
  restarts the server first). Past it the error is a `*NoAnswerError` ("Claude did not
  answer the interrupt within 10s; close or restart the thread"), a
  `context.DeadlineExceeded`, so the API says DEADLINE_EXCEEDED and the CLI prints no
  usage hint.
* **A Claude that stops reading stdin no longer freezes its runner.**
  * `Conn.write` sets a write deadline on the pipe (exec's `StdinPipe` is an `*os.File`
    in the poller, so `SetWriteDeadline` works): the ctx deadline, or `WriteTimeout`
    (30s) without one. Past it: `ErrStalled`; when part of the line went out, stdin is
    closed (anything after half a line would not parse). Writers without deadlines
    (`io.Pipe` in tests) block as before.
  * `CloseStdin` no longer takes the write mutex (an atomic flag): closing the pipe ends
    a write stuck in it.
  * The runner's send gets `Options.SendTimeout` (30s, up from an ignored 5s: a large
    inline image must still fit). A stalled send fails ("Claude stopped reading its
    input; the message was not delivered and the thread is closing"), adds that line to
    the timeline and requests a close, so SIGTERM and SIGKILL follow.
  * `Manager.Shutdown` kills the process group of any runner still going when its ctx
    ends (`runner.kill`), so claude never outlives the daemon.
* **Wakes back off after a failed start** (`wakebackoff.go`). The record counts failed
  starts in a row (a runner that never initialized, or a start that failed before
  spawning with a message); a start that comes up clears it. While the count is set,
  the subscriber's drain waits: `WakeStartBackoff` (1m) doubled per failure up to an
  hour, measured from the last failure, and also while a retry start is still under way
  (otherwise the next wake would queue behind that handshake and fail with it). A held
  queue keeps one plain wake per subscription (the latest replaces the one waiting);
  thread wakes batch as before. A user's message always tries. The count is in memory:
  a daemon restart tries again at once.
* **Archive closes a cascade's hidden threads together.** What each was (interrupted or
  not) is read first, every close is requested, then each is archived in tree order as
  before. Four stuck children archive in one close timeout, not four.

## Decisions

* **No GUI `inSidebar` change.** The report suggested treating a thread whose creator
  is unknown as shown in both `InSidebar` implementations. The daemon now guarantees the
  override on every such thread (at removal and at load), so both implementations stay
  thread-local and agree; a GUI rule keyed on "creator not in my list" would need the
  whole thread map at every call site and misfire on a partial list.
* **Children of a removed thread are promoted, not archived.** Promoting stops nothing;
  archived children stay archived (no flood in the Archived panel); grandchildren keep
  their (still existing) creator and are reached through it.
* **The synthetic turn end after a failed start stays.** The report's minimal fix was to
  drop it for a process that never initialized, but thread-fold-1-daemon.md decided a
  failed start is a turn (message + error) the GUI must be able to close and fold. With
  the backoff the volume problem is gone.
* **One attention.** A failed start already leaves status error "did not start"; the
  backoff stops the busy → error flips each wake caused, so no extra item or status.
* **Coalescing replaces in place.** A timer's newer fire supersedes the waiting one. A
  PR or plugin wake replaced while held loses the older change list; acceptable during
  an outage (the agent can read the PR), and only while Claude cannot start.

## Gotchas

* `Conn.Send` used to ignore its ctx, so the runner's 5s "timeout" never applied; now
  that it does, the send budget had to grow (30s) to keep big attachments working.
* A stalled write that wrote nothing keeps stdin open (`ErrStalled` again next time);
  one that wrote part of a line closes it (`ErrClosed` next time).
* The fake claude gained `CF_FAKE_CLAUDE_STALL`: the first message's turn starts (all
  lines but the result), then it stops reading stdin and ignores SIGTERM.
